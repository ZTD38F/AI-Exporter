/**
 * src/core/export/canonical/markdown/mdastToCanonical.ts
 *
 * Pure adapter from MDAST (mdast-util-from-markdown) to Canonical AST (blocks.ts, inline.ts).
 *
 * Responsibilities:
 * - Maps MDAST Root/BlockContent nodes to Canonical BlockNode[].
 * - Maps MDAST PhrasingContent nodes to Canonical InlineNode[].
 * - Wires Gemini-specific asset linking via linkInlineImage().
 * - Emits required Canonical diagnostics (MATH_FENCE_UNCLOSED, MATH_BLOCK_EMPTY).
 * - Preserves soft and hard line breaks according to Canonical schema.
 */

import type {
    Root,
    RootContent,
    BlockContent,
    PhrasingContent,
    Paragraph,
    Heading,
    ThematicBreak,
    Blockquote,
    List,
    ListItem as MdastListItem,
    Table,
    TableRow as MdastTableRow,
    TableCell as MdastTableCell,
    Code,
    HTML,
    Text,
    Emphasis,
    Strong,
    Delete,
    InlineCode as MdastInlineCode,
    Link,
    Image,
    Break,
    Definition,
    LinkReference,
    ImageReference,
} from 'mdast';
import type { InlineMath, Math as MdastMath } from 'mdast-util-math';
import type {
    BlockNode,
    CodeBlock,
    HeadingBlock,
    ListBlock,
    ListItem,
    MathBlock,
    ParagraphBlock,
    QuoteBlock,
    TableAlignment,
    TableBlock,
    TableColumn,
    TableRow,
    ThematicBreakBlock,
    UnknownBlock,
} from '../blocks.js';
import type {
    ImageInline,
    InlineCode,
    InlineNode,
    LineBreakInline,
    LinkInline,
    StrikethroughInline,
    StrongInline,
    EmphasisInline,
    TextInline,
} from '../inline.js';
import type { JsonValue } from '../json.js';
import type { Diagnostic } from '../diagnostics.js';
import type { SourceRef } from '../provenance.js';
import {
    type AssetParserContext,
    linkInlineImage,
} from '../gemini/normalizeAssets.js';

export interface MarkdownParseContext extends AssetParserContext {
    nextBlockId: () => string;
    definitions?: Map<string, { url: string; title?: string }>;
}

/**
 * Coalesce consecutive TextInline nodes within the inline tree.
 */
export function mergeAdjacentTextNodes(nodes: InlineNode[]): InlineNode[] {
    const result: InlineNode[] = [];
    for (const node of nodes) {
        if ('children' in node && Array.isArray((node as any).children)) {
            const mergedChildren = mergeAdjacentTextNodes((node as any).children);
            result.push({ ...(node as any), children: mergedChildren });
        } else if (node.type === 'text') {
            const prev = result[result.length - 1];
            if (prev && prev.type === 'text') {
                prev.text += node.text;
            } else {
                result.push({ ...node });
            }
        } else {
            result.push(node);
        }
    }
    return result;
}

/**
 * Converts a text string containing newlines into TextInline and soft LineBreakInline nodes.
 */
function textWithSoftBreaks(text: string): InlineNode[] {
    if (!text.includes('\n')) {
        return text ? [{ type: 'text', text }] : [];
    }
    const lines = text.split('\n');
    const nodes: InlineNode[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (i > 0) {
            nodes.push({ type: 'lineBreak', kind: 'soft' });
        }
        if (lines[i].length > 0) {
            nodes.push({ type: 'text', text: lines[i] });
        }
    }
    return nodes;
}

/**
 * Recursively collect all Definition nodes in the MDAST tree.
 * Follows CommonMark precedence: the first definition for a given identifier takes precedence.
 */
