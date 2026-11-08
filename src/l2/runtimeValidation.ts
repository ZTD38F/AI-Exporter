import { isDurableSourceUri } from './sourceUri.js';
import { readConversationKey, sameConversationKey } from './conversationKey.js';
import type { BlockNode, TableBlock, TableColumn, TableRow, TableCell, ListItem } from './content/blocks.js';
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROW_SPAN, tableCellPlacements } from './content/tableLayout.js';
import type { InlineNode } from './content/inline.js';
import type { ConversationKey } from './conversationKey.js';
import type { ContentQuality } from './quality.js';
import type { DomainAsset, DomainCitation, DomainDocumentMetadata, DomainGeneratedMediaIdentity, DomainMessage, DomainConversationDetail, ConversationDetail } from './conversationDetail.js';
import { assertDomainClosure } from './closure.js';
import type { DomainConversation, DomainConversationWithDetail } from './conversation.js';
import { restoreConversationIndex } from './conversationIndex.js';
import type { DomainConversationIndex } from './conversationIndex.js';

/** A schema checks every declared field; adding a Domain field requires updating its decoder. */
type Check<T> = (value: unknown) => value is T;
type Fields<T> = { [K in keyof T]-?: Check<T[K]> };
const text: Check<string> = (v): v is string => typeof v === 'string';
const number: Check<number> = (v): v is number => typeof v === 'number' && Number.isFinite(v);
const sourceTime: Check<number> = (v): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const byteLength: Check<number> = (v): v is number => sourceTime(v) && v >= 0;
const boolean: Check<boolean> = (v): v is boolean => typeof v === 'boolean';
const optional = <T>(check: Check<T>): Check<T | undefined> => (v): v is T | undefined => v === undefined || check(v);
const array = <T>(check: Check<T>): Check<T[]> => (v): v is T[] => {
    if (!Array.isArray(v)) return false;
    for (let index = 0; index < v.length; index++) {
        if (!Object.hasOwn(v, index) || !check(v[index])) return false;
    }
    return true;
};
const enumeration = <T extends string | number>(...values: T[]): Check<T> => (v): v is T => values.some(value => value === v);
function object(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
const shape = <T extends object>(fields: Fields<T>, nonEmpty = false): Check<T> => (v): v is T => {
    if (!object(v)) return false;
    const keys = Object.keys(v);
    if (nonEmpty && !keys.some(k => v[k] !== undefined) || keys.some(k => !Object.hasOwn(fields, k))) return false;
    for (const key in fields) if (!fields[key](v[key])) return false;
    return true;
};
const generation = shape<DomainGeneratedMediaIdentity>({ providerRequestId: optional(text), time: optional(sourceTime), prompt: optional(text), generationOrdinal: optional(number), imageCount: optional(number), imageOrdinal: optional(number) }, true);
const document = shape<DomainDocumentMetadata>({ id: optional(text), contentMarkdown: optional(text) }, true);
const asset = shape<DomainAsset>({ id: text, kind: enumeration('image', 'file', 'audio', 'video', 'other'), name: optional(text), mediaType: optional(text), byteLength: optional(byteLength), sourceUri: optional(isDurableSourceUri), generation: optional(generation), document: optional(document) });
const citation = shape<DomainCitation>({ id: text, url: optional(text), title: optional(text) });

function inline(v: unknown): v is InlineNode {
    if (!object(v)) return false;
    const t = v.type;
    const children = array(inline);
    switch (t) {
        case 'text': return shape<Extract<InlineNode, { type: 'text' }>>({ type: enumeration(t), text })(v);
        case 'strong': return shape<Extract<InlineNode, { type: 'strong' }>>({ type: enumeration(t), children })(v);
        case 'emphasis': return shape<Extract<InlineNode, { type: 'emphasis' }>>({ type: enumeration(t), children })(v);
        case 'strikethrough': return shape<Extract<InlineNode, { type: 'strikethrough' }>>({ type: enumeration(t), children })(v);
        case 'inlineCode': return shape<Extract<InlineNode, { type: 'inlineCode' }>>({ type: enumeration(t), code: text })(v);
        case 'inlineMath': return shape<Extract<InlineNode, { type: 'inlineMath' }>>({ type: enumeration(t), source: text })(v);
        case 'link': return shape<Extract<InlineNode, { type: 'link' }>>({ type: enumeration(t), href: text, title: optional(text), children })(v);
        case 'image': return shape<Extract<InlineNode, { type: 'image' }>>({ type: enumeration(t), assetId: text, alt: optional(text), title: optional(text) })(v);
        case 'citationRef': return shape<Extract<InlineNode, { type: 'citationRef' }>>({ type: enumeration(t), citationId: text, label: optional(text) })(v);
        case 'lineBreak': return shape<Extract<InlineNode, { type: 'lineBreak' }>>({ type: enumeration(t), kind: enumeration('soft', 'hard') })(v);
        default: return false;
    }
}
function tableShape(v: unknown): v is TableBlock {
    const span = (max: number): Check<number> => (v): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= max;
    const row = shape<TableRow>({ cells: array(shape<TableCell>({ children: array(inline), colSpan: optional(span(MAX_TABLE_COLUMNS)), rowSpan: optional(span(MAX_TABLE_ROW_SPAN)) })) });
    return shape<TableBlock>({ type: enumeration('table'), caption: optional(array(inline)), columns: optional(array(shape<TableColumn>({ align: optional(enumeration('left', 'center', 'right')) }))), headerRows: optional(array(row)), rows: array(row) })(v);
}
function table(v: unknown): v is TableBlock {
    if (!tableShape(v) || (v.columns?.length ?? 0) > MAX_TABLE_COLUMNS) return false;
    for (const cell of tableCellPlacements(v)) if (cell.column + cell.colSpan > MAX_TABLE_COLUMNS) return false;
    return true;
}
function block(v: unknown): v is BlockNode {
    if (!object(v)) return false;
    const t = v.type;
    const children = array(inline);
    switch (t) {
        case 'paragraph': return shape<Extract<BlockNode, { type: 'paragraph' }>>({ type: enumeration(t), children })(v);
        case 'heading': return shape<Extract<BlockNode, { type: 'heading' }>>({ type: enumeration(t), level: enumeration(1, 2, 3, 4, 5, 6), children })(v);
        case 'list': return shape<Extract<BlockNode, { type: 'list' }>>({ type: enumeration(t), ordered: boolean, start: optional(number), items: array(shape<ListItem>({ blocks: array(block) })) })(v);
        case 'quote': return shape<Extract<BlockNode, { type: 'quote' }>>({ type: enumeration(t), blocks: array(block) })(v);
        case 'code': return shape<Extract<BlockNode, { type: 'code' }>>({ type: enumeration(t), code: text, language: optional(text), meta: optional(text) })(v);
        case 'math': return shape<Extract<BlockNode, { type: 'math' }>>({ type: enumeration(t), source: text })(v);
        case 'image': return shape<Extract<BlockNode, { type: 'image' }>>({ type: enumeration(t), assetId: text, alt: optional(text), caption: optional(children) })(v);
        case 'file': return shape<Extract<BlockNode, { type: 'file' }>>({ type: enumeration(t), assetId: text, label: optional(text), description: optional(children) })(v);
        case 'table': return table(v);
        case 'thematicBreak': return shape<Extract<BlockNode, { type: 'thematicBreak' }>>({ type: enumeration(t) })(v);
        case 'unknown': return shape<Extract<BlockNode, { type: 'unknown' }>>({ type: enumeration(t), sourceType: text, text })(v);
        default: return false;
    }
}
const message = shape<DomainMessage>({ id: optional(text), role: enumeration('user', 'assistant', 'system', 'developer', 'unknown'), model: optional(text), content: array(block), timestamp: optional(sourceTime), attachmentIds: optional(array(text)), reasoning: optional(array(block)), citations: optional(array(citation)) });
const quality = shape<ContentQuality>({ status: enumeration('complete', 'partial', 'unknown'), sourceTurn: optional(enumeration('finished', 'unfinished', 'interrupted', 'handoff', 'awaiting_reply', 'tool_pending', 'unknown')) });
const domainFields: Fields<DomainConversationDetail> = { key: (v): v is ConversationKey => { try { readConversationKey(v); return true; } catch { return false; } }, savedAt: optional(sourceTime), assets: array(asset), messages: array(message), quality };
const domain = shape<DomainConversationDetail>(domainFields);

/** Omit unknown optional facts without copying already canonical parser/Storage graphs. */
function omitUndefined(value: unknown): unknown {
    if (Array.isArray(value)) {
        const entries: readonly unknown[] = value;
        const next = entries.map(item => omitUndefined(item));
        return next.some((item, i) => item !== value[i]) ? next : value;
    }
    if (!object(value)) return value;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (item === undefined) { changed = true; continue; }
        next[key] = omitUndefined(item);
        if (next[key] !== item) changed = true;
    }
    return changed ? next : value;
}

