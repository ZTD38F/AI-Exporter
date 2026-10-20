import type { ChatMessage as RepoMessage } from '../../../../types/conversation.js';
import type { BlockNode } from '../blocks.js';
import type { Citation } from '../citations.js';
import type { InlineNode } from '../inline.js';

export interface RawCitation {
    url?: string;
    title?: string;
}

function isStr(v: unknown): v is string {
    return typeof v === 'string';
}

export function extractRawCitations(m: RepoMessage): { list: RawCitation[]; skipped: number } {
    const list: RawCitation[] = [];
    let skipped = 0;
    const push = (c: RawCitation): void => {
        if (c.url && !list.some((x) => x.url === c.url)) list.push(c);
        else if (!c.url) skipped++;
    };
    const fromCitations = m.citations;
    if (Array.isArray(fromCitations)) {
        for (const c of fromCitations) {
            if (c && typeof c === 'object' && isStr((c as { url?: unknown }).url)) {
                const o = c as { url: string; title?: unknown };
                push(isStr(o.title) ? { url: o.url, title: o.title } : { url: o.url });
            } else skipped++;
        }
    }
    const fromSources = m.sources;
    if (Array.isArray(fromSources)) {
        for (const s of fromSources) {
            if (isStr(s)) push({ url: s });
            else if (s && typeof s === 'object' && isStr((s as { url?: unknown }).url)) {
                const o = s as { url: string; title?: unknown };
                push(isStr(o.title) ? { url: o.url, title: o.title } : { url: o.url });
            } else skipped++;
        }
    }
    return { list, skipped };
}

export function linkCitationMarkers(
    blocks: BlockNode[],
    citations: Citation[],
    groundingMap?: Map<string, { citation: Citation; displayLabel: string }>,
): void {
    const hasWebCits = citations.length > 0;
    const hasGrounding = !!(groundingMap && groundingMap.size > 0);
    if (!hasWebCits && !hasGrounding) return;

    const byIndex = new Map(citations.map((c, i) => [i + 1, c]));
    const walkInline = (nodes: InlineNode[]): InlineNode[] => {
        const out: InlineNode[] = [];
        for (const n of nodes) {
            if (n.type === 'text') {
                const re = /\[(?:cite:\s*)?(\d+)\]/gi;
                let last = 0;
                let mt: RegExpExecArray | null;
                let replaced = false;
                while ((mt = re.exec(n.text)) !== null) {
                    const matchedStr = mt[0];
                    const isCite = /^\[cite:/i.test(matchedStr);
                    let targetCitId: string | undefined;
                    let targetLabel: string | undefined;

                    if (isCite) {
                        if (!hasGrounding) continue;
                        const entry = groundingMap!.get(matchedStr) ?? groundingMap!.get(matchedStr.toLowerCase().replace(/\s+/g, ' '));
                        if (!entry) continue;
                        targetCitId = entry.citation.id;
                        targetLabel = entry.displayLabel;
                    } else {
                        if (!hasWebCits) continue;
                        const cit = byIndex.get(Number(mt[1]));
                        if (!cit) continue;
                        targetCitId = cit.id;
                        targetLabel = matchedStr;
                    }

                    replaced = true;
                    if (mt.index > last) out.push({ type: 'text', text: n.text.slice(last, mt.index) });
                    out.push({ type: 'citationRef', citationId: targetCitId, label: targetLabel });
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
                (b as { children: InlineNode[] }).children = walkInline((b as { children: InlineNode[] }).children);
                break;
            case 'quote':
            case 'thought':
                b.blocks.forEach(walkBlock);
                break;
            case 'list':
                b.items.forEach((it) => it.blocks.forEach(walkBlock));
                break;
            case 'table': {
                const rows = [...(b.headerRows ?? []), ...b.rows];
                for (const r of rows) for (const c of r.cells) c.children = walkInline(c.children);
                break;
            }
            default:
                break;
        }
    };
    blocks.forEach(walkBlock);
}
