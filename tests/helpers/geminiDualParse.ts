import { fixtureAccount } from './domainFixture.js';
/** Test-only differential audit. Never imported into the extension. */
import type { BlockNode } from '../../src/l2/content/blocks.js';
import type { InlineNode } from '../../src/l2/content/inline.js';
import type { DomainAsset, DomainMessage } from '../../src/l2/conversationDetail.js';
import type { GeminiDetailEvidence } from '../../src/l1/parsers/gemini/rpc/detailEvidence.js';
import { decodeGeminiDetail } from '../../src/l1/parsers/gemini/rpc/detailDecoder.js';
import { parseGeminiDetailEvidence } from '../../src/l1/parsers/gemini/rpc/parseConversation.js';

type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
interface Difference { path: string; structured?: Value; markdown?: Value }
interface MessageAudit {
    index: number; id?: string;
    status: 'match' | 'different' | 'structured_unavailable';
    reason?: unknown;
    rawMarkdown: string;
    nativeDocument?: unknown;
    structured: DomainMessage | null;
    markdown: DomainMessage;
    canonicalStructured: Value | null;
    canonicalMarkdown: Value;
    differences: Difference[];
    semanticDifferences: Difference[];
    classification: 'match' | 'content_or_metadata' | 'structure_or_format' | 'unavailable';
}

const lineEndings = (s: string): string => s.replace(/\r\n?/g, '\n');
const prose = (s: string): string => lineEndings(s).replace(/[\t\n ]+/g, ' ');

/** Only transport line endings and prose whitespace are normalized. Code and TeX stay literal. */
export function canonicalMessage(message: DomainMessage, assets: DomainAsset[]): Value {
    const asset = (id: string): Value => {
        const found = assets.find(a => a.id === id);
        if (!found) return { unresolved: id };
        const { id: _id, ...semantic } = found;
        return JSON.parse(JSON.stringify(semantic)) as Value;
    };
    const inline = (nodes: InlineNode[]): Value[] => {
        const result: Value[] = [];
        for (const node of nodes) {
            if (node.type === 'text' || (node.type === 'lineBreak' && node.kind === 'soft')) {
                const text = node.type === 'text' ? prose(node.text) : ' ';
                const previous = result.at(-1);
                if (previous && typeof previous === 'object' && !Array.isArray(previous) && previous.type === 'text') {
                    previous.text = prose(String(previous.text) + text);
                } else result.push({ type: 'text', text });
            } else if (node.type === 'inlineCode') result.push({ type: node.type, code: lineEndings(node.code) });
            else if (node.type === 'inlineMath') result.push({ type: node.type, source: lineEndings(node.source) });
            else if (node.type === 'image') result.push({ type: node.type, asset: asset(node.assetId), alt: node.alt ?? '', title: node.title ?? '' });
            else if (node.type === 'citationRef') {
                const citation = message.citations?.find(c => c.id === node.citationId);
                result.push({ type: node.type, source: citation ? { url: citation.url ?? '', title: citation.title ?? '' } : { unresolved: node.citationId }, label: node.label ?? '' });
            } else if (node.type === 'lineBreak') result.push({ type: node.type, kind: node.kind });
            else result.push({ type: node.type, ...('href' in node ? { href: node.href, title: node.title ?? '' } : {}), children: inline(node.children) });
        }
        return result;
    };
    const blocks = (nodes: BlockNode[]): Value[] => nodes.map((node): Value => {
        if (node.type === 'paragraph' || node.type === 'heading') return { type: node.type, ...('level' in node ? { level: node.level } : {}), children: inline(node.children) };
        if (node.type === 'list') return { type: node.type, ordered: node.ordered, ...(node.ordered ? { start: node.start ?? 1 } : {}), items: node.items.map(item => blocks(item.blocks)) };
        if (node.type === 'quote') return { type: node.type, blocks: blocks(node.blocks) };
        if (node.type === 'code') return { type: node.type, code: lineEndings(node.code), language: node.language ?? '', meta: node.meta ?? '' };
        if (node.type === 'math') return { type: node.type, source: lineEndings(node.source) };
        if (node.type === 'table') {
            const rows = (items: typeof node.rows): Value[] => items.map(row => row.cells.map(cell => ({ children: inline(cell.children), colSpan: cell.colSpan ?? 1, rowSpan: cell.rowSpan ?? 1 })));
            return { type: node.type, caption: inline(node.caption ?? []), columns: (node.columns ?? []).map(c => c.align ?? null), headerRows: rows(node.headerRows ?? []), rows: rows(node.rows) };
        }
        if (node.type === 'image') return { type: node.type, asset: asset(node.assetId), alt: node.alt ?? '', caption: inline(node.caption ?? []) };
        if (node.type === 'file') return { type: node.type, asset: asset(node.assetId), label: node.label ?? '', description: inline(node.description ?? []) };
        if (node.type === 'unknown') return { type: node.type, sourceType: node.sourceType, text: lineEndings(node.text) };
        return { type: node.type };
    });
    return { content: blocks(message.content), attachments: (message.attachmentIds ?? []).map(asset) };
}

