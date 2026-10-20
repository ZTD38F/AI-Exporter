import { assetPresentation, assetCaptionText } from '../canonical/assetPresentation.js';
import type { Asset } from '../canonical/assets.js';
import type {
    BlockNode,
    TableCell,
} from '../canonical/blocks.js';
import type {
    CanonicalConversationBundle,
    MessageNode,
} from '../canonical/conversation.js';
import { extractBlockText, extractInlineText } from '../canonical/unknownFallback.js';
import { getRendererStrings, type RendererStrings } from '../canonical/rendererStrings.js';
import { citationDisplayLabel } from '../canonical/citations.js';
import type { InlineNode } from '../canonical/inline.js';

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

export type TypstBlockNode =
    | { type: 'paragraph'; children: TypstInlineNode[] }
    | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: TypstInlineNode[] }
    | { type: 'list'; ordered: boolean; start?: number; items: TypstListItem[] }
    | { type: 'code'; language: string; text: string; filename?: string; meta?: string }
    | { type: 'math'; latex: string; typst?: string; fallbackLabel: string }
    | {
        type: 'table';
        headers: TypstTableCell[][];
        rows: TypstTableCell[][];
        aligns?: ('left' | 'center' | 'right')[];
        caption?: string;
    }
    | { type: 'image'; asset: string; caption?: string }
    | { type: 'file'; name: string; kind: string; size: string; description?: string }
    | { type: 'quote'; blocks: TypstBlockNode[] }
    | { type: 'note'; label?: string; children?: TypstInlineNode[]; blocks?: TypstBlockNode[] }
    | { type: 'thematicBreak' }
    | { type: 'unknown'; sourceType: string; label: string; fallback: string };

export interface TypstRenderMessage {
    id: string;
    role: 'user' | 'assistant';
    model?: string;
    plainText?: string;
    blocks: TypstBlockNode[];
}

export interface TypstConversationRenderPayload {
    schemaVersion: 1;
    title: string;
    provider: string;
    date: string;
    messageCount: number;
    messages: TypstRenderMessage[];
}

export interface TypstAdapterDiagnostic {
    severity: 'info' | 'warning' | 'error';
    code: string;
    message: string;
    path?: string;
}

export interface TypstPayloadOptions {
    assetPath(asset: Asset): string | undefined;
    convertMath?: (source: string, display: boolean) => string | undefined;
    locale?: 'zh' | 'en';
}

type RenderOptions = TypstPayloadOptions & { strings: RendererStrings };

export interface TypstPayloadResult {
    payload: TypstConversationRenderPayload;
    diagnostics: TypstAdapterDiagnostic[];
}

function unknownLabel(sourceType: string | undefined, strings: RendererStrings): string {
    return sourceType ? `${strings.unsupportedContent} · ${sourceType}` : strings.unsupportedContent;
}

function humanBytes(value: number | undefined, strings: RendererStrings): string {
    if (value == null || !Number.isFinite(value)) return strings.sizeUnknown;
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let n = value / 1024;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i += 1;
    }
    return `${n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${units[i]}`;
}

function mimeLabel(asset: Asset): string {
    const mime = asset.mimeType?.toLowerCase();
    if (mime) {
        const subtype = mime.split('/')[1];
        if (subtype) return subtype.replace(/^x-/, '').toUpperCase();
    }
    const name = asset.name ?? '';
    const dot = name.lastIndexOf('.');
    if (dot >= 0 && dot < name.length - 1) return name.slice(dot + 1).toUpperCase();
    return asset.kind.toUpperCase();
}