export function collectDefinitions(
    node: Root | RootContent,
    definitions: Map<string, { url: string; title?: string }>,
): void {
    if (!node) return;
    if (node.type === 'definition') {
        const def = node as Definition;
        const normId = (def.identifier || def.label || '').trim().toLowerCase();
        if (normId && !definitions.has(normId)) {
            definitions.set(normId, {
                url: def.url || '',
                ...(def.title ? { title: def.title } : {}),
            });
        }
    }
    if ('children' in node && Array.isArray((node as any).children)) {
        for (const child of (node as any).children) {
            collectDefinitions(child, definitions);
        }
    }
}

/**
 * Adapt a single MDAST PhrasingContent node to Canonical InlineNode[].
 */
export function adaptPhrasingNode(
    node: PhrasingContent,
    ctx: MarkdownParseContext,
): InlineNode[] {
    switch (node.type) {
        case 'text':
            return textWithSoftBreaks(node.value);

        case 'strong': {
            const children = adaptInlines(node.children, ctx);
            return [{ type: 'strong', children }];
        }

        case 'emphasis': {
            const children = adaptInlines(node.children, ctx);
            return [{ type: 'emphasis', children }];
        }

        case 'delete': {
            const children = adaptInlines(node.children, ctx);
            return [{ type: 'strikethrough', children }];
        }

        case 'inlineCode':
            return [{ type: 'inlineCode', code: node.value }];

        case 'link': {
            const children = adaptInlines(node.children, ctx);
            const linkNode: LinkInline = {
                type: 'link',
                href: node.url,
                ...(node.title ? { title: node.title } : {}),
                children,
            };
            return [linkNode];
        }

        case 'linkReference': {
            const refNode = node as unknown as LinkReference;
            const normId = (refNode.identifier || refNode.label || '').trim().toLowerCase();
            const def = ctx.definitions?.get(normId);
            const children = adaptInlines(refNode.children || [], ctx);
            if (def) {
                const linkNode: LinkInline = {
                    type: 'link',
                    href: def.url,
                    ...(def.title ? { title: def.title } : {}),
                    children,
                };
                return [linkNode];
            }
            // Principle: unknown != disappear. Keep children / visible text, emit diagnostic.
            ctx.diagnostics.push({
                id: `missing-ref-def:${ctx.nextBlockId()}`,
                severity: 'warning',
                code: 'REFERENCE_DEFINITION_MISSING',
                message: `Missing definition for linkReference '[${refNode.label || refNode.identifier}]'`,
                sourceRef: ctx.sourceRef,
            });
            return children.length > 0 ? children : [{ type: 'text', text: `[${refNode.label || refNode.identifier}]` }];
        }

        case 'image': {
            const linked = linkInlineImage(node.url, node.alt || '', node.title || undefined, ctx);
            return [linked];
        }

        case 'imageReference': {
            const refNode = node as unknown as ImageReference;
            const normId = (refNode.identifier || refNode.label || '').trim().toLowerCase();
            const def = ctx.definitions?.get(normId);
            if (def) {
                const linked = linkInlineImage(def.url, refNode.alt || '', def.title || undefined, ctx);
                return [linked];
            }
            // Principle: unknown != disappear. Keep visible text fallback, emit diagnostic.
            ctx.diagnostics.push({
                id: `missing-img-def:${ctx.nextBlockId()}`,
                severity: 'warning',
                code: 'REFERENCE_DEFINITION_MISSING',
                message: `Missing definition for imageReference '![${refNode.alt || ''}][${refNode.label || refNode.identifier}]'`,
                sourceRef: ctx.sourceRef,
            });
            return [{ type: 'text', text: `![${refNode.alt || ''}][${refNode.label || refNode.identifier}]` }];
        }

        case 'break':
            return [{ type: 'lineBreak', kind: 'hard' }];

        case 'html': {
            if (/<br\s*\/?>/i.test(node.value)) {
                return [{ type: 'lineBreak', kind: 'hard' }];
            }
            return textWithSoftBreaks(node.value);
        }

        case 'inlineMath': {
            const val = (node as unknown as InlineMath).value || '';
            if (val.startsWith(' ') || val.endsWith(' ')) {
                return textWithSoftBreaks(`$${val}$`);
            }
            return [{
                type: 'inlineMath',
                source: val,
            }];
        }

        default: {
            const unknownNode = node as any;
            ctx.diagnostics.push({
                id: `unknown-inline:${ctx.nextBlockId()}`,
                severity: 'warning',
                code: 'MDAST_UNKNOWN_INLINE',
                message: `Encountered unsupported MDAST phrasing node type '${unknownNode?.type}'; preserved via fallback`,
                sourceRef: ctx.sourceRef,
                details: { nodeType: unknownNode?.type } as JsonValue,
            });

            const visibleText = (node: any): string => {
                if (node?.type === 'break') return '\n';
                const children = Array.isArray(node?.children) ? node.children.map(visibleText).join('') : '';
                if (children) return children;
                return [node?.value, node?.alt, node?.label, node?.identifier, node?.source, node?.code]
                    .find((value) => typeof value === 'string' && value.length > 0) || '';
            };
            return textWithSoftBreaks(visibleText(unknownNode) || `[Unsupported inline: ${unknownNode?.type || 'unknown'}]`);
        }
    }
}

