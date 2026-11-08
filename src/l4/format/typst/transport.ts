/** PDF backend policy and transport; never part of the format-neutral document. */
export interface BlockLayout { gapBeforePt: number; keepWithNext: boolean; width: 'container' | 'reading' | 'full' }
export interface PdfLayoutPolicy {
    page: { widthMm: number; heightMm: number; topMm: number; bottomMm: number; sideMm: number; contentWidthMm: number; proseWidthMm: number };
    bubble: { maxWidthRatio: number; compactHeightPt: number; minInnerWidthPt: number; paddingXPt: number; paddingYPt: number };
    figure: { maxPageHeightRatio: number; captionMaxWidthMm: number };
    textLanguage: string; headerGapPt: number; bodyGapPt: number;
}

/** Output engine transport. Contains only composed display data and math code. */
export type TypstInlineNode =
    | { type: 'text'; text: string }
    | { type: 'strong'; children: TypstInlineNode[] }
    | { type: 'emphasis'; children: TypstInlineNode[] }
    | { type: 'strikethrough'; children: TypstInlineNode[] }
    | { type: 'inlineCode'; text: string }
    | { type: 'link'; url: string; children: TypstInlineNode[] }
    | { type: 'lineBreak' }
    | { type: 'image'; asset: string; alt?: string }
    | { type: 'inlineMath'; latex: string; typst?: string };

export type TypstListItem = { blocks: TypstBlockNode[] };

export type TypstTableCell = {
    children: TypstInlineNode[];
    colspan?: number;
    rowspan?: number;
};

export type TypstBlockNode = (
    | { type: 'paragraph'; children: TypstInlineNode[] }
    | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: TypstInlineNode[] }
    | { type: 'list'; ordered: boolean; start?: number; items: TypstListItem[] }
    | { type: 'code'; language: string; text: string; header: string }
    | { type: 'math'; latex: string; typst?: string; fallbackLabel: string }
    | {
        type: 'table';
        headers: TypstTableCell[][];
        rows: TypstTableCell[][];
        aligns: ('left' | 'center' | 'right')[];
        columnCount: number;
        repeatHeader: boolean;
        caption?: TypstInlineNode[];
    }
    | { type: 'image'; asset: string; caption?: TypstInlineNode[] }
    | { type: 'file'; name: string; kind: string; size: string; metadata: string; description?: TypstInlineNode[] }
    | { type: 'quote'; blocks: TypstBlockNode[] }
    | { type: 'note'; label?: string; children?: TypstInlineNode[]; blocks?: TypstBlockNode[] }
    | { type: 'thematicBreak' }
    | { type: 'unknown'; sourceType: string; label: string; fallback: string; details?: TypstInlineNode[] }
) & { layout: BlockLayout };

export interface TypstRenderMessage {
    id: string;
    variant: 'bubble' | 'flow';
    minWidthCards: Array<{ label: string; metadata: string }>;
    gapAfterPt: number;
    model?: string;
    plainText?: string;
    blocks: TypstBlockNode[];
}

export interface TypstConversationRenderPayload {
    schemaVersion: 1;
    title: string;
    metadata: string;
    layout: PdfLayoutPolicy;
    profile: { id: 'pdf'; version: 1 };
    messages: TypstRenderMessage[];
}
