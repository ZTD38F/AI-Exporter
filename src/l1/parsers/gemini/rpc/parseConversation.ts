import { GeminiResponseEnvelope } from './responseEnvelope.js';
import { hideGeminiFileCitations } from '../shared/fileCitations.js';
import type { GeminiAttachmentEvidence } from './detailEvidence.js';
import { closeGeminiCodeCitations } from '../shared/codeCitations.js';
import type { GeminiStructuredNode } from './structuredContent.js';
import { contentQuality } from '../../qualityEvidence.js';
import { parseIndexMetadata } from '../../shared/parseIndexMetadata.js';
import { normId } from '../../../../shared/utils/pathUtils.js';
import { decodeGeminiDetail } from './detailDecoder.js';
import type { GeminiDetailDebugEvidence, GeminiMessageEvidence, GeminiDetailEvidence } from './detailEvidence.js';
import type { DomainCitation, DomainMessage } from '../../../../l2/conversationDetail.js';
import type { ConversationParseContext } from '../../contracts.js';
import type { Diagnostic } from '../../../../shared/diagnostics/diagnostic.js';
import { closeSourceCitations } from '../../shared/resources/domainCitationAdapter.js';
import { closeDomainResources } from '../../shared/resources/domainResourceAdapter.js';
import { parseGeminiBody, parseGeminiPrompt, parseSourceReasoning, structuredBodyAttachments } from '../shared/contentAdapter.js';
import type { SourceConversationParseResult } from '../../parsingResult.js';

export interface GeminiRpcParseContext extends ConversationParseContext {
    targetConvId?: string;
    /** Differential audits select a body branch without dropping shared source metadata. */
    bodyRepresentation?: 'structured' | 'markdown';
}

export interface GeminiRpcParseResult extends SourceConversationParseResult {
    /** Pagination and wire/debug evidence are acquisition context, never Domain fields. */
    transport: {
        nextPageToken: string | null;
        bodyShape?: GeminiDetailEvidence['bodyShape'];
        /** Opaque replay evidence for offline differential audits only. */
        decodedPayload?: unknown;
        debug?: GeminiDetailDebugEvidence | null;
    };
}

function citationsOf(message: GeminiMessageEvidence): { citations: DomainCitation[]; legacyCitations: DomainCitation[]; sourceCitations: Map<string, DomainCitation[]> } {
    const citations: DomainCitation[] = [];
    const byUrl = new Map<string, DomainCitation>();
    const addSource = (source: { url: string; title?: string }): DomainCitation => {
        const existing = byUrl.get(source.url);
        if (existing) return existing;
        const citation = { id: `citation-${byUrl.size}`, url: source.url, ...(source.title !== undefined ? { title: source.title } : {}) };
        byUrl.set(source.url, citation);
        citations.push(citation);
        return citation;
    };
    for (const source of message.citations ?? []) if (source.url?.trim()) addSource(source);
    const legacyCitations = [...citations];
    const sourceCitations = new Map<string, DomainCitation[]>();
    for (const attribution of message.sourceAttributions ?? []) {
        sourceCitations.set(attribution.sourceId, attribution.sources.map(addSource));
    }
    const files = new Map<number, Set<string>>();
    const visit = (nodes: GeminiStructuredNode[]): void => {
        for (const node of nodes) {
            if (node.nodeType === 'citation') {
                const titles = files.get(node.number) ?? new Set<string>();
                titles.add(node.title);
                files.set(node.number, titles);
            } else if ('children' in node) visit(node.children);
            else if ('items' in node) node.items.forEach(item => visit(item.children));
            else if ('rows' in node) node.rows.forEach(row => row.cells.forEach(cell => visit(cell.children)));
        }
    };
    if (message.structuredContent) visit(message.structuredContent.children);
    for (const [number, titles] of files) {
        const citation = { id: `grounding-${number}`, title: [...titles].join('; ') };
        citations.push(citation);
        sourceCitations.set(citation.id, [citation]);
    }
    return { citations, legacyCitations, sourceCitations };
}