function renderInline(
    node: InlineNode,
    assets: Map<string, Asset>,
    citations: Map<string, { label: string; url?: string }>,
    options: RenderOptions,
    diagnostics: TypstAdapterDiagnostic[],
    path: string,
): TypstInlineNode {
    switch (node.type) {
        case 'text': return { type: 'text', text: node.text };
        case 'strong': return { type: 'strong', children: node.children.map(n => renderInline(n, assets, citations, options, diagnostics, path)) };
        case 'emphasis': return { type: 'emphasis', children: node.children.map(n => renderInline(n, assets, citations, options, diagnostics, path)) };
        case 'strikethrough': return { type: 'strikethrough', children: node.children.map(n => renderInline(n, assets, citations, options, diagnostics, path)) };
        case 'inlineCode': return { type: 'inlineCode', text: node.code };
        case 'link': return { type: 'link', url: node.href, children: node.children.map(n => renderInline(n, assets, citations, options, diagnostics, path)) };
        case 'image': {
            const asset = assets.get(node.assetId);
            const assetPath = asset ? options.assetPath(asset) : undefined;
            if (!asset || !assetPath) {
                diagnostics.push({ severity: 'warning', code: 'TYPST_V8_INLINE_IMAGE_MISSING', message: `Inline image asset ${node.assetId} unavailable to Typst; showing alt text.`, path });
                return { type: 'text', text: node.alt ?? asset?.name ?? `[image: ${node.assetId}]` };
            }
            return { type: 'image', asset: assetPath, ...(node.alt ? { alt: node.alt } : {}) };
        }
        case 'inlineMath': {
            const typst = options.convertMath?.(node.source, false);
            return typst
                ? { type: 'inlineMath', latex: node.source, typst }
                : { type: 'inlineMath', latex: node.source };
        }
        case 'citationRef': {
            const c = citations.get(node.citationId);
            const label = node.label ?? c?.label ?? `[${node.citationId}]`;
            return c?.url
                ? { type: 'link', url: c.url, children: [{ type: 'text', text: label }] }
                : { type: 'text', text: label };
        }
        case 'lineBreak': return { type: 'lineBreak' };
    }
}

function cellInline(cell: TableCell): InlineNode[] {
    return cell.children;
}

function renderBlock(
    block: BlockNode,
    assets: Map<string, Asset>,
    citations: Map<string, { label: string; url?: string }>,
    options: RenderOptions,
    diagnostics: TypstAdapterDiagnostic[],
    path: string,
): TypstBlockNode | null {
    const inline = (nodes: InlineNode[]) => nodes.map(n => renderInline(n, assets, citations, options, diagnostics, path));
    const inlineText = (nodes: InlineNode[]): string =>
        nodes.map(n => extractInlineText(n, { citationLabel: (id) => citations.get(id)?.label })).join('');
    const sub = (child: BlockNode, index: number, tag: string): TypstBlockNode | null =>
        renderBlock(child, assets, citations, options, diagnostics, `${path}/${tag}:${index}`);
    switch (block.type) {
        case 'paragraph': return { type: 'paragraph', children: inline(block.children) };
        case 'heading': {
            return { type: 'heading', level: block.level, children: inline(block.children) };
        }
        case 'list': {
            const items: TypstListItem[] = [];
            block.items.forEach((item, index) => {
                const kids: TypstBlockNode[] = [];
                item.blocks.forEach((child, childIndex) => {
                    const rendered = sub(child, childIndex, `list:${index}`);
                    if (rendered) kids.push(rendered);
                });
                items.push({ blocks: kids });
            });
            return {
                type: 'list',
                ordered: block.ordered,
                ...(block.start !== undefined ? { start: block.start } : {}),
                items,
            };
        }
        case 'quote': {
            const kids: TypstBlockNode[] = [];
            block.blocks.forEach((child, index) => {
                const rendered = sub(child, index, 'quote');
                if (rendered) kids.push(rendered);
            });
            return { type: 'quote', blocks: kids };
        }
        case 'code': return {
            type: 'code',
            language: block.language ?? 'text',
            text: block.code,
            ...(block.filename !== undefined ? { filename: block.filename } : {}),
            ...(block.meta !== undefined ? { meta: block.meta } : {}),
        };
        case 'math': {
            const typst = options.convertMath?.(block.source, true);
            const fallbackLabel = options.strings.mathFallback;
            return typst
                ? { type: 'math', latex: block.source, typst, fallbackLabel }
                : { type: 'math', latex: block.source, fallbackLabel };
        }
        case 'table': {
            const renderCell = (c: TableCell): TypstTableCell => ({
                children: inline(cellInline(c)),
                ...(c.colSpan && c.colSpan > 1 ? { colspan: c.colSpan } : {}),
                ...(c.rowSpan && c.rowSpan > 1 ? { rowspan: c.rowSpan } : {}),
            });
            const headers = (block.headerRows ?? []).map(row => row.cells.map(renderCell));
            const aligns = block.columns?.map(c => c.align === 'default' || !c.align ? 'left' : c.align);
            return {
                type: 'table',
                headers,
                rows: block.rows.map(row => row.cells.map(renderCell)),
                ...(aligns && aligns.length ? { aligns } : {}),
                ...(block.caption?.length ? { caption: inlineText(block.caption) } : {}),
            };
        }
        case 'image': {
            const asset = assets.get(block.assetId);
            const assetPath = asset ? options.assetPath(asset) : undefined;
            if (!asset || !assetPath) {
                diagnostics.push({ severity: 'warning', code: 'TYPST_V8_IMAGE_MISSING', message: `Image asset ${block.assetId} unavailable to Typst.`, path });
                return { type: 'unknown', sourceType: 'missing-image', label: unknownLabel('missing-image', options.strings), fallback: assetPresentation(asset, assetCaptionText(block.caption) ?? block.alt).label };
            }
            const caption = assetPresentation(asset, block.caption?.length ? inlineText(block.caption) : block.alt).caption;
            return { type: 'image', asset: assetPath, ...(caption ? { caption } : {}) };
        }
        case 'file': {
            const asset = assets.get(block.assetId);
            if (!asset) return { type: 'unknown', sourceType: 'missing-file', label: unknownLabel('missing-file', options.strings), fallback: assetPresentation(asset, block.label, 'Attachment').label };
            return {
                type: 'file',
                name: assetPresentation(asset, block.label, 'Attachment').label,
                kind: mimeLabel(asset),
                size: humanBytes(asset.sizeBytes, options.strings),
                ...(block.description?.length ? { description: inlineText(block.description) } : {}),
            };
        }
        case 'thought': {
            const kids: TypstBlockNode[] = [];
            block.blocks.forEach((child, index) => {
                const rendered = sub(child, index, 'thought');
                if (rendered) kids.push(rendered);
            });
            const label = block.kind === 'summary' ? options.strings.thinkingSummary
                : block.kind === 'progress' ? options.strings.thinkingProgress
                : block.kind === 'reasoning' ? options.strings.thinkingProcess
                : undefined;
            return { type: 'note', ...(label ? { label } : {}), blocks: kids };
        }
        case 'thematicBreak': return { type: 'thematicBreak' };
        case 'unknown': {
            return { type: 'unknown', sourceType: block.sourceType, label: unknownLabel(block.sourceType, options.strings), fallback: block.text };
        }
    }
}

