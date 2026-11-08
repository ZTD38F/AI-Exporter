import type { DisplayBlock, DisplayInline, DocumentAst } from './ast.js';

/** Walk the logical tree, including rich captions and nested metadata. Placement determines binary needs. */
export function collectDocumentResources(document: DocumentAst): {
    referencedIds: Set<string>;
    imageIds: Set<string>;
    fileIds: Set<string>;
} {
    const referencedIds = new Set<string>(), imageIds = new Set<string>(), fileIds = new Set<string>();
    const reference = (id: string, image: boolean): void => {
        referencedIds.add(id);
        if (image) imageIds.add(id);
        else fileIds.add(id);
    };
    const inlines = (nodes: DisplayInline[] = []): void => {
        for (const node of nodes) {
            if (node.type === 'image') reference(node.resourceId, true);
            if ('children' in node) inlines(node.children);
        }
    };
    const blocks = (nodes: DisplayBlock[]): void => {
        for (const node of nodes) {
            if (node.type === 'image') reference(node.resourceId, true);
            if (node.type === 'file') reference(node.resourceId, false);
            if ('children' in node) inlines(node.children);
            if ('caption' in node) inlines(node.caption);
            if ('description' in node) inlines(node.description);
            if ('blocks' in node && node.blocks) blocks(node.blocks);
            if (node.type === 'list') for (const item of node.items) blocks(item.blocks);
            if (node.type === 'table') for (const row of [...node.headerRows, ...node.rows]) for (const cell of row) inlines(cell.children);
        }
    };
    for (const message of document.messages) {
        blocks(message.blocks);
    }
    return { referencedIds, imageIds, fileIds };
}
