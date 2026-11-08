import { compatibleGrokBodies, type GrokWireResponse } from './wireCompatibility.js';
import { preprocessGrokMarkdown } from './markdownCompatibility.js';
import { extractGrokData } from './vendor/loominary/grokParser.js';
import { normalizeGrokResponses } from './vendor/loominary/normalizeResponses.js';
import { grokResources } from './adaptResources.js';
import type { ResourceAcquisitionHint } from '../../resources/resourceAcquisition.js';
import type { DomainAsset, DomainMessage } from '../../../l2/conversationDetail.js';
import type { Diagnostic } from '../../../shared/diagnostics/diagnostic.js';
import type { SourceConversationParseResult } from '../parsingResult.js';
import { parseMarkdownToBlocks } from '../shared/markdown/index.js';
import { parseIndexMetadata } from '../shared/parseIndexMetadata.js';
import { grokObject, grokTimestamp, grokUuid } from './source.js';

/** A response-node snapshot owns the exact message set. Never infer completeness from message count. */
export function parseGrokConversation(metadata: unknown, tree: unknown, bodies: unknown, requestedId: string): SourceConversationParseResult {
    const meta = grokObject(grokObject(metadata).conversation), graph = grokObject(tree), payload = grokObject(bodies);
    if (!grokUuid(requestedId) || meta.conversationId !== requestedId) throw new TypeError('Grok detail identity mismatch');
    if (!Array.isArray(graph.responseNodes) || !Array.isArray(payload.responses)) throw new TypeError('Invalid Grok response snapshot');
    const nodes = new Map<string, { parentResponseId: string | null | undefined; sender: unknown }>(),
        responses = new Map<string, GrokWireResponse>();
    for (const value of graph.responseNodes) {
        const node = grokObject(value), parentResponseId = node.parentResponseId;
        if (!grokUuid(node.responseId) || nodes.has(node.responseId)
            || (parentResponseId != null && !grokUuid(parentResponseId))) throw new TypeError('Invalid Grok response tree');
        nodes.set(node.responseId, { parentResponseId, sender: node.sender });
    }
    for (const value of payload.responses) {
        const response = grokObject(value), id = response.responseId;
        if (!grokUuid(id) || responses.has(id) || !nodes.has(id)) throw new TypeError('Unexpected Grok response body');
        if (response.parentResponseId !== nodes.get(id)?.parentResponseId
            || response.sender !== nodes.get(id)?.sender) throw new TypeError('Grok response binding mismatch');
        const message = response.message;
        if ((response.sender === 'human' || response.sender === 'assistant') && typeof message !== 'string')
            throw new TypeError('Missing Grok message text');
        // Unsupported senders are skipped; never pass their invalid text to Loominary.
        responses.set(id, { ...response, responseId: id, message: typeof message === 'string' ? message : '' });
    }
    const parents = new Set([...nodes.values()].map(node => node.parentResponseId));
    const leaves = [...nodes.keys()].filter(id => !parents.has(id));
    const diagnostics: Diagnostic[] = [];
    const sourceRef = { providerId: 'grok', locator: 'conversation:' + requestedId };
    let partial = responses.size !== nodes.size || !Array.isArray(graph.inflightResponses) || graph.inflightResponses.length > 0;
    const warn = (code: string, message: string) => { partial = true; diagnostics.push({ severity: 'warning', code, message, sourceRef }); };
    // Multiple leaves have no authoritative selected branch in this endpoint.
    if (leaves.length !== 1) warn('grok.branch.ambiguous', 'Grok selected branch unavailable; all source responses retained');
    let ordered = [...nodes.keys()];
    if (leaves.length === 1) {
        const visited = new Set<string>(), branch: string[] = [];
        let id = leaves[0];
        for (let node = nodes.get(id); node; node = nodes.get(id)) {
            if (visited.has(id)) throw new TypeError('Cyclic Grok response tree');
            visited.add(id); branch.push(id); id = String(node.parentResponseId);
        }
        if (id !== 'undefined' && id !== 'null' && id[14] !== '5') warn('grok.branch.missing_parent', 'Grok root parent is not the observed synthetic root');
        if (visited.size !== nodes.size) warn('grok.branch.disconnected', 'Grok response tree has disconnected messages');
        else ordered = branch.reverse();
    }
    // Upstream owns citation-card conversion, attachment schemas and display text.
    // Clone because its normalizer sorts source responses in place.
    const compatible = compatibleGrokBodies({ ...payload, responses: [...responses.values()] }, warn);
    // Normalize source TeX before upstream inserts escaped Markdown citation titles.
    const modelsById = new Map<string, string>();
    for (const row of compatible.responses) {
        row.message = preprocessGrokMarkdown(row.message);
        if (typeof row.model === 'string' && row.model) modelsById.set(row.responseId, row.model);
    }
    const normalized: unknown = normalizeGrokResponses(structuredClone(graph.responseNodes), compatible);
    if (!Array.isArray(normalized)) throw new TypeError('Invalid upstream Grok normalization');
    const upstream: unknown = extractGrokData({ conversationId: requestedId, title: meta.title,
        exportTime: meta.modifyTime, responses: normalized });
    const history = grokObject(upstream).chat_history;
    if (!Array.isArray(history)) throw new TypeError('Invalid Loominary Grok output');
    const parsedById = new Map(history.map(value => {
        const row = grokObject(value);
        if (!grokUuid(row.uuid)) throw new TypeError('Invalid Loominary Grok message ID');
        return [row.uuid, row] as const;
    }));
    const assets: DomainAsset[] = [], acquisitionHints: Record<string, ResourceAcquisitionHint> = {};
    const resources = grokResources(assets, acquisitionHints, warn);
    const messages: DomainMessage[] = [];
    for (const id of ordered) {
        const response = responses.get(id);
        if (!response) { warn('grok.response.missing', 'A source response body is unavailable'); continue; }
        if (response.sender !== 'human' && response.sender !== 'assistant') { warn('grok.sender.unsupported', 'Unsupported Grok response sender'); continue; }
        if (response.partial === true || Array.isArray(response.streamErrors) && response.streamErrors.length) warn('grok.response.partial', 'Grok response incomplete');
        // Preserve unsupported source facts explicitly rather than silently advertising a full export.
        for (const field of ['toolResponses', 'citedXposts', 'inputChunks', 'outputChunks']) {
            if (Array.isArray(response[field]) && response[field].length) warn('grok.' + field + '.unsupported', 'Grok ' + field + ' is not yet supported');
        }
        const adapted = parsedById.get(id);
        if (!adapted || typeof adapted.display_text !== 'string') throw new TypeError('Missing upstream Grok message');
        const owned = resources.blocks(adapted, id);
        if (Array.isArray(response.generatedImageUrls) && response.generatedImageUrls.length && !owned.attachmentIds.length)
            warn('grok.generated_image.unavailable', 'Generated Grok image was not available in the source snapshot');
        const citations = Array.isArray(adapted.citations) ? adapted.citations.map((value, index) => {
            const citation = grokObject(value);
            return { id: 'grok-citation:' + index,
                ...(typeof citation.url === 'string' ? { url: citation.url } : {}),
                ...(typeof citation.title === 'string' ? { title: citation.title } : {}) };
        }) : [];
        if (response.message.includes('<grok:render') && !citations.length && !owned.attachmentIds.length)
            warn('grok.citation.unresolved', 'A Grok inline card has no resolved source');
        const ctx = { diagnostics, sourceRef: { ...sourceRef, providerMessageId: id },
            resolveImage: (ref: string, alt: string) => resources.image(ref, alt, id) };
        const markdown = adapted.display_text;
        const timestamp = grokTimestamp(response.createTime);
        const model = modelsById.get(id);
        const reasoning = Array.isArray(response.steps) ? response.steps.flatMap(value => {
            const step = grokObject(value);
            return Array.isArray(step.text) ? step.text.filter((text): text is string => typeof text === 'string').flatMap(text => parseMarkdownToBlocks(text, id, ctx)) : [];
        }) : [];
        messages.push({ id, role: response.sender === 'human' ? 'user' : 'assistant',
            content: parseMarkdownToBlocks(markdown, id, ctx),
            ...(owned.attachmentIds.length ? { attachmentIds: owned.attachmentIds } : {}),
            ...(citations.length ? { citations } : {}), ...(reasoning.length ? { reasoning } : {}),
            ...(timestamp !== undefined ? { timestamp } : {}),
            ...(model ? { model } : {}) });
    }
    const updatedAt = grokTimestamp(meta.modifyTime), createdAt = grokTimestamp(meta.createTime);
    return { conversationId: requestedId, ...(updatedAt !== undefined ? { sourceVersion: updatedAt } : {}),
        conversation: { index: parseIndexMetadata({ providerId: 'grok', id: requestedId,
            title: typeof meta.title === 'string' ? meta.title : undefined, titleSource: 'provider', createdAt, updatedAt }),
            detail: { ...(updatedAt !== undefined ? { savedAt: updatedAt } : {}),
                quality: { status: messages.length ? partial ? 'partial' : 'complete' : 'unknown' }, assets, messages } },
        diagnostics, acquisitionHints };
}