/** Compile-time evidence of schema and reference closure; never serialized. */
declare const trustedDomain: unique symbol;
export type TrustedDomainBody = DomainConversationDetail & { readonly [trustedDomain]: true };
export interface TrustedDomain extends DomainConversationWithDetail { detail: TrustedDomainBody }

/** Frozen public read view: structural Index plus required Detail; no brand or DTO. */
export type ReadonlyDomain = Readonly<DomainConversation & { detail: ConversationDetail }>;

function assertSchema(value: unknown): asserts value is DomainConversationDetail {
    let valid = false;
    try { valid = domain(value); } catch { throw new TypeError('Invalid recursive Domain contract'); }
    if (!valid) {
        const field = object(value) ? Object.keys(value).find(k => !Object.hasOwn(domainFields, k))
            ?? Object.entries(domainFields).find(([k, check]) => !check(value[k]))?.[0] : undefined;
        throw new TypeError(`Invalid persisted Domain contract${field ? ': ' + field : ''}`);
    }
}

/** In-memory evidence only; IPC and persistence never carry this marker. */
const trustedBodies = new WeakSet<Omit<DomainConversationDetail, 'key'>>();
function isTrustedBody(value: Omit<DomainConversationDetail, 'key'>): value is TrustedDomainBody {
    return trustedBodies.has(value);
}

