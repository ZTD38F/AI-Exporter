import type { BlockNode } from '../../src/l2/content/blocks.js';
import type { InlineNode } from '../../src/l2/content/inline.js';

// Test assertions may project text from well-formed Content AST; this is not a
// production fallback or a renderer.
export function textOfInline(node: InlineNode): string {
    switch (node.type) {
        case 'text': return node.text;
        case 'strong':
        case 'emphasis':
        case 'strikethrough':
        case 'link': return node.children.map(textOfInline).join('');
        case 'inlineCode': return node.code;
        case 'inlineMath': return node.source;
        case 'image': return node.alt ?? '';
        case 'citationRef': return node.label ?? '';
        case 'lineBreak': return '\n';
    }
}

export function textOfBlock(block: BlockNode): string {
    switch (block.type) {
        case 'paragraph':
        case 'heading': return block.children.map(textOfInline).join('');
        case 'list': return block.items.map(item => textOfBlocks(item.blocks)).join('\n');
        case 'quote': return textOfBlocks(block.blocks);
        case 'code': return block.code;
        case 'math': return block.source;
        case 'table': return [...(block.headerRows ?? []), ...block.rows]
            .map(row => row.cells.map(cell => cell.children.map(textOfInline).join('')).join(' | ')).join('\n');
        case 'image': return block.alt ?? '';
        case 'file': return block.label ?? '';
        case 'unknown': return block.text;
        case 'thematicBreak': return '';
    }
}

export function textOfBlocks(blocks: readonly BlockNode[]): string {
    return blocks.map(textOfBlock).join('\n');
}
