import type { BlockNode } from '../../../../l2/content/blocks.js';
type Citation = { id: string };
import type { InlineNode } from '../../../../l2/content/inline.js';

export function linkCitationMarkers(
    blocks: BlockNode[],
    citations: Citation[],
    groundingMap?: Map<string, { citation: Citation; displayLabel: string }[]>,
): void {
    const hasWebCits = citations.length > 0;
    const hasGrounding = !!(groundingMap && groundingMap.size > 0);
    if (!hasWebCits && !hasGrounding) return;

    const byIndex = new Map(citations.map((c, i) => [i + 1, c]));
    const walkInline = (nodes: InlineNode[]): InlineNode[] => {
        const out: InlineNode[] = [];
        for (const n of nodes) {
            if (n.type === 'text') {
                const re = /\[(?:cite:\s*)?(\d+(?:\s*,\s*\d+)*)\]/gi;
                let last = 0;
                let mt: RegExpExecArray | null;
                let replaced = false;
                while ((mt = re.exec(n.text)) !== null) {
                    const matchedStr = mt[0];
                    const isCite = /^\[cite:/i.test(matchedStr);
                    let targets: { citationId: string; label: string }[] | undefined;

                    if (isCite) {
                        if (!groundingMap?.size) continue;
                        const entries = groundingMap.get(matchedStr) ?? groundingMap.get(matchedStr.toLowerCase().replace(/\s+/g, ' '));
                        if (!entries?.length) continue;
                        targets = entries.map(entry => ({ citationId: entry.citation.id, label: entry.displayLabel }));
                    } else {
                        if (!hasWebCits) continue;
                        // Plain web markers stay single-number only; a plain
                        // [1,2] list is authored text, not a citation marker.
                        if (mt[1].includes(',')) continue;
                        const cit = byIndex.get(Number(mt[1]));
                        if (!cit) continue;
                        targets = [{ citationId: cit.id, label: matchedStr }];
                    }

                    replaced = true;
                    if (mt.index > last) out.push({ type: 'text', text: n.text.slice(last, mt.index) });
                    for (const target of targets) {
                        out.push({ type: 'citationRef', citationId: target.citationId, label: target.label });
                    }
                    last = mt.index + matchedStr.length;
                }
                if (replaced) {
                    if (last < n.text.length) out.push({ type: 'text', text: n.text.slice(last) });
                } else {
                    out.push(n);
                }
            } else if ((n.type === 'strong' || n.type === 'emphasis' || n.type === 'strikethrough' || n.type === 'link')) {
                out.push({ ...n, children: walkInline(n.children) });
            } else {
                out.push(n);
            }
        }
        return out;
    };
    const walkBlock = (b: BlockNode): void => {
        switch (b.type) {
            case 'paragraph':
            case 'heading':
                b.children = walkInline(b.children);
                break;
            case 'quote':
                b.blocks.forEach(walkBlock);
                break;
            case 'list':
                b.items.forEach((it) => it.blocks.forEach(walkBlock));
                break;
            case 'table': {
                const rows = [...(b.headerRows ?? []), ...b.rows];
                for (const r of rows) for (const c of r.cells) c.children = walkInline(c.children);
                if (b.caption) b.caption = walkInline(b.caption);
                break;
            }
            case 'image': if (b.caption) b.caption = walkInline(b.caption); break;
            case 'file': if (b.description) b.description = walkInline(b.description); break;
            default:
                break;
        }
    };
    blocks.forEach(walkBlock);
}