/** Schema, canonical optional fields and reference closure are proved before registration. */
function readDetail(value: unknown): DomainConversationDetail {
    assertSchema(value);
    let detail = value;
    const normalized = omitUndefined(value);
    if (normalized !== value) {
        // A structural transform returns unknown until the output schema has been checked.
        assertSchema(normalized);
        detail = normalized;
    }
    assertDomainClosure(detail);
    return detail;
}

function registerDetail(detail: DomainConversationDetail): asserts detail is TrustedDomainBody {
    trustedBodies.add(detail);
}

/** Parser finalization preserves canonical graphs and never interprets provider payloads. */
export function validateParserDomain(input: { index: DomainConversationIndex; detail: Omit<DomainConversationDetail, 'key'> & { key?: DomainConversationDetail['key'] } }): TrustedDomain {
    const value = input.detail.key === undefined ? { ...input, detail: { ...input.detail, key: input.index.key } } : input;
    return restoreDomainSnapshot(value);
}

/** Validate external facts once, or reuse an already validated parser body. */
export function acceptDetailFacts(key: DomainConversationDetail['key'], facts: Omit<DomainConversationDetail, 'key'>): TrustedDomainBody {
    if (isTrustedBody(facts)) {
        if (!sameConversationKey(key, facts.key)) throw new TypeError('Detail identity mismatch');
        return facts;
    }
    if ('key' in facts && !sameConversationKey(key, readConversationKey(facts.key))) throw new TypeError('Detail identity mismatch');
    return restoreDomainDetail({ ...facts, key });
}

/** Persistence/IPC values are already detached by the transport; no JSON clone. */
export function restoreDomainDetail(value: unknown): TrustedDomainBody {
    const detail = readDetail(value);
    registerDetail(detail);
    return detail;
}

export function restoreDomainSnapshot(value: unknown): TrustedDomain {
    if (!object(value) || Object.keys(value).some(key => key !== 'index' && key !== 'detail')) throw new TypeError('Invalid Domain conversation');
    const index = restoreConversationIndex(value.index);
    const detail = readDetail(value.detail);
    if (!sameConversationKey(index.key, detail.key)) throw new TypeError('Conversation key mismatch');
    registerDetail(detail);
    return { index, detail };
}
