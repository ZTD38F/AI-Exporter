import type { ConversationKey } from './conversationKey.js';
import type { DomainConversationIndex } from './conversationIndex.js';
import type { DomainConversationDetail, DomainMessage, DomainAsset, DomainCitation,
    DomainDocumentMetadata, DomainGeneratedMediaIdentity } from './conversationDetail.js';
import type { ContentQuality } from './quality.js';
import type { BlockNode, ListItem, TableRow, TableCell, TableColumn } from './content/blocks.js';
import type { InlineNode } from './content/inline.js';

/** All inputs have passed L2's Domain schema boundary. No raw payloads or shape guessing. */
type DomainFact = ConversationKey | DomainConversationIndex | DomainConversationDetail
    | DomainMessage | DomainAsset | DomainCitation | DomainDocumentMetadata
    | DomainGeneratedMediaIdentity | ContentQuality | BlockNode | InlineNode
    | ListItem | TableRow | TableCell | TableColumn;

/** Preserve JSON's distinction between an absent field and a present optional field. */
function sameFields(a: DomainFact, b: DomainFact): boolean {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key));
}

type ArrayElement = DomainMessage | DomainAsset | DomainCitation | BlockNode | InlineNode
    | ListItem | TableRow | TableCell | TableColumn | string;

function sameArray<T extends ArrayElement>(a: readonly T[] | undefined, b: readonly T[] | undefined, equal: (a: T, b: T) => boolean): boolean {
    if (a === b) return true;
    return a !== undefined && b !== undefined && a.length === b.length
        && a.every((value, i) => equal(value, b[i]));
}

function sameOptional<T extends DomainGeneratedMediaIdentity | DomainDocumentMetadata>(a: T | undefined, b: T | undefined, equal: (a: T, b: T) => boolean): boolean {
    return a === b || (a !== undefined && b !== undefined && equal(a, b));
}

const sameString = (a: string, b: string): boolean => a === b;

function sameKey(a: ConversationKey, b: ConversationKey): boolean {
    return a === b || (sameFields(a, b) && a.accountId === b.accountId && a.conversationId === b.conversationId);
}

function sameInline(a: InlineNode, b: InlineNode): boolean {
    if (a === b) return true;
    if (a.type !== b.type || !sameFields(a, b)) return false;
    switch (a.type) {
        case 'text': return b.type === 'text' && a.text === b.text;
        case 'strong': return b.type === 'strong' && sameArray(a.children, b.children, sameInline);
        case 'emphasis': return b.type === 'emphasis' && sameArray(a.children, b.children, sameInline);
        case 'strikethrough': return b.type === 'strikethrough' && sameArray(a.children, b.children, sameInline);
        case 'inlineCode': return b.type === 'inlineCode' && a.code === b.code;
        case 'link': return b.type === 'link' && a.href === b.href && a.title === b.title
            && sameArray(a.children, b.children, sameInline);
        case 'image': return b.type === 'image' && a.assetId === b.assetId && a.alt === b.alt && a.title === b.title;
        case 'inlineMath': return b.type === 'inlineMath' && a.source === b.source;
        case 'citationRef': return b.type === 'citationRef' && a.citationId === b.citationId && a.label === b.label;
        case 'lineBreak': return b.type === 'lineBreak' && a.kind === b.kind;
        default: {
            const unreachable: never = a;
            return unreachable;
        }
    }
}

function sameColumn(a: TableColumn, b: TableColumn): boolean {
    return a === b || (sameFields(a, b) && a.align === b.align);
}
function sameCell(a: TableCell, b: TableCell): boolean {
    return a === b || (sameFields(a, b) && a.colSpan === b.colSpan && a.rowSpan === b.rowSpan
        && sameArray(a.children, b.children, sameInline));
}
function sameRow(a: TableRow, b: TableRow): boolean {
    return a === b || (sameFields(a, b) && sameArray(a.cells, b.cells, sameCell));
}
function sameListItem(a: ListItem, b: ListItem): boolean {
    return a === b || (sameFields(a, b) && sameArray(a.blocks, b.blocks, sameBlock));
}