function rolePrefix(message: MessageNode, strings: RendererStrings): string | undefined {
    if (message.role === 'system') return strings.systemMessage;
    if (message.role === 'developer') return strings.developerMessage;
    if (message.role === 'unknown') return message.author?.rawRole ? `${strings.unknownRole}: ${message.author.rawRole}` : strings.unknownRole;
    return undefined;
}

function toRenderMessage(
    message: MessageNode,
    bundle: CanonicalConversationBundle,
    assets: Map<string, Asset>,
    citations: Map<string, { label: string; url?: string }>,
    options: RenderOptions,
    diagnostics: TypstAdapterDiagnostic[],
): TypstRenderMessage {
    const blocks: TypstBlockNode[] = [];
    const prefix = rolePrefix(message, options.strings);
    if (prefix) blocks.push({ type: 'note', children: [{ type: 'text', text: prefix }] });
    message.blocks.forEach((block, index) => {
        const mapped = renderBlock(block, assets, citations, options, diagnostics, `message:${message.id}/block:${index}`);
        if (mapped) blocks.push(mapped);
    });
    if (message.citationIds?.length) {
        const text = message.citationIds.map(id => citations.get(id)?.label ?? id).join(' · ');
        blocks.push({
            type: 'note',
            children: [{ type: 'text', text: text || options.strings.sources }],
        });
    }
    const plainText = message.blocks
        .map(b => extractBlockText(b, { citationLabel: (id) => citations.get(id)?.label }))
        .join('\n');
    return {
        id: message.id,
        role: message.role === 'user' ? 'user' : 'assistant',
        ...(message.author?.model ? { model: message.author.model } : {}),
        ...(plainText ? { plainText } : {}),
        blocks,
    };
}

export function toTypstPayload(
    bundle: CanonicalConversationBundle,
    options: TypstPayloadOptions,
): TypstPayloadResult {
    const diagnostics: TypstAdapterDiagnostic[] = [];
    const strings = getRendererStrings(options.locale ?? 'en');
    const renderOptions: RenderOptions = { ...options, strings };
    const assets = new Map(bundle.assets.map(asset => [asset.id, asset]));
    const citations = new Map(bundle.citations.map((citation, index) => [citation.id, {
        label: citationDisplayLabel(citation, index + 1),
        url: citation.url,
    }]));
    const messages = bundle.conversation.messages
        .map(message => toRenderMessage(message, bundle, assets, citations, renderOptions, diagnostics));

    const observed = bundle.conversation.updatedAt ?? bundle.conversation.createdAt ?? '';
    const date = observed ? observed.slice(0, 10) : strings.dateUnknown;

    return {
        payload: {
            schemaVersion: 1,
            title: bundle.conversation.title ?? 'Untitled conversation',
            provider: bundle.conversation.key.providerId,
            date,
            messageCount: messages.length,
            messages,
        },
        diagnostics,
    };
}