/** A second view removes presentation wrappers while retaining ordered authored content.
 * Full tree differences are still reported, even when this view agrees. */
export function semanticContent(canonical: Value): Value {
    const record = (value: Value): { [key: string]: Value } => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid canonical node');
        return value;
    };
    const sequence = (nodes: Value[]): Value[] => {
        const output: Value[] = [];
        const text = (value: string): void => {
            const previous = output.at(-1);
            if (previous && typeof previous === 'object' && !Array.isArray(previous) && previous.type === 'text') previous.text = prose(String(previous.text) + value);
            else output.push({ type: 'text', text: prose(value) });
        };
        const visit = (values: Value[]): void => values.forEach(value => {
            const node = record(value);
            if (node.type === 'text') text(String(node.text));
            else if (['strong', 'emphasis', 'strikethrough'].includes(String(node.type))) visit(node.children as Value[]);
            else if (node.type === 'paragraph' || node.type === 'heading') { visit(node.children as Value[]); text(' '); }
            else if (node.type === 'list') (node.items as Value[][]).forEach(visit);
            else if (node.type === 'quote') visit(node.blocks as Value[]);
            else if (node.type === 'thematicBreak') text(' ');
            else if (node.type === 'math' || node.type === 'inlineMath') output.push({ type: 'math', source: node.source });
            else if (node.type === 'table') {
                const rows = (items: Value[]): Value[] => items.map(row => (row as Value[]).map(cell => {
                    const c = record(cell); return { ...c, children: sequence(c.children as Value[]) };
                }));
                output.push({ type: node.type, caption: sequence(node.caption as Value[]), headerRows: rows(node.headerRows as Value[]), rows: rows(node.rows as Value[]) });
            } else if (node.type === 'link') output.push({ ...node, children: sequence(node.children as Value[]) });
            else output.push(node);
        });
        visit(nodes);
        return output.map(item => {
            if (item && typeof item === 'object' && !Array.isArray(item) && item.type === 'text') return { type: 'text', text: String(item.text).trim() };
            return item;
        }).filter(item => !(item && typeof item === 'object' && !Array.isArray(item) && item.type === 'text' && item.text === ''));
    };
    const message = record(canonical);
    return { content: sequence(message.content as Value[]), attachments: message.attachments };
}

/** Preserve every difference and both complete trees; no fuzzy similarity threshold or allowlist. */
export function differences(left: Value | undefined, right: Value | undefined, path = '$'): Difference[] {
    if (JSON.stringify(left) === JSON.stringify(right)) return [];
    if (Array.isArray(left) && Array.isArray(right)) return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => differences(left[i], right[i], `${path}[${i}]`)).flat();
    if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
        return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap(key => differences(left[key], right[key], `${path}.${key}`));
    }
    return [{ path, ...(left !== undefined ? { structured: left } : {}), ...(right !== undefined ? { markdown: right } : {}) }];
}

