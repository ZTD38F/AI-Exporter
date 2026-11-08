
import type {
    Root,
    RootContent,
    PhrasingContent,
    Paragraph,
    ListItem as MdastListItem,
    TableRow as MdastTableRow,
    TableCell as MdastTableCell,
} from 'mdast';
// Register math nodes in MDAST's discriminated unions without a runtime import.
import type {} from 'mdast-util-math';
import type {
    BlockNode,
    ListItem,
    MathBlock,
    TableColumn,
    TableRow,
    UnknownBlock,
} from '../../../../l2/content/blocks.js';
import type { ImageInline, InlineNode, LinkInline } from '../../../../l2/content/inline.js';
import type { Diagnostic, SourceRef } from '../../../../shared/diagnostics/diagnostic.js';

/** Provider-neutral parsing hooks; asset ownership stays with the caller. */
export interface MarkdownParseContext {
    diagnostics: Diagnostic[];
    sourceRef: SourceRef;
    resolveImage?(ref: string, alt: string, title?: string): ImageInline;
    path?: string;
    definitions?: Map<string, { url: string; title?: string }>;
    /** Provider dialect: $$ on its own line remains display math beside prose. */
    lineStartDisplayMath?: boolean;
    /** Retain the physical line ending before a fenced code closing marker. */
    preserveCodeFenceFinalNewline?: boolean;
}

function imageInline(ref: string, alt: string, title: string | undefined, ctx: MarkdownParseContext): ImageInline {
    return ctx.resolveImage?.(ref, alt, title) ?? {
        type: 'image', assetId: ref,
        ...(alt.trim() ? { alt: alt.trim() } : {}),
        ...(title ? { title } : {}),
    };
}

