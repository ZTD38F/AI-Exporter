export type InlineNode =
    | TextInline
    | StrongInline
    | EmphasisInline
    | StrikethroughInline
    | InlineCode
    | LinkInline
    | ImageInline
    | InlineMath
    | CitationRefInline
    | LineBreakInline;

export interface TextInline {
    type: 'text';
    text: string;
}

export interface StrongInline {
    type: 'strong';
    children: InlineNode[];
}

export interface EmphasisInline {
    type: 'emphasis';
    children: InlineNode[];
}

export interface StrikethroughInline {
    type: 'strikethrough';
    children: InlineNode[];
}

export interface InlineCode {
    type: 'inlineCode';
    code: string;
}

export interface LinkInline {
    type: 'link';
    href: string;
    title?: string;
    children: InlineNode[];
}

export interface ImageInline {
    type: 'image';
    assetId: string;
    alt?: string;
    title?: string;
}

export interface InlineMath {
    type: 'inlineMath';
    source: string;
}

export interface CitationRefInline {
    type: 'citationRef';
    citationId: string;
    label?: string;
}

export interface LineBreakInline {
    type: 'lineBreak';
    kind: 'soft' | 'hard';
}
