import { visual } from '../shared/visualContract.js';
import type { PdfLayoutPolicy, TypstBlockNode } from './transport.js';

/** Physical defaults belong to this backend; options may override them without recomposition. */
export function defaultPdfLayout(documentLanguage = 'zh'): PdfLayoutPolicy {
    return {
        page: { widthMm: 210, heightMm: 297, topMm: 18.5, bottomMm: 18, sideMm: 22, contentWidthMm: 166, proseWidthMm: 166 * visual.content.proseWidth / visual.content.maxWidth },
        bubble: { maxWidthRatio: 0.85, compactHeightPt: 120, minInnerWidthPt: 28, paddingXPt: 12.5, paddingYPt: 8.4 },
        figure: { maxPageHeightRatio: 0.60, captionMaxWidthMm: 115 },
        textLanguage: documentLanguage, headerGapPt: visual.spacing.inline * 0.75, bodyGapPt: visual.spacing.section * 0.75,
    };
}
export function applyLayout(nodes: TypstBlockNode[], bubble: boolean, nested: boolean): void {
    nodes.forEach((node, index) => {
        const previous = nodes[index - 1], next = nodes[index + 1];
        const gap = !previous ? 0 : node.type === 'heading' || node.type === 'thematicBreak' || previous.type === 'thematicBreak' ? 'section'
            : previous.type === 'heading' || previous.type === 'paragraph' && (node.type === 'paragraph' || node.type === 'list') || previous.type === 'list' && node.type === 'paragraph' ? 'paragraph' : 'block';
        node.layout = { gapBeforePt: gap === 0 ? 0 : visual.spacing[gap] * 0.75, keepWithNext: node.type === 'heading' || !nested && node.type === 'paragraph' && Boolean(next && ['table', 'image', 'math', 'code', 'note'].includes(next.type)), width: ['note', 'unknown'].includes(node.type) ? 'reading' : ['code', 'math', 'table', 'image', 'file'].includes(node.type) ? 'full' : bubble ? 'container' : 'reading' };
        if (node.type === 'list') node.items.forEach(item => applyLayout(item.blocks, bubble, true));
        else if (node.type === 'quote') applyLayout(node.blocks, bubble, true);
        else if (node.type === 'note' && node.blocks) applyLayout(node.blocks, bubble, true);
    });
}
