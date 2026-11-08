import type { BlockNode } from '../../../../l2/content/blocks.js';
import type { InlineNode } from '../../../../l2/content/inline.js';

/** Native file metadata also identifies hidden chips when another node forces Markdown fallback. */
export function hideGeminiFileCitations(blocks: BlockNode[], fileIds: ReadonlySet<string>): void {
    const inlines = (nodes: InlineNode[]): InlineNode[] => nodes.filter(node =>
        node.type !== 'citationRef' || !fileIds.has(node.citationId)).map(node => {
        if ('children' in node) node.children = inlines(node.children);
        return node;
    });
    for (const block of blocks) {
        if ('children' in block) block.children = inlines(block.children);
        else if (block.type === 'quote') hideGeminiFileCitations(block.blocks, fileIds);
        else if (block.type === 'list') block.items.forEach(item => hideGeminiFileCitations(item.blocks, fileIds));
        else if (block.type === 'table') {
            if (block.caption) block.caption = inlines(block.caption);
            [...(block.headerRows ?? []), ...block.rows].forEach(row => row.cells.forEach(cell => { cell.children = inlines(cell.children); }));
        } else if (block.type === 'image' && block.caption) block.caption = inlines(block.caption);
        else if (block.type === 'file' && block.description) block.description = inlines(block.description);
    }
}