export function auditGeminiEvidence(evidence: GeminiDetailEvidence) {
    const context = { account: fixtureAccount(), providerId: 'gemini' as const };
    const native = parseGeminiDetailEvidence(structuredClone(evidence), { ...context, bodyRepresentation: 'structured' });
    // Force only the body branch. Native file-chip metadata still closes the
    // same references in either branch, including actual production fallback.
    // Never serialize the native AST to manufacture the Markdown input.
    const markdown = parseGeminiDetailEvidence(structuredClone(evidence), { ...context, bodyRepresentation: 'markdown' });
    const messages: MessageAudit[] = [];
    evidence.messages.forEach((source, index) => {
        if (source.role !== 'model') return;
        const sourceRef = `messages[${index}]`;
        const fallback = native.diagnostics.find(d => d.code === 'GEMINI_STRUCTURED_FALLBACK' && d.sourceRef?.locator === sourceRef);
        const available = Boolean(source.structuredContent) && !fallback;
        const structured = available ? native.conversation.detail.messages[index] : null;
        const md = markdown.conversation.detail.messages[index];
        const left = structured ? canonicalMessage(structured, native.conversation.detail.assets) : null;
        const right = canonicalMessage(md, markdown.conversation.detail.assets);
        const delta = structured ? differences(left, right) : [];
        const semanticDelta = structured ? differences(semanticContent(left), semanticContent(right)) : [];
        messages.push({ index, ...(source.id ? { id: source.id } : {}),
            status: !available ? 'structured_unavailable' : delta.length ? 'different' : 'match',
            ...(!available ? { reason: fallback?.details ?? source.structuredExtraction ?? 'not_present' } : {}),
            rawMarkdown: source.content, nativeDocument: source.structuredContent,
            structured, markdown: md, canonicalStructured: left, canonicalMarkdown: right, differences: delta,
            semanticDifferences: semanticDelta, classification: !available ? 'unavailable' : !delta.length ? 'match' : semanticDelta.length ? 'content_or_metadata' : 'structure_or_format' });
    });
    return { conversationId: evidence.id, sourceMessages: evidence.messages.map(m => ({ id: m.id, role: m.role })),
        complete: !evidence.nextPageToken && !(evidence.turnsRejected ?? 0) && !(evidence.turnsRecovered ?? 0),
        nextPageToken: evidence.nextPageToken, rejectedTurns: evidence.turnsRejected ?? 0,
        diagnostics: { structured: native.diagnostics, markdown: markdown.diagnostics }, messages };
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a native detail envelope');
    return value as Record<string, unknown>;
}

export function readGeminiAuditInput(input: string, kind: 'raw_rpc' | 'native_envelope') {
    if (kind === 'raw_rpc') return { evidence: decodeGeminiDetail(input), provenance: kind, expectedMessages: null };
    const envelope = object(JSON.parse(input));
    if (envelope.source === 'raw_rpc_pages') {
        if (envelope.schemaVersion !== 1 || typeof envelope.conversationId !== 'string'
            || !Array.isArray(envelope.pages) || !envelope.pages.length) throw new Error('Missing native RPC pages');
        const expectedId = envelope.conversationId.replace(/^c_/, '');
        const seenCursors = new Set<string | null>();
        const seenMessages = new Set<string>();
        let cursor: string | null = null;
        let merged: GeminiDetailEvidence | undefined;
        for (const raw of envelope.pages) {
            const page = object(raw);
            if (page.requestCursor !== cursor || seenCursors.has(cursor) || typeof page.text !== 'string') throw new Error('Broken native RPC cursor chain');
            seenCursors.add(cursor);
            const evidence = decodeGeminiDetail(page.text, expectedId);
            if (evidence.id.replace(/^c_/, '') !== expectedId || evidence.turnsRejected || !evidence.messages.length) throw new Error('Invalid native Detail page');
            const fresh = evidence.messages.filter(message => {
                if (!message.id) throw new Error('Native message identity missing');
                if (seenMessages.has(message.id)) return false;
                seenMessages.add(message.id); return true;
            });
            merged = { ...evidence, messages: [...fresh, ...(merged?.messages ?? [])] };
            cursor = evidence.nextPageToken ?? null;
        }
        if (!merged || cursor !== null) throw new Error('Native RPC pagination incomplete');
        return { evidence: merged, provenance: 'captured_raw_rpc_pages', expectedMessages: null };
    }
    if (envelope.success !== true || envelope.source !== 'batchexecute') throw new Error('Only successful native batchexecute evidence is accepted; DOM/cache is not a differential source');
    const data = object(envelope.data), transport = object(data.transport);
    if (!Array.isArray(transport.decodedPayload)) throw new Error('Missing native decodedPayload');
    const conversation = object(data.conversation), index = object(conversation.index), detail = object(conversation.detail);
    if (typeof data.conversationId !== 'string' || 'key' in index || 'key' in detail || 'account' in data || !Array.isArray(detail.messages)) throw new Error('Not a keyless Gemini source detail');
    // Historical captures retain the exact inner payload, not the original HTTP framing.
    // Reconstitute only its transport wrapper, explicitly label this provenance in the report.
    const wrapper = JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify(transport.decodedPayload)]]);
    return { evidence: decodeGeminiDetail(wrapper, data.conversationId), provenance: 'captured_decoded_payload',
        expectedMessages: detail.messages.map(item => { const message = object(item); return { id: message.id, role: message.role === 'assistant' ? 'model' : message.role }; }) };
}
