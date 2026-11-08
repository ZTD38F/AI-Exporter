import type { BlockNode, ListItem, TableCell, TableRow } from './blocks.js';
import type { InlineNode } from './inline.js';

type MappableNode = BlockNode | InlineNode | TableRow | TableCell | ListItem;

/** Bind semantic resource references to export asset identities without interpreting body syntax. */
export function mapContentAssetReferences(
    blocks: BlockNode[],
    resolve: (ref: string, kind: 'image' | 'file', alt?: string, title?: string) => string,
): BlockNode[] {
    const mapArray = <T extends MappableNode>(values: T[], map: (value: T) => T): T[] => {
        const mapped = values.map(map);
        return mapped.every((value, index) => value === values[index]) ? values : mapped;
    };
    const inline = (node: InlineNode): InlineNode => {
        if (node.type === 'image') {
            const assetId = resolve(node.assetId, 'image', node.alt, node.title);
            return assetId === node.assetId ? node : { ...node, assetId };
        }
        if ('children' in node) {
            const children = mapArray(node.children, inline);
            return children === node.children ? node : { ...node, children };
        }
        return node;
    };
    const row = (value: TableRow): TableRow => {
        const cells = mapArray(value.cells, cell => {
            const children = mapArray(cell.children, inline);
            return children === cell.children ? cell : { ...cell, children };
        });
        return cells === value.cells ? value : { ...value, cells };
    };
    const block = (node: BlockNode): BlockNode => {
        switch (node.type) {
            case 'paragraph':
            case 'heading': {
                const children = mapArray(node.children, inline);
                return children === node.children ? node : { ...node, children };
            }
            case 'list': {
                const items = mapArray(node.items, item => {
                    const blocks = mapArray(item.blocks, block);
                    return blocks === item.blocks ? item : { ...item, blocks };
                });
                return items === node.items ? node : { ...node, items };
            }
            case 'quote':
{
                const blocks = mapArray(node.blocks, block);
                return blocks === node.blocks ? node : { ...node, blocks };
            }
            case 'table': {
                const rows = mapArray(node.rows, row);
                const headerRows = node.headerRows && mapArray(node.headerRows, row);
                const caption = node.caption && mapArray(node.caption, inline);
                return rows === node.rows && headerRows === node.headerRows && caption === node.caption
                    ? node : { ...node, rows, ...(headerRows ? { headerRows } : {}), ...(caption ? { caption } : {}) };
            }
            case 'image': {
                const assetId = resolve(node.assetId, 'image', node.alt);
                const caption = node.caption && mapArray(node.caption, inline);
                return assetId === node.assetId && caption === node.caption
                    ? node : { ...node, assetId, ...(caption ? { caption } : {}) };
            }
            case 'file': {
                const assetId = resolve(node.assetId, 'file');
                const description = node.description && mapArray(node.description, inline);
                return assetId === node.assetId && description === node.description
                    ? node : { ...node, assetId, ...(description ? { description } : {}) };
            }
            default: return node;
        }
    };
    return mapArray(blocks, block);
}
