import { resourceLabel } from './resourcePresentation.js';
import type { DeepReadonly } from '../../l2/readonly.js';
import type { BlockNode, TableBlock } from '../../l2/content/blocks.js';
import { tableCellPlacements } from '../../l2/content/tableLayout.js';
import type { InlineNode } from '../../l2/content/inline.js';
import type { DomainAsset } from '../../l2/conversationDetail.js';
import type { DisplayBlock, DisplayCell, DisplayInline } from '../ast/ast.js';

/** Shared logical content composition; callers provide resolved semantic relationships. */
export function contentComposer(assets: ReadonlyMap<string, DeepReadonly<DomainAsset>>, source: (id: string, explicit?: string) => { id: string; label: string; href?: string }): (nodes: DeepReadonly<BlockNode[]>) => DisplayBlock[] {
    const label = (id: string, explicit?: string, kind: 'image' | 'file' = 'image'): string => resourceLabel(explicit, assets.get(id)?.name, kind);
    const inlines = (nodes: DeepReadonly<InlineNode[]>): DisplayInline[] => nodes.map(node => {
        switch (node.type) {
            case 'text': return { type: 'text', text: node.text };
            case 'strong': case 'emphasis': case 'strikethrough': return { type: node.type, children: inlines(node.children) };
            case 'inlineCode': return { type: 'inlineCode', code: node.code };
            case 'link': return { type: 'link', href: node.href, ...(node.title !== undefined ? { title: node.title } : {}), children: inlines(node.children) };
            case 'inlineMath': return { type: 'inlineMath', source: node.source };
            case 'lineBreak': return { type: 'lineBreak', kind: node.kind };
            case 'citationRef': return { type: 'citation', ...source(node.citationId, node.label) };
            case 'image': return { type: 'image', resourceId: node.assetId, alt: label(node.assetId, node.alt), ...(node.title !== undefined ? { title: node.title } : {}) };
        }
    });
    const table = (node: DeepReadonly<TableBlock>): DisplayBlock => {
        const rows: DisplayCell[][] = [...(node.headerRows ?? []), ...node.rows].map(() => []);
        let width = node.columns?.length ?? 0;
        for (const { cell, rowIndex, column, colSpan, rowSpan } of tableCellPlacements(node)) {
            rows[rowIndex].push({ column, colSpan, rowSpan, children: inlines(cell.children) });
            width = Math.max(width, column + colSpan);
        }
        return { type: 'table', columnAlignments: Array.from({ length: width }, (_, column) => node.columns?.[column]?.align ?? 'default'), ...(node.caption ? { caption: inlines(node.caption) } : {}), headerRows: rows.slice(0, node.headerRows?.length ?? 0), rows: rows.slice(node.headerRows?.length ?? 0) };
    };
    const blocks = (nodes: DeepReadonly<BlockNode[]>): DisplayBlock[] => nodes.map(node => {
        switch (node.type) {
            case 'paragraph': return { type: 'paragraph', children: inlines(node.children) };
            case 'heading': return { type: 'heading', level: node.level, children: inlines(node.children) };
            case 'list': return { type: 'list', ordered: node.ordered, ...(node.start !== undefined ? { start: node.start } : {}), items: node.items.map(item => ({ blocks: blocks(item.blocks) })) };
            case 'quote': return { type: 'quote', blocks: blocks(node.blocks) };
            case 'code': return { type: 'code', code: node.code, ...(node.language !== undefined ? { language: node.language } : {}), ...(node.meta !== undefined ? { meta: node.meta } : {}) };
            case 'math': return { type: 'math', source: node.source };
            case 'table': return table(node);
            case 'image':
                return {
                    type: 'image', resourceId: node.assetId, alt: label(node.assetId, node.alt),
                    ...(node.caption !== undefined ? { caption: inlines(node.caption) } : {}),
                };
            case 'file': {
                const asset = assets.get(node.assetId);
                if (!asset) throw new TypeError(`Unresolved Domain asset: ${node.assetId}`);
                const name = label(node.assetId, node.label, 'file');
                const description = node.description ? inlines(node.description) : undefined;
                return { type: 'file', resourceId: node.assetId, label: name, kind: asset.kind, ...(asset.mediaType !== undefined ? { mediaType: asset.mediaType } : {}), ...(asset.byteLength !== undefined ? { byteLength: asset.byteLength } : {}), ...(description ? { description } : {}) };
            }
            case 'thematicBreak': return { type: 'thematicBreak' };
            case 'unknown': return { type: 'unsupported', sourceType: node.sourceType, text: node.text };
        }
    });
    return blocks;
}