function sameBlock(a: BlockNode, b: BlockNode): boolean {
    if (a === b) return true;
    if (a.type !== b.type || !sameFields(a, b)) return false;
    switch (a.type) {
        case 'paragraph': return b.type === 'paragraph' && sameArray(a.children, b.children, sameInline);
        case 'heading': return b.type === 'heading' && a.level === b.level && sameArray(a.children, b.children, sameInline);
        case 'list': return b.type === 'list' && a.ordered === b.ordered && a.start === b.start
            && sameArray(a.items, b.items, sameListItem);
        case 'quote': return b.type === 'quote' && sameArray(a.blocks, b.blocks, sameBlock);
        case 'code': return b.type === 'code' && a.code === b.code && a.language === b.language && a.meta === b.meta;
        case 'math': return b.type === 'math' && a.source === b.source;
        case 'table': return b.type === 'table' && sameArray(a.caption, b.caption, sameInline)
            && sameArray(a.columns, b.columns, sameColumn)
            && sameArray(a.headerRows, b.headerRows, sameRow)
            && sameArray(a.rows, b.rows, sameRow);
        case 'image': return b.type === 'image' && a.assetId === b.assetId && a.alt === b.alt
            && sameArray(a.caption, b.caption, sameInline);
        case 'file': return b.type === 'file' && a.assetId === b.assetId && a.label === b.label
            && sameArray(a.description, b.description, sameInline);
        case 'thematicBreak': return b.type === 'thematicBreak';
        case 'unknown': return b.type === 'unknown' && a.sourceType === b.sourceType && a.text === b.text;
        default: {
            const unreachable: never = a;
            return unreachable;
        }
    }
}

function sameCitation(a: DomainCitation, b: DomainCitation): boolean {
    return a === b || (sameFields(a, b) && a.id === b.id && a.url === b.url && a.title === b.title);
}
function sameMessage(a: DomainMessage, b: DomainMessage): boolean {
    return a === b || (sameFields(a, b) && a.id === b.id && a.role === b.role && a.model === b.model
        && a.timestamp === b.timestamp
        && sameArray(a.content, b.content, sameBlock)
        && sameArray(a.reasoning, b.reasoning, sameBlock)
        && sameArray(a.attachmentIds, b.attachmentIds, sameString)
        && sameArray(a.citations, b.citations, sameCitation));
}
function sameGeneration(a: DomainGeneratedMediaIdentity, b: DomainGeneratedMediaIdentity): boolean {
    return a === b || (sameFields(a, b) && a.providerRequestId === b.providerRequestId
        && a.time === b.time && a.prompt === b.prompt && a.generationOrdinal === b.generationOrdinal
        && a.imageCount === b.imageCount && a.imageOrdinal === b.imageOrdinal);
}
function sameDocument(a: DomainDocumentMetadata, b: DomainDocumentMetadata): boolean {
    return a === b || (sameFields(a, b) && a.id === b.id && a.contentMarkdown === b.contentMarkdown);
}
function sameAsset(a: DomainAsset, b: DomainAsset): boolean {
    return a === b || (sameFields(a, b) && a.id === b.id && a.kind === b.kind
        && a.name === b.name && a.mediaType === b.mediaType && a.byteLength === b.byteLength
        && a.sourceUri === b.sourceUri
        && sameOptional(a.generation, b.generation, sameGeneration)
        && sameOptional(a.document, b.document, sameDocument));
}
function sameQuality(a: ContentQuality, b: ContentQuality): boolean {
    return a === b || (sameFields(a, b) && a.status === b.status && a.sourceTurn === b.sourceTurn);
}

/** Index deduplication. Object field insertion order never changes the stored facts. */
export function index(a: DomainConversationIndex | null | undefined, b: DomainConversationIndex | null | undefined): boolean {
    if (a === b) return true;
    if (!a || !b || !sameFields(a, b)) return false;
    return sameKey(a.key, b.key) && a.title === b.title && a.titleSource === b.titleSource
        && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt && a.activityAt === b.activityAt;
}

/** Live Save material-change semantics deliberately exclude source savedAt and key metadata. */
export function material(a: DomainConversationDetail, b: DomainConversationDetail): boolean {
    return a === b || (sameArray(a.messages, b.messages, sameMessage)
        && sameArray(a.assets, b.assets, sameAsset)
        && sameQuality(a.quality, b.quality));
}

/** Full persisted body equality: source version advances can commit without a Live Save change. */
export function detail(a: DomainConversationDetail | null, b: DomainConversationDetail | null): boolean {
    if (a === b) return true;
    if (a === null || b === null || !sameFields(a, b)) return false;
    return sameKey(a.key, b.key) && a.savedAt === b.savedAt && sameQuality(a.quality, b.quality)
        && sameArray(a.messages, b.messages, sameMessage)
        && sameArray(a.assets, b.assets, sameAsset);
}