/** Raw Gemini detail RPC -> keyless source facts. */
export function parseGeminiRpcConversation(text: string | GeminiResponseEnvelope, context: GeminiRpcParseContext): GeminiRpcParseResult {
    if (context.providerId !== 'gemini') throw new TypeError('Gemini RPC parser requires providerId gemini');
    if (typeof text !== 'string' && !(text instanceof GeminiResponseEnvelope)) throw new TypeError('Gemini RPC input must be raw response text or a decoded response envelope');
    const evidence = decodeGeminiDetail(text, context.targetConvId);
    return parseGeminiDetailEvidence(evidence, context);
}

/** Adapt decoded native source evidence; also used by offline Gemini differential audits. */
export function parseGeminiDetailEvidence(evidence: GeminiDetailEvidence, context: GeminiRpcParseContext): GeminiRpcParseResult {
    if (context.providerId !== 'gemini') throw new TypeError('Gemini evidence adapter requires providerId gemini');
    const contentDiagnostics: Diagnostic[] = [];
    const messages: DomainMessage[] = evidence.messages.map((message, index) => {
        const sourceRef = { providerId: 'gemini', providerMessageId: message.id, locator: `messages[${index}]` };
        const extraction = message.structuredExtraction;
        if (extraction && extraction.status !== 'decoded') contentDiagnostics.push({
            severity: extraction.status === 'decode_rejected' ? 'warning' : 'info',
            code: 'GEMINI_STRUCTURED_FALLBACK',
            message: 'Native structured body unavailable; using Markdown fallback',
            sourceRef,
            details: { reason: extraction.status, ...(extraction.status === 'decode_rejected' ? {
                issue: { ...extraction.issue }, rawDocument: extraction.rawDocument,
                documentSource: 'turn[3][12]', candidateIndex: 0, fallbackMarkdown: message.content,
            } : {}) },
        });
        const reasoning = parseSourceReasoning(message.thoughts, { diagnostics: contentDiagnostics, sourceRef });
        const { citations, legacyCitations, sourceCitations } = citationsOf(message);
        const closed = closeSourceCitations({
            ...(message.id.trim() ? { id: message.id } : {}),
            role: message.role === 'model' ? 'assistant' : 'user',
            content: message.role === 'user' ? parseGeminiPrompt(message.content)
                : parseGeminiBody(message.content, context.bodyRepresentation === 'markdown' ? undefined : message.structuredContent,
                    { diagnostics: contentDiagnostics, sourceRef, sourceCitations, recoverLiteralMath: context.bodyRepresentation !== 'structured' }),
            ...(message.timestamp !== null && Number.isFinite(message.timestamp) ? { timestamp: message.timestamp } : {}),
            ...(message.model ? { model: message.model } : {}),
            ...(reasoning !== undefined ? { reasoning } : {}),
            ...(legacyCitations.length ? { citations: legacyCitations } : {}),
        }, message.groundingCitationMarkers);
        if (message.role === 'model') {
            const fileIds = new Set(citations.filter(citation => citation.id.startsWith('grounding-') && citation.title && !citation.url).map(citation => citation.id));
            hideGeminiFileCitations(closed.content, fileIds);
            if (closed.reasoning) hideGeminiFileCitations(closed.reasoning, fileIds);
            closeGeminiCodeCitations(closed.content, message.groundingCitationMarkers);
            if (closed.reasoning) closeGeminiCodeCitations(closed.reasoning, message.groundingCitationMarkers);
        }
        // Newly bound native sources are not evidence that literal [1] prose is a citation.
        const allCitations = [...citations, ...(closed.citations ?? []).filter(item => !citations.some(c => c.id === item.id))];
        return { ...closed, ...(allCitations.length ? { citations: allCitations } : {}) };
    });
    const resources = closeDomainResources('gemini', messages, evidence.messages.map(message => {
        // These resources were explicitly extracted from this turn; preserve its original token.
        const sourceGeneration = <T extends GeminiAttachmentEvidence | NonNullable<GeminiMessageEvidence['images']>[number]>(asset: T): T =>
            asset.isGenerated && message.rawProviderRequestId ? { ...asset, providerRequestId: message.rawProviderRequestId,
                ...(asset.generation ? { generation: { ...asset.generation, providerRequestId: message.rawProviderRequestId } } : {}) } : asset;
        return { input: { ...message, images: message.images?.map(sourceGeneration), attachments: message.attachments?.map(sourceGeneration) }, bodyAttachments: structuredBodyAttachments(message) };
    }), { sourceReferences: true });
    const hasMore = Boolean(evidence.nextPageToken?.trim());
    const rejected = (evidence.turnsRejected ?? 0) > 0;
    const updatedAt = evidence.updatedAt;
    // Gemini may retain the last answer version while later user turns have empty answers.
    // Message dates are activity facts, not evidence that pagination lost content.
    const newerMessages = messages.flatMap(message => {
        const timestamp = message.timestamp;
        return updatedAt !== null && timestamp !== undefined && timestamp > updatedAt
            ? [{ id: message.id ?? null, role: message.role, timestamp }] : [];
    });
    const metadata = evidence.metadataConversation;
    const conversation = {
        index: parseIndexMetadata({ providerId: 'gemini',
            id: normId(metadata?.id ?? evidence.id), title: metadata?.title ?? evidence.title,
            titleSource: metadata ? 'rpc' : evidence.titleSource,
            url: metadata ? `https://gemini.google.com/app/${metadata.id.replace(/^c_/, '')}` : evidence.url,
            ...(updatedAt !== null ? { updatedAt } : {}), messageCount: resources.messages.length }),
        detail: { ...(updatedAt !== null ? { savedAt: updatedAt } : {}), quality: contentQuality({ status: evidence.turnsRecovered ? 'partial' : 'unknown', rejectedTurns: evidence.turnsRejected,
            ...(hasMore ? { truncation: 'pagination_pending' } : {}), heuristicDocumentIds: resources.heuristicDocumentIds }),
            assets: resources.assets, messages: resources.messages },
    };
    const diagnostics: Diagnostic[] = (evidence.schemaDrift ?? []).map(message => ({ severity: 'warning', code: 'GEMINI_SCHEMA_DRIFT', message }));
    if (rejected) diagnostics.push({ severity: 'warning', code: 'GEMINI_TURNS_REJECTED', message: `Discarded ${evidence.turnsRejected} undecodable source turns` });
    if (evidence.turnsRecovered) diagnostics.push({ severity: 'warning', code: 'GEMINI_TURNS_RECOVERED', message: `Recovered ${evidence.turnsRecovered} structurally unrecognized source turns` });
    if (newerMessages.length) diagnostics.push({ severity: 'info', code: 'CONVERSATION_VERSION_MISMATCH', message: 'Detail contains activity newer than its metadata version',
        details: { sourceVersion: updatedAt, newerMessages } });
    diagnostics.push(...contentDiagnostics);
    return {
        evidence: { rejectedTurns: evidence.turnsRejected, ...(hasMore ? { truncation: 'pagination_pending' } : {}), heuristicDocumentIds: resources.heuristicDocumentIds },
        ...(updatedAt !== null ? { sourceVersion: updatedAt } : {}),
        conversationId: normId(evidence.id), conversation, acquisitionHints: resources.acquisitionHints,
        diagnostics,
        transport: {
            nextPageToken: evidence.nextPageToken,
            bodyShape: evidence.bodyShape,
            ...(evidence._raw !== undefined ? { decodedPayload: evidence._raw } : {}),
            ...(evidence._debug !== undefined ? { debug: evidence._debug } : {}),
        },
    };
}