/**
 * Adapt an array of MDAST PhrasingContent nodes into Canonical InlineNode[].
 */
export function adaptInlines(
    nodes: PhrasingContent[],
    ctx: MarkdownParseContext,
): InlineNode[] {
    const parseCtx: MarkdownParseContext = ctx.definitions
        ? ctx
        : { ...ctx, definitions: new Map() };
    const raw: InlineNode[] = [];
    for (const n of nodes) {
        raw.push(...adaptPhrasingNode(n, parseCtx));
    }
    return mergeAdjacentTextNodes(raw);
}

/**
 * Adapt a TableCell to Canonical { children: InlineNode[] }.
 */
function adaptTableCell(cell: MdastTableCell, ctx: MarkdownParseContext): { children: InlineNode[] } {
    return {
        children: adaptInlines(cell.children, ctx),
    };
}

/**
 * Adapt a TableRow to Canonical TableRow.
 */
function adaptTableRow(row: MdastTableRow, ctx: MarkdownParseContext): TableRow {
    return {
        cells: row.children.map((c) => adaptTableCell(c, ctx)),
    };
}

/**
 * Adapt a List item to Canonical ListItem.
 */
function adaptListItem(
    item: MdastListItem,
    ctx: MarkdownParseContext,
    rawMarkdown: string,
): ListItem {
    const blocks = adaptBlockNodes(item.children, ctx, rawMarkdown);

    // If GFM task list checkbox is present, prepend checkbox marker to first inline text
    if (item.checked !== null && item.checked !== undefined && blocks.length > 0) {
        const marker = item.checked ? '[x] ' : '[ ] ';
        const firstBlock = blocks[0];
        if (firstBlock.type === 'paragraph' && firstBlock.children.length > 0) {
            if (firstBlock.children[0].type === 'text') {
                firstBlock.children[0].text = marker + firstBlock.children[0].text;
            } else {
                firstBlock.children.unshift({ type: 'text', text: marker });
            }
        }
    }

    return { blocks };
}

/**
 * Checks if a standalone paragraph is actually a display math formula ($$...$$).
 */
function tryExtractDisplayMathParagraph(
    para: Paragraph,
    ctx: MarkdownParseContext,
    rawMarkdown: string,
): MathBlock | null {
    if (para.children.length !== 1) return null;
    const child = para.children[0];
    if (child.type !== 'inlineMath') return null;

    // Check if the original slice in raw markdown started with '$$'
    const pos = child.position;
    if (pos && pos.start.offset !== undefined) {
        const rawSlice = rawMarkdown.slice(pos.start.offset, pos.start.offset + 2);
        if (rawSlice === '$$') {
            const mathBlockId = ctx.nextBlockId();
            const source = (child as unknown as InlineMath).value || '';
            if (!source.trim()) {
                ctx.diagnostics.push({
                    id: `math-empty:${mathBlockId}`,
                    severity: 'warning',
                    code: 'MATH_BLOCK_EMPTY',
                    message: 'empty display-math fence; kept as source evidence',
                    sourceRef: ctx.sourceRef,
                });
            }
            return {
                id: mathBlockId,
                type: 'math',
                source,
            };
        }
    }
    return null;
}

