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
    | ThoughtBlock
    | ThematicBreakBlock
    | UnknownBlock;

export interface BlockBase {
    id: string;
}

export interface ParagraphBlock extends BlockBase {
    type: 'paragraph';
    children: InlineNode[];
}

export interface HeadingBlock extends BlockBase {
    type: 'heading';
    level: 1 | 2 | 3 | 4 | 5 | 6;
    children: InlineNode[];
}

export interface ListItem {
    blocks: BlockNode[];
}

export interface ListBlock extends BlockBase {
    type: 'list';
    ordered: boolean;
    start?: number;
    items: ListItem[];
}

export interface QuoteBlock extends BlockBase {
    type: 'quote';
    blocks: BlockNode[];
}

export interface CodeBlock extends BlockBase {
    type: 'code';
    code: string;
    language?: string;
    meta?: string;
    filename?: string;
}

export interface MathBlock extends BlockBase {
    type: 'math';
    source: string;
}

export type TableAlignment = 'left' | 'center' | 'right' | 'default';

export interface TableColumn {
    align?: TableAlignment;
}

export interface TableCell {
    children: InlineNode[];
    colSpan?: number;
    rowSpan?: number;
}

export interface TableRow {
    cells: TableCell[];
}

export interface TableBlock extends BlockBase {
    type: 'table';
    caption?: InlineNode[];
    columns?: TableColumn[];
    headerRows?: TableRow[];
    rows: TableRow[];
}

export interface ImageBlock extends BlockBase {
    type: 'image';
    assetId: string;
    alt?: string;
    caption?: InlineNode[];
}

export interface FileBlock extends BlockBase {
    type: 'file';
    assetId: string;
    label?: string;
    description?: InlineNode[];
}

export interface ThoughtBlock extends BlockBase {
    type: 'thought';
    disclosure: 'providerExposed';
    kind?: 'summary' | 'progress' | 'reasoning' | 'unknown';
    blocks: BlockNode[];
}

export interface ThematicBreakBlock extends BlockBase {
    type: 'thematicBreak';
}

/** Unsupported content remains visible as plain text. */
export interface UnknownBlock extends BlockBase {
    type: 'unknown';
    sourceType: string;
    text: string;
}
