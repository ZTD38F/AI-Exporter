import type { InlineNode } from './inline.js';

export type BlockNode =
    | ParagraphBlock
    | HeadingBlock
    | ListBlock
    | QuoteBlock
    | CodeBlock
    | MathBlock
    | TableBlock
    | ImageBlock
    | FileBlock
    | ThematicBreakBlock
    | UnknownBlock;

export interface ParagraphBlock {
    type: 'paragraph';
    children: InlineNode[];
}

export interface HeadingBlock {
    type: 'heading';
    level: 1 | 2 | 3 | 4 | 5 | 6;
    children: InlineNode[];
}

export interface ListItem {
    blocks: BlockNode[];
}

export interface ListBlock {
    type: 'list';
    ordered: boolean;
    start?: number;
    items: ListItem[];
}

export interface QuoteBlock {
    type: 'quote';
    blocks: BlockNode[];
}

export interface CodeBlock {
    type: 'code';
    code: string;
    language?: string;
    meta?: string;
}

export interface MathBlock {
    type: 'math';
    source: string;
}

export type TableAlignment = 'left' | 'center' | 'right';

export interface TableColumn {
    align?: TableAlignment;
}

export interface TableCell {
    children: InlineNode[];
    /** Positive integer, at most 1000; the complete logical grid is also at most 1000 columns. */
    colSpan?: number;
    /** Positive integer, at most 65534. */
    rowSpan?: number;
}

export interface TableRow {
    cells: TableCell[];
}

export interface TableBlock {
    type: 'table';
    caption?: InlineNode[];
    columns?: TableColumn[];
    headerRows?: TableRow[];
    rows: TableRow[];
}

export interface ImageBlock {
    type: 'image';
    assetId: string;
    alt?: string;
    caption?: InlineNode[];
}

export interface FileBlock {
    type: 'file';
    assetId: string;
    label?: string;
    description?: InlineNode[];
}

export interface ThematicBreakBlock {
    type: 'thematicBreak';
}

/** Unsupported content remains visible as plain text. */
export interface UnknownBlock {
    type: 'unknown';
    sourceType: string;
    text: string;
}
