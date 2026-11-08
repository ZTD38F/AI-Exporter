import type { DomainAssetKind, DomainMessageRole } from '../../l2/conversationDetail.js';

/** Format-neutral logical presentation tree. Styles, output controls and geometry live in backends. */
export type DisplayInline =
    | { type: 'text'; text: string }
    | { type: 'strong' | 'emphasis' | 'strikethrough'; children: DisplayInline[] }
    | { type: 'inlineCode'; code: string }
    | { type: 'link'; href: string; title?: string; children: DisplayInline[] }
    | { type: 'citation'; id: string; label: string; href?: string }
    | { type: 'image'; resourceId: string; alt: string; title?: string }
    | { type: 'inlineMath'; source: string }
    | { type: 'lineBreak'; kind: 'soft' | 'hard' };

export interface DisplayCell {
    children: DisplayInline[];
    column: number;
    colSpan: number;
    rowSpan: number;
}

export type DisplayBlock = (
    | { type: 'paragraph'; children: DisplayInline[] }
    | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: DisplayInline[] }
    | { type: 'list'; ordered: boolean; start?: number; items: Array<{ blocks: DisplayBlock[] }> }
    | { type: 'quote'; blocks: DisplayBlock[] }
    | { type: 'code'; code: string; language?: string; meta?: string }
    | { type: 'math'; source: string }
    | { type: 'table'; caption?: DisplayInline[]; columnAlignments: Array<'left' | 'center' | 'right' | 'default'>; headerRows: DisplayCell[][]; rows: DisplayCell[][] }
    | { type: 'image'; resourceId: string; alt: string; caption?: DisplayInline[] }
    | { type: 'file'; resourceId: string; label: string; kind: DomainAssetKind; mediaType?: string; byteLength?: number; description?: DisplayInline[] }
    | { type: 'disclosure'; kind: string; title: string; blocks: DisplayBlock[] }
    | { type: 'thematicBreak' }
    | { type: 'unsupported'; sourceType: string; text: string }
);

export interface SourceItem {
    id: string;
    label: string;
    href?: string;
    number: number;
}

export interface DisplayMessage {
    role: DomainMessageRole;
    timestamp?: number;
    modelLabel?: string;
    blocks: DisplayBlock[];
    sources?: SourceItem[];
}

export interface DocumentAst {
    title: string;
    metadata: {
        id: string;
        provider: string;
        createdAt?: number;
        updatedAt?: number;
    };
    messages: DisplayMessage[];
}