export function mergeAdjacentTextNodes(nodes: InlineNode[]): InlineNode[] {
    const result: InlineNode[] = [];
    for (const node of nodes) {
        if ('children' in node && Array.isArray(node.children)) {
            const mergedChildren = mergeAdjacentTextNodes(node.children);
            result.push({ ...node, children: mergedChildren });
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
 * Follows CommonMark precedence: the first definition for a given identifier takes precedence.
 */
export function collectDefinitions(
    node: Root | RootContent,
    definitions: Map<string, { url: string; title?: string }>,
): void {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'definition') {
        const def = node;
        const normId = (def.identifier || def.label || '').trim().toLowerCase();
        if (normId && !definitions.has(normId)) {
            definitions.set(normId, {
                url: def.url || '',
                ...(def.title ? { title: def.title } : {}),
            });
        }
    }
    if ('children' in node && Array.isArray(node.children)) {
        for (const child of node.children) {
            collectDefinitions(child, definitions);
        }
    }
}

/** Unknown extension nodes retain visible text without trusting their shape. */
function isNodeRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nodeRecord(value: unknown): Record<string, unknown> {
    return isNodeRecord(value) ? value : {};
}

function unknownInlineText(value: unknown): string {
    const node = nodeRecord(value);
    if (node.type === 'break') return '\n';
    const children: unknown[] = Array.isArray(node.children) ? node.children : [];
    const childText = children.map(unknownInlineText).join('');
    if (childText) return childText;
    return [node.value, node.alt, node.label, node.identifier, node.source, node.code]
        .find((text): text is string => typeof text === 'string' && text.length > 0) || '';
}

function unknownBlockText(value: unknown): string {
    const node = nodeRecord(value);
    const ownText = [node.value, node.alt, node.label, node.identifier]
        .find((text): text is string => typeof text === 'string' && text.trim().length > 0);
    if (ownText) return ownText;
    const children: unknown[] = Array.isArray(node.children) ? node.children : [];
    const separator = node.type === 'paragraph' || node.type === 'heading' ? '' : '\n';
    return children.map(unknownBlockText).filter(text => text.trim()).join(separator);
}

function adaptPhrasingNode(
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
            const refNode = node;
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
                id: `missing-ref-def:${ctx.sourceRef.locator}:${ctx.diagnostics.length}`,
                severity: 'warning',
                code: 'REFERENCE_DEFINITION_MISSING',
                message: `Missing definition for linkReference '[${refNode.label || refNode.identifier}]'`,
                sourceRef: ctx.sourceRef,
                path: ctx.path,
            });
            return children.length > 0 ? children : [{ type: 'text', text: `[${refNode.label || refNode.identifier}]` }];
        }

        case 'image': {
            const linked = imageInline(node.url, node.alt || '', node.title || undefined, ctx);
            return [linked];
        }

        case 'imageReference': {
            const refNode = node;
            const normId = (refNode.identifier || refNode.label || '').trim().toLowerCase();
            const def = ctx.definitions?.get(normId);
            if (def) {
                const linked = imageInline(def.url, refNode.alt || '', def.title || undefined, ctx);
                return [linked];
            }
            // Principle: unknown != disappear. Keep visible text fallback, emit diagnostic.
            ctx.diagnostics.push({
                id: `missing-img-def:${ctx.sourceRef.locator}:${ctx.diagnostics.length}`,
                severity: 'warning',
                code: 'REFERENCE_DEFINITION_MISSING',
                message: `Missing definition for imageReference '![${refNode.alt || ''}][${refNode.label || refNode.identifier}]'`,
                sourceRef: ctx.sourceRef,
                path: ctx.path,
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
            const val = node.value || '';
            if (val.startsWith(' ') || val.endsWith(' ')) {
                return textWithSoftBreaks(`$${val}$`);
            }
            return [{
                type: 'inlineMath',
                source: val,
            }];
        }

        default: {
            const unknownNode = nodeRecord(node);
            const nodeType = typeof unknownNode.type === 'string' ? unknownNode.type : 'unknown';
            ctx.diagnostics.push({
                id: `unknown-inline:${ctx.sourceRef.locator}:${ctx.diagnostics.length}`,
                severity: 'warning',
                code: 'MDAST_UNKNOWN_INLINE',
                message: `Encountered unsupported MDAST phrasing node type '${nodeType}'; preserved via fallback`,
                sourceRef: ctx.sourceRef,
                path: ctx.path,
                details: { nodeType },
            });

            return textWithSoftBreaks(unknownInlineText(unknownNode) || `[Unsupported inline: ${nodeType || 'unknown'}]`);
        }
    }
}

export function adaptInlines(
    nodes: PhrasingContent[],
    ctx: MarkdownParseContext,
): InlineNode[] {
    const parseCtx: MarkdownParseContext = ctx.definitions
        ? ctx
        : { ...ctx, definitions: new Map() };
    const raw: InlineNode[] = [];
    for (const [index, n] of nodes.entries()) {
        raw.push(...adaptPhrasingNode(n, { ...parseCtx, path: `${ctx.path}.children[${index}]` }));
    }
    return mergeAdjacentTextNodes(raw);
}

function adaptTableCell(cell: MdastTableCell, ctx: MarkdownParseContext): { children: InlineNode[] } {
    return {
        children: adaptInlines(cell.children, ctx),
    };
}

function adaptTableRow(row: MdastTableRow, ctx: MarkdownParseContext): TableRow {
    return {
        cells: row.children.map((c) => adaptTableCell(c, ctx)),
    };
}