/**
 * Adapt a single MDAST block content node to Canonical BlockNode[].
 */
export function adaptBlockNode(
    node: RootContent,
    ctx: MarkdownParseContext,
    rawMarkdown: string,
): BlockNode[] {
    switch (node.type) {
        case 'paragraph': {
            const mathBlock = tryExtractDisplayMathParagraph(node, ctx, rawMarkdown);
            if (mathBlock) return [mathBlock];

            const children = adaptInlines(node.children, ctx);
            if (children.length === 0) return [];
            return [{
                id: ctx.nextBlockId(),
                type: 'paragraph',
                children,
            }];
        }

        case 'heading': {
            const level = Math.min(6, Math.max(1, node.depth)) as 1 | 2 | 3 | 4 | 5 | 6;
            return [{
                id: ctx.nextBlockId(),
                type: 'heading',
                level,
                children: adaptInlines(node.children, ctx),
            }];
        }

        case 'thematicBreak':
            return [{
                id: ctx.nextBlockId(),
                type: 'thematicBreak',
            }];

        case 'blockquote':
            return [{
                id: ctx.nextBlockId(),
                type: 'quote',
                blocks: adaptBlockNodes(node.children, ctx, rawMarkdown),
            }];

        case 'list': {
            const ordered = Boolean(node.ordered);
            const items = node.children.map((it) => adaptListItem(it, ctx, rawMarkdown));
            return [{
                id: ctx.nextBlockId(),
                type: 'list',
                ordered,
                ...(ordered ? { start: typeof node.start === 'number' ? node.start : 1 } : {}),
                items,
            }];
        }

        case 'table': {
            const aligns: TableAlignment[] = (node.align || []).map((a) => {
                if (a === 'left') return 'left';
                if (a === 'center') return 'center';
                if (a === 'right') return 'right';
                return 'default';
            });
            const columns: TableColumn[] = aligns.map((align) => ({ align }));
            const headerRows: TableRow[] = node.children.length > 0
                ? [adaptTableRow(node.children[0], ctx)]
                : [];
            const rows: TableRow[] = node.children.slice(1).map((r) => adaptTableRow(r, ctx));
            return [{
                id: ctx.nextBlockId(),
                type: 'table',
                ...(columns.length ? { columns } : {}),
                ...(headerRows.length ? { headerRows } : {}),
                rows,
            }];
        }

        case 'code': {
            return [{
                id: ctx.nextBlockId(),
                type: 'code',
                code: node.value,
                ...(node.lang ? { language: node.lang } : {}),
                ...(node.meta ? { meta: node.meta } : {}),
            }];
        }

        case 'math': {
            const mathNode = node as unknown as MdastMath;
            const blockId = ctx.nextBlockId();
            let source = mathNode.value || '';
            if (mathNode.meta && mathNode.meta.trim()) {
                source = `${mathNode.meta.trim()}\n${source}`;
            }
            if (source.endsWith('$$') && source.length > 2) {
                source = source.slice(0, -2).trimEnd();
            }

            const startOffset = node.position?.start?.offset;
            const endOffset = node.position?.end?.offset;
            if (startOffset !== undefined && endOffset !== undefined) {
                const rawSlice = rawMarkdown.slice(startOffset, endOffset).trim();
                if (!rawSlice.endsWith('$$') || rawSlice === '$$') {
                    ctx.diagnostics.push({
                        id: `math-fence-unclosed:${blockId}`,
                        severity: 'warning',
                        code: 'MATH_FENCE_UNCLOSED',
                        message: 'display-math fence never closed; kept collected lines as the formula source',
                        sourceRef: ctx.sourceRef,
                        details: { line: rawSlice.slice(0, 80) } as JsonValue,
                    });
                }
            }

            if (!source.trim()) {
                const preview = startOffset !== undefined ? rawMarkdown.slice(startOffset, startOffset + 80) : '';
                ctx.diagnostics.push({
                    id: `math-empty:${blockId}`,
                    severity: 'warning',
                    code: 'MATH_BLOCK_EMPTY',
                    message: 'empty display-math fence; kept as source evidence',
                    sourceRef: ctx.sourceRef,
                    details: { line: preview } as JsonValue,
                });
            }

            return [{
                id: blockId,
                type: 'math',
                source,
            }];
        }

        case 'html': {
            if (/<hr\s*\/?>/i.test(node.value)) {
                return [{
                    id: ctx.nextBlockId(),
                    type: 'thematicBreak',
                }];
            }
            const children = textWithSoftBreaks(node.value);
            if (children.length === 0) return [];
            return [{
                id: ctx.nextBlockId(),
                type: 'paragraph',
                children,
            }];
        }

        case 'definition':
            // Link reference definitions are resolved into linkReference / imageReference inlines
            // and produce no visual block elements per CommonMark / GFM specification.
            return [];

        default: {
            const unknownNode = node as any;
            const blockId = ctx.nextBlockId();
            ctx.diagnostics.push({
                id: `unknown-block:${blockId}`,
                severity: 'warning',
                code: 'MDAST_UNKNOWN_BLOCK',
                message: `Encountered unsupported MDAST block node type '${unknownNode?.type}'; preserved via fallback`,
                sourceRef: ctx.sourceRef,
                details: { nodeType: unknownNode?.type } as JsonValue,
            });

            const visibleText = (value: any): string => {
                const ownText = [value?.value, value?.alt, value?.label, value?.identifier]
                    .find((text) => typeof text === 'string' && text.trim());
                if (ownText) return ownText;
                if (!Array.isArray(value?.children)) return '';
                const separator = value.type === 'paragraph' || value.type === 'heading' ? '' : '\n';
                return value.children.map(visibleText).filter((text: string) => text.trim()).join(separator);
            };
            const start = unknownNode.position?.start?.offset;
            const end = unknownNode.position?.end?.offset;
            const rawSlice = typeof start === 'number' && typeof end === 'number'
                ? rawMarkdown.slice(start, end).trim() : '';
            const sourceType = String(unknownNode?.type || 'unknown');
            const unknownBlock: UnknownBlock = {
                id: blockId,
                type: 'unknown',
                sourceType,
                text: rawSlice || visibleText(unknownNode) || `[Unsupported block: ${sourceType}]`,
            };
            return [unknownBlock];
        }
    }
}

/**
 * Adapt an array of MDAST block content nodes to Canonical BlockNode[].
 */
export function adaptBlockNodes(
    nodes: RootContent[],
    ctx: MarkdownParseContext,
    rawMarkdown: string,
): BlockNode[] {
    const blocks: BlockNode[] = [];
    for (const n of nodes) {
        blocks.push(...adaptBlockNode(n, ctx, rawMarkdown));
    }
    return blocks;
}

/**
 * Top-level adapter: converts an MDAST Root to Canonical BlockNode[].
 */
export function mdastRootToBlocks(
    root: Root,
    ctx: MarkdownParseContext,
    rawMarkdown: string,
): BlockNode[] {
    let parseCtx = ctx;
    if (!ctx.definitions) {
        const definitions = new Map<string, { url: string; title?: string }>();
        collectDefinitions(root, definitions);
        parseCtx = {
            ...ctx,
            definitions,
        };
    }
    return adaptBlockNodes(root.children, parseCtx, rawMarkdown);
}
