import type { DisplayBlock, DisplayCell, DisplayInline, DocumentAst } from '../../../l3b/ast/ast.js';
import type { ResourceBindings } from '../../packaging/resourceBindings.js';
import { visual } from '../shared/visualContract.js';
import { blockText, inlineText, codeHeader, fileBadge, humanBytes, headerMetadata, sourceLabel, unavailableResourceText } from '../shared/backendPresentation.js';
import { getRendererStrings } from '../shared/renderStrings.js';
import { isResourcePath } from '../shared/resourcePath.js';
import type { RendererOptions } from '../shared/renderOptions.js';
import type { Diagnostic } from '../../../shared/diagnostics/diagnostic.js';
import { safeExternalHref } from '../shared/safeLinks.js';
import { defaultPdfLayout, applyLayout } from './layout.js';
import type { TypstBlockNode, TypstConversationRenderPayload, TypstInlineNode, TypstTableCell, BlockLayout, TypstRenderMessage } from './transport.js';

/** Internal technical hooks; no format-specific controls in the public Renderer. */
interface TypstRuntimeHooks {
    convertMath?: (source: string, display: boolean) => string | undefined;
    onDiagnostic?: (diagnostic: Diagnostic) => void;
}

export function renderDocumentTypstCore(
    document: DocumentAst,
    resources: ResourceBindings,
    options: RendererOptions = {},
    runtime: TypstRuntimeHooks = {},
): TypstConversationRenderPayload {
    const locale = options.locale ?? 'en';
    const strings = getRendererStrings(locale);
    const resource = (id: string): string => {
        const path = resources[id];
        if (!path) throw new TypeError(`Missing prepared resource binding: ${id}`);
        return path;
    };
    const inline = (node: DisplayInline): TypstInlineNode => {
        switch (node.type) {
            case 'text': return { type: 'text', text: node.text };
            case 'strong': case 'emphasis': case 'strikethrough': return { type: node.type, children: node.children.map(inline) };
            case 'inlineCode': return { type: 'inlineCode', text: node.code };
            case 'link': {
                const href = safeExternalHref(node.href);
                const children = node.children.map(inline);
                return href ? { type: 'link', url: href, children } : { type: 'text', text: node.children.map(inlineText).join('') };
            }
            case 'citation': {
                const href = safeExternalHref(node.href);
                return href ? { type: 'link', url: href, children: [{ type: 'text', text: node.label }] } : { type: 'text', text: node.label };
            }
            case 'image':
                if (!isResourcePath(resources[node.resourceId])) runtime.onDiagnostic?.({ severity: 'warning', code: 'TYPST_V8_INLINE_IMAGE_MISSING', message: `Missing prepared image ${node.resourceId}` });
                return isResourcePath(resources[node.resourceId]) ? { type: 'image', asset: resource(node.resourceId), ...(node.alt ? { alt: node.alt } : {}) } : { type: 'text', text: unavailableResourceText('image', node.alt, locale, options.resourceFailures?.[node.resourceId]) };
            case 'lineBreak': return { type: 'lineBreak' };
            case 'inlineMath': {
                const typst = runtime.convertMath?.(node.source, false);
                return { type: 'inlineMath', latex: node.source, ...(typst ? { typst } : {}) };
            }
        }
    };
    const missing = (kind: 'image' | 'file', label: string, id: string, details?: DisplayInline[]): TypstBlockNode => {
        runtime.onDiagnostic?.({ severity: 'warning', code: 'TYPST_V8_IMAGE_MISSING', message: `Missing prepared ${kind} resource` });
        const source = safeExternalHref(options.resourceFailures?.[id]?.sourceUrl ?? '');
        const detailNodes: TypstInlineNode[] = details?.map(inline) ?? [];
        if (source) detailNodes.push({ type: 'link', url: source, children: [{ type: 'text', text: locale === 'zh' ? '查看来源' : 'Open source' }] });
        return ({ type: 'unknown', sourceType: `missing-${kind}`, label: unavailableResourceText(kind, '', locale, options.resourceFailures?.[id]), fallback: label, ...(detailNodes.length ? { details: detailNodes } : {}), layout: { gapBeforePt: 0, keepWithNext: false, width: 'reading' } });
    };
    const block = (node: DisplayBlock): TypstBlockNode => {
        const layout: BlockLayout = { gapBeforePt: 0, keepWithNext: false, width: 'full' };
        switch (node.type) {
            case 'paragraph': return { type: 'paragraph', children: node.children.map(inline), layout };
            case 'heading': return { type: 'heading', level: node.level, children: node.children.map(inline), layout };
            case 'list': return { type: 'list', ordered: node.ordered, ...(node.start !== undefined ? { start: node.start } : {}), items: node.items.map(item => ({ blocks: item.blocks.map(block) })), layout };
            case 'quote': return { type: 'quote', blocks: node.blocks.map(block), layout };
            case 'code': return { type: 'code', language: node.language ?? 'text', header: codeHeader(node, 'pdf'), text: node.code, layout };
            case 'math': {
                const typst = runtime.convertMath?.(node.source, true);
                return { type: 'math', latex: node.source, ...(typst ? { typst } : {}), fallbackLabel: strings.mathFallback, layout };
            }
            case 'table': {
                const cell = (entry: DisplayCell): TypstTableCell => ({ children: entry.children.map(inline), ...(entry.colSpan > 1 ? { colspan: entry.colSpan } : {}), ...(entry.rowSpan > 1 ? { rowspan: entry.rowSpan } : {}) });
                return { type: 'table', headers: node.headerRows.map(row => row.map(cell)), rows: node.rows.map(row => row.map(cell)), columnCount: node.columnAlignments.length, aligns: node.columnAlignments.map(align => align === 'default' ? 'left' : align), repeatHeader: true, ...(node.caption?.length ? { caption: node.caption.map(inline) } : {}), layout };
            }
            case 'image': return isResourcePath(resources[node.resourceId]) ? { type: 'image', asset: resource(node.resourceId), ...(node.caption?.length ? { caption: node.caption.map(inline) } : {}), layout } : missing('image', node.alt, node.resourceId, node.caption);
            case 'file': {
                if (options.resourceFailures?.[node.resourceId]) return missing('file', node.label, node.resourceId, node.description);
                const kind = fileBadge(node), size = humanBytes(node.byteLength, strings.sizeUnknown);
                return { type: 'file', name: node.label, kind, size, metadata: `${kind} · ${size}`, ...(node.description?.length ? { description: node.description.map(inline) } : {}), layout };
            }
            case 'unsupported': return { type: 'unknown', sourceType: node.sourceType, label: `${strings.unsupportedContent} · ${node.sourceType}`, fallback: node.text, layout };
            case 'thematicBreak': return { type: 'thematicBreak', layout };
            case 'disclosure': return { type: 'note', label: node.title, blocks: node.blocks.map(block), layout };
        }
    };
    return {
        schemaVersion: 1, profile: { id: 'pdf', version: 1 }, title: document.title, metadata: headerMetadata(document, locale, true) + (!document.messages.length ? ` · ${strings.emptyConversation}` : ''),
        layout: structuredClone(defaultPdfLayout()),
        messages: document.messages.map((message, index) => {
            const blocks = message.blocks.map(block);
            const prefix = message.role === 'system' ? strings.systemMessage : message.role === 'developer' ? strings.developerMessage : message.role === 'unknown' ? strings.unknownRole : undefined;
            if (prefix) blocks.unshift({ type: 'note', children: [{ type: 'text', text: prefix }], layout: { gapBeforePt: 0, keepWithNext: false, width: 'reading' } });
            if (message.sources?.length) blocks.push({ type: 'note', label: strings.sources, children: message.sources.flatMap((item, index): TypstInlineNode[] => {
                const href = safeExternalHref(item.href);
                const nodes: TypstInlineNode[] = index ? [{ type: 'lineBreak' }] : [];
                nodes.push(href ? { type: 'link', url: href, children: [{ type: 'text', text: sourceLabel(item) }] } : { type: 'text', text: sourceLabel(item) });
                return nodes;
            }), layout: { gapBeforePt: 0, keepWithNext: false, width: 'reading' } });
            const variant: TypstRenderMessage['variant'] = message.role === 'user' ? 'bubble' : 'flow';
            applyLayout(blocks, variant === 'bubble', false);
            const next = document.messages[index + 1];
            return { id: 'msg-' + index, variant, ...(message.modelLabel ? { model: message.modelLabel } : {}), plainText: message.blocks.map(blockText).join('\n'), minWidthCards: blocks.flatMap(node => node.type === 'file' ? [{ label: node.name, metadata: node.metadata }] : []), gapAfterPt: next ? (variant === 'flow' && next.role === 'user' ? visual.spacing.turn : visual.spacing.section) * 0.75 : 0, blocks };
        }),
    };
}