function adaptListItem(
    item: MdastListItem,
    ctx: MarkdownParseContext,
    rawMarkdown: string,
): ListItem {
    const blocks = adaptBlockNodes(item.children, { ...ctx, path: `${ctx.path}.blocks` }, rawMarkdown);

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

function tryExtractDisplayMathParagraph(
    para: Paragraph,
    ctx: MarkdownParseContext,
    rawMarkdown: string,
): MathBlock | null {
    if (para.children.length !== 1) return null;
    const child = para.children[0];
    if (child.type !== 'inlineMath') return null;

    const pos = child.position;
    if (pos && pos.start.offset !== undefined) {
        const rawSlice = rawMarkdown.slice(pos.start.offset, pos.start.offset + 2);
        if (rawSlice === '$$') {
            const source = child.value || '';
            if (!source.trim()) {
                ctx.diagnostics.push({
                    id: `math-empty:${ctx.sourceRef.locator}:${ctx.diagnostics.length}`,
                    severity: 'warning',
                    code: 'MATH_BLOCK_EMPTY',
                    message: 'empty display-math fence; kept as source evidence',
                    sourceRef: ctx.sourceRef,
                    path: ctx.path,
                });
            }
            return {
                type: 'math',
                source,
            };
        }
    }
    return null;
}

function adaptBlockNode(
    node: RootContent,
    ctx: MarkdownParseContext,
    rawMarkdown: string,
): BlockNode[] {
    switch (node.type) {
        case 'paragraph': {
            const mathBlock = tryExtractDisplayMathParagraph(node, ctx, rawMarkdown);
            if (mathBlock) return [mathBlock];

            if (ctx.lineStartDisplayMath) {
                const blocks: BlockNode[] = [];
                let pending: PhrasingContent[] = [];
                const flush = (): void => {
                    if (pending.some(child => child.type !== 'text' || child.value.trim())) {
                        blocks.push({ type: 'paragraph', children: adaptInlines(pending, ctx) });
                    }
                    pending = [];
                };
                for (const child of node.children) {
                    const at = child.position?.start.offset;
                    const end = child.position?.end.offset;
                    const line = at === undefined ? '' : rawMarkdown.slice(rawMarkdown.lastIndexOf('\n', at - 1) + 1, at);
                    const nextLine = end === undefined ? -1 : rawMarkdown.indexOf('\n', end);
                    const tail = end === undefined ? null : rawMarkdown.slice(end, nextLine < 0 ? undefined : nextLine);
                    if (child.type === 'inlineMath' && at !== undefined && tail !== null && /^[ \t]*$/.test(tail) && /^[ \t>]*$/.test(line)
                        && rawMarkdown.slice(at, at + 2) === '$$') {
                        flush();
                        blocks.push({ type: 'math', source: child.value });
                    } else pending.push(child);
                }
                flush();
                return blocks;
            }

            const children = adaptInlines(node.children, ctx);
            if (children.length === 0) return [];
            return [{
                type: 'paragraph',
                children,
            }];
        }

        case 'heading': {
            const level = node.depth < 1 ? 1 : node.depth > 6 ? 6 : node.depth;
            return [{
                type: 'heading',
                level,
                children: adaptInlines(node.children, ctx),
            }];
        }

        case 'thematicBreak':
            return [{
                type: 'thematicBreak',
            }];

        case 'blockquote':
            return [{
                type: 'quote',
                blocks: adaptBlockNodes(node.children, { ...ctx, path: `${ctx.path}.blocks` }, rawMarkdown),
            }];

        case 'list': {
            const ordered = Boolean(node.ordered);
            const items = node.children.map((it, index) => adaptListItem(it, { ...ctx, path: `${ctx.path}.items[${index}]` }, rawMarkdown));
            return [{
                type: 'list',
                ordered,
                ...(ordered ? { start: node.start ?? 1 } : {}),
                items,
            }];
        }

        case 'table': {
            const columns: TableColumn[] = (node.align ?? []).map(align => align ? { align } : {});
            const headerRows: TableRow[] = node.children.length > 0
                ? [adaptTableRow(node.children[0], ctx)]
                : [];
            const rows: TableRow[] = node.children.slice(1).map((r) => adaptTableRow(r, ctx));
            return [{
                type: 'table',
                ...(columns.length ? { columns } : {}),
                ...(headerRows.length ? { headerRows } : {}),
                rows,
            }];
        }

        case 'code': {
            const start = node.position?.start.offset;
            const end = node.position?.end.offset;
            const raw = start === undefined || end === undefined ? '' : rawMarkdown.slice(start, end);
            const opening = /^[ \t]*(`{3,}|~{3,})/.exec(raw)?.[1];
            const closing = opening && raw.indexOf('\n') < raw.lastIndexOf('\n')
                && new RegExp(`\\n[ \\t>]*${opening[0]}{${opening.length},}[ \\t]*$`).test(raw);
            return [{
                type: 'code',
                code: node.value + (ctx.preserveCodeFenceFinalNewline && closing ? '\n' : ''),
                ...(node.lang ? { language: node.lang } : {}),
                ...(node.meta ? { meta: node.meta } : {}),
            }];
        }

        case 'math': {
            const mathNode = node;
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
                        id: `math-fence-unclosed:${ctx.sourceRef.locator}:${ctx.diagnostics.length}`,
                        severity: 'warning',
                        code: 'MATH_FENCE_UNCLOSED',
                        message: 'display-math fence never closed; kept collected lines as the formula source',
                        sourceRef: ctx.sourceRef,
                        path: ctx.path,
                        details: { line: rawSlice.slice(0, 80) },
                    });
                }
            }

            if (!source.trim()) {
                const preview = startOffset !== undefined ? rawMarkdown.slice(startOffset, startOffset + 80) : '';
                ctx.diagnostics.push({
                    id: `math-empty:${ctx.sourceRef.locator}:${ctx.diagnostics.length}`,
                    severity: 'warning',
                    code: 'MATH_BLOCK_EMPTY',
                    message: 'empty display-math fence; kept as source evidence',
                    sourceRef: ctx.sourceRef,
                    path: ctx.path,
                    details: { line: preview },
                });
            }

            return [{
                type: 'math',
                source,
            }];
        }

        case 'html': {
            if (/^\s*<hr\b[^>]*>\s*$/i.test(node.value)) {
                return [{
                    type: 'thematicBreak',
                }];
            }
            const children = textWithSoftBreaks(node.value);
            if (children.length === 0) return [];
            return [{
                type: 'paragraph',
                children,
            }];
        }

        case 'definition':
            // Link reference definitions are resolved into linkReference / imageReference inlines
            // and produce no visual block elements per CommonMark / GFM specification.
            return [];

        default: {
            const unknownNode = nodeRecord(node);
            const nodeType = typeof unknownNode.type === 'string' ? unknownNode.type : 'unknown';
            ctx.diagnostics.push({
                id: `unknown-block:${ctx.sourceRef.locator}:${ctx.diagnostics.length}`,
                severity: 'warning',
                code: 'MDAST_UNKNOWN_BLOCK',
                message: `Encountered unsupported MDAST block node type '${nodeType}'; preserved via fallback`,
                sourceRef: ctx.sourceRef,
                path: ctx.path,
                details: { nodeType },
            });

            const position = nodeRecord(unknownNode.position);
            const start = nodeRecord(position.start).offset;
            const end = nodeRecord(position.end).offset;
            const rawSlice = typeof start === 'number' && typeof end === 'number'
                ? rawMarkdown.slice(start, end).trim() : '';
            const sourceType = nodeType || 'unknown';
            const unknownBlock: UnknownBlock = {
                type: 'unknown',
                sourceType,
                text: rawSlice || unknownBlockText(unknownNode) || `[Unsupported block: ${sourceType}]`,
            };
            return [unknownBlock];
        }
    }
}

function adaptBlockNodes(
    nodes: RootContent[],
    ctx: MarkdownParseContext,
    rawMarkdown: string,
): BlockNode[] {
    const blocks: BlockNode[] = [];
    for (const n of nodes) {
        blocks.push(...adaptBlockNode(n, { ...ctx, path: `${ctx.path}[${blocks.length}]` }, rawMarkdown));
    }
    return blocks;
}

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
    return adaptBlockNodes(root.children, { ...parseCtx, path: ctx.path ?? `${ctx.sourceRef.locator}.blocks` }, rawMarkdown);
}
