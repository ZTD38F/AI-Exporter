import type { ConversationKey } from '../src/l2/conversationKey.js';
import type { DomainConversationIndex } from '../src/l2/conversationIndex.js';
import type { DomainConversationDetail, DomainMessage, DomainAsset, DomainCitation,
    DomainDocumentMetadata, DomainGeneratedMediaIdentity } from '../src/l2/conversationDetail.js';
import type { ContentQuality } from '../src/l2/quality.js';
import type { BlockNode, TableCell, TableColumn, TableRow, ListItem } from '../src/l2/content/blocks.js';
import type { InlineNode } from '../src/l2/content/inline.js';

/** Compile-time gate: extending a Domain shape requires comparing the new fact.
 * The production comparator exhaustively checks the variants of the two AST unions;
 * this gate also covers properties added to an EXISTING variant or entity.
 */
type RequireNever<T extends never> = T;
type FieldsNotCompared<T, Covered extends keyof T> = Exclude<keyof T, Covered>;
type Block<T extends BlockNode['type']> = Extract<BlockNode, { type: T }>;
type Inline<T extends InlineNode['type']> = Extract<InlineNode, { type: T }>;
type ComparisonFieldCoverage = [
    RequireNever<FieldsNotCompared<ConversationKey, 'accountId' | 'conversationId'>>,
    RequireNever<FieldsNotCompared<DomainConversationIndex, 'key' | 'title' | 'titleSource' | 'createdAt' | 'updatedAt' | 'activityAt'>>,
    RequireNever<FieldsNotCompared<DomainConversationDetail, 'key' | 'savedAt' | 'quality' | 'assets' | 'messages'>>,
    RequireNever<FieldsNotCompared<DomainMessage, 'id' | 'role' | 'model' | 'content' | 'timestamp' | 'attachmentIds' | 'reasoning' | 'citations'>>,
    RequireNever<FieldsNotCompared<DomainAsset, 'id' | 'kind' | 'name' | 'mediaType' | 'byteLength' | 'sourceUri' | 'generation' | 'document'>>,
    RequireNever<FieldsNotCompared<DomainCitation, 'id' | 'url' | 'title'>>,
    RequireNever<FieldsNotCompared<DomainDocumentMetadata, 'id' | 'contentMarkdown'>>,
    RequireNever<FieldsNotCompared<DomainGeneratedMediaIdentity, 'providerRequestId' | 'time' | 'prompt' | 'generationOrdinal' | 'imageCount' | 'imageOrdinal'>>,
    RequireNever<FieldsNotCompared<ContentQuality, 'status' | 'sourceTurn'>>,
    RequireNever<FieldsNotCompared<ListItem, 'blocks'>>,
    RequireNever<FieldsNotCompared<TableColumn, 'align'>>,
    RequireNever<FieldsNotCompared<TableCell, 'children' | 'colSpan' | 'rowSpan'>>,
    RequireNever<FieldsNotCompared<TableRow, 'cells'>>,
    RequireNever<FieldsNotCompared<Block<'paragraph'>, 'type' | 'children'>>,
    RequireNever<FieldsNotCompared<Block<'heading'>, 'type' | 'level' | 'children'>>,
    RequireNever<FieldsNotCompared<Block<'list'>, 'type' | 'ordered' | 'start' | 'items'>>,
    RequireNever<FieldsNotCompared<Block<'quote'>, 'type' | 'blocks'>>,
    RequireNever<FieldsNotCompared<Block<'code'>, 'type' | 'code' | 'language' | 'meta'>>,
    RequireNever<FieldsNotCompared<Block<'math'>, 'type' | 'source'>>,
    RequireNever<FieldsNotCompared<Block<'table'>, 'type' | 'caption' | 'columns' | 'headerRows' | 'rows'>>,
    RequireNever<FieldsNotCompared<Block<'image'>, 'type' | 'assetId' | 'alt' | 'caption'>>,
    RequireNever<FieldsNotCompared<Block<'file'>, 'type' | 'assetId' | 'label' | 'description'>>,
    RequireNever<FieldsNotCompared<Block<'thematicBreak'>, 'type'>>,
    RequireNever<FieldsNotCompared<Block<'unknown'>, 'type' | 'sourceType' | 'text'>>,
    RequireNever<FieldsNotCompared<Inline<'text'>, 'type' | 'text'>>,
    RequireNever<FieldsNotCompared<Inline<'strong'>, 'type' | 'children'>>,
    RequireNever<FieldsNotCompared<Inline<'emphasis'>, 'type' | 'children'>>,
    RequireNever<FieldsNotCompared<Inline<'strikethrough'>, 'type' | 'children'>>,
    RequireNever<FieldsNotCompared<Inline<'inlineCode'>, 'type' | 'code'>>,
    RequireNever<FieldsNotCompared<Inline<'link'>, 'type' | 'href' | 'title' | 'children'>>,
    RequireNever<FieldsNotCompared<Inline<'image'>, 'type' | 'assetId' | 'alt' | 'title'>>,
    RequireNever<FieldsNotCompared<Inline<'inlineMath'>, 'type' | 'source'>>,
    RequireNever<FieldsNotCompared<Inline<'citationRef'>, 'type' | 'citationId' | 'label'>>,
    RequireNever<FieldsNotCompared<Inline<'lineBreak'>, 'type' | 'kind'>>,
];
