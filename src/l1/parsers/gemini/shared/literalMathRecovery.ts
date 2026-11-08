import type { BlockNode } from '../../../../l2/content/blocks.js';
import type { InlineNode } from '../../../../l2/content/inline.js';

export function hasLiteralMathText(blocks: BlockNode[]): boolean {
    const inlines = (nodes: InlineNode[]): boolean => nodes.some(node => node.type === 'text' ? node.text.includes('$')
        : (node.type === 'strong' || node.type === 'emphasis' || node.type === 'strikethrough') && inlines(node.children));
    return blocks.some(block => (block.type === 'paragraph' || block.type === 'heading') ? inlines(block.children)
        : block.type === 'quote' ? hasLiteralMathText(block.blocks)
        : block.type === 'list' && block.items.some(item => hasLiteralMathText(item.blocks)));
}

/** GM-MD-005: native emphasis can consume the star in raw **$Q^* = 30$**.
 * Recover only a uniquely paired paragraph with identical surrounding prose.
 * Code, citations, resource nodes and already parsed math are never rewritten.
 * Evidence: tests/fixtures/provider/math/gm_md_005_evidence.json.
 */
export function recoverLiteralMath(native: BlockNode[], markdown: BlockNode[]): number {
    if (native.length !== markdown.length) return 0;
    const flatten = (nodes: InlineNode[]): string | null => {
        let text = '';
        for (const node of nodes) {
            if (node.type === 'text') text += node.text;
            else if (node.type === 'lineBreak' && node.kind === 'soft') text += '\n';
            else if (node.type === 'inlineMath') text += '\u0000';
            else if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'strikethrough') {
                const inner = flatten(node.children);
                if (inner === null) return null;
                text += inner;
            } else return null;
        }
        return text;
    };
    const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
    let recovered = 0;
    for (const block of native) {
        if (block.type === 'paragraph' || block.type === 'heading') {
            const text = flatten(block.children);
            if (text === null || text.includes('\u0000')) continue;
            const matches = [...text.matchAll(/(?<![\\$])\$([^$\n]+)\$(?!\$)/g)];
            if (!matches.length) continue;
            const skeleton = text.replace(/(?<![\\$])\$([^$\n]+)\$(?!\$)/g, '\u0000');
            const candidates = markdown.filter(candidate => {
                if (candidate.type !== block.type || !('children' in candidate)) return false;
                if (block.type === 'heading' && candidate.type === 'heading' && block.level !== candidate.level) return false;
                const other = flatten(candidate.children);
                if (other === null || other.split('\u0000').length - 1 !== matches.length) return false;
                if (normalize(skeleton) === normalize(other)) return true;
                // The captured provider defect also leaves a closing bold star
                // as prose. Admit it only beside punctuation and a raw strong span.
                return candidate.children.some(node => node.type === 'strong')
                    && normalize(skeleton.replace(/\*(?=[，。！？,.!?]|$)/g, '')) === normalize(other);
            });
            if (candidates.length === 1 && 'children' in candidates[0]) {
                block.children = structuredClone(candidates[0].children);
                recovered++;
            }
        } else if (block.type === 'quote') {
            const matches = markdown.filter(candidate => candidate.type === 'quote');
            if (matches.length === 1 && matches[0].type === 'quote') recovered += recoverLiteralMath(block.blocks, matches[0].blocks);
        } else if (block.type === 'list') {
            // Preserve list ownership: require a single same-shape list before
            // pairing items, then apply the same unique paragraph rule inside.
            const matches = markdown.filter(candidate => candidate.type === 'list' && candidate.ordered === block.ordered && candidate.items.length === block.items.length);
            if (matches.length === 1 && matches[0].type === 'list') {
                const other = matches[0];
                block.items.forEach((item, index) => { recovered += recoverLiteralMath(item.blocks, other.items[index].blocks); });
            }
        }
    }
    return recovered;
}
