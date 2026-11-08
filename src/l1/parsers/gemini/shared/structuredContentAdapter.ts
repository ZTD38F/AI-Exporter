import type { BlockNode, ListItem, TableCell, TableRow } from '../../../../l2/content/blocks.js';
import type { DomainCitation } from '../../../../l2/conversationDetail.js';
import type { InlineNode } from '../../../../l2/content/inline.js';
import type {
    GeminiAnnotation,
    GeminiStructuredDocument,
    GeminiStructuredNode,
} from '../rpc/structuredContent.js';

function textWithSoftBreaks(text: string): InlineNode[] {
    if (!text.includes('\n')) {
        return text ? [{ type: 'text', text }] : [];
    }
    const lines = text.split('\n');
    const nodes: InlineNode[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (i > 0) {
            nodes.push({ type: 'lineBreak', kind: 'soft' });
        }
        if (lines[i].length > 0) {
            nodes.push({ type: 'text', text: lines[i] });
        }
    }
    return nodes;
}

export type GeminiSourceCitations = ReadonlyMap<string, readonly DomainCitation[]>;

function isLeafAnnotation(type: GeminiAnnotation['type']): boolean {
    return type === 4 || type === 7;
}

export function convertGeminiInlines(
    text: string,
    annotations?: GeminiAnnotation[],
    sources: GeminiSourceCitations = new Map(),
): InlineNode[] | null {
    if (!annotations || annotations.length === 0) {
        return textWithSoftBreaks(text);
    }

    // Validate annotations integrity and bounds
    for (const a of annotations) {
        if (!Number.isInteger(a.start) || !Number.isInteger(a.end) || a.start < 0 || a.end > text.length || a.start > a.end) {
            return null;
        }
        // Supported inline annotation types:
        // 0: strong (bold)
        // 2: emphasis (italic)
        // 4: inline math
        // 5: subtle/italic emphasis
        // 6: link
        // 7: inline code
        // 12: strikethrough
        if (a.type === 'source') {
            if (!a.sourceIds?.length || a.sourceIds.some(id => !sources.get(id)?.length)) return null;
        } else if (![0, 2, 4, 5, 6, 7, 12].includes(a.type)) {
            return null; // Unknown annotation type -> fallback
        }
    }

    // Sort annotations:
    // 1. start asc
    // 2. length desc (larger spans wrap smaller ones)
    // 3. container annotations before leaf annotations
    const sorted = [...annotations].sort((a, b) => {
        if (a.start !== b.start) return a.start - b.start;
        const lenA = a.end - a.start;
        const lenB = b.end - b.start;
        if (lenA !== lenB) return lenB - lenA;
        if (a.type === 'source' && b.type !== 'source') return -1;
        if (b.type === 'source' && a.type !== 'source') return 1;
        const leafA = isLeafAnnotation(a.type) ? 1 : 0;
        const leafB = isLeafAnnotation(b.type) ? 1 : 0;
        return leafA - leafB;
    });

    // Check for invalid crossing overlaps
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            const a = sorted[i];
            const b = sorted[j];
            if (a.start < b.start && b.start < a.end && a.end < b.end) {
                return null; // Crossing overlap cannot be cleanly nested -> fallback
            }
        }
    }

    function convertRange(start: number, end: number, curAnnots: GeminiAnnotation[]): InlineNode[] | null {
        // Find top-level annotations within [start, end]
        const topAnnots: GeminiAnnotation[] = [];
        for (const a of curAnnots) {
            if (a.start < start || a.end > end) continue;
            let enclosed = false;
            for (const t of topAnnots) {
                if (t.start <= a.start && a.end <= t.end) {
                    enclosed = true;
                    break;
                }
            }
            if (!enclosed) {
                topAnnots.push(a);
            }
        }

        const nodes: InlineNode[] = [];
        let cursor = start;

        for (const a of topAnnots) {
            if (a.start > cursor) {
                nodes.push(...textWithSoftBreaks(text.slice(cursor, a.start)));
            }

            const rawSlice = text.slice(a.start, a.end);
            // Leaf nodes cannot contain another annotation without losing it.
            if (isLeafAnnotation(a.type) && curAnnots.some(c => c !== a && c.start >= a.start && c.end <= a.end)) return null;

            if (a.type === 4) {
                // Inline Math
                nodes.push({
                    type: 'inlineMath',
                    source: rawSlice,
                });
            } else if (a.type === 7) {
                // Inline Code
                nodes.push({
                    type: 'inlineCode',
                    code: rawSlice,
                });
            } else if (a.type === 'source' || [0, 2, 5, 6, 12].includes(a.type)) {
                // Container annotation with potential nested annotations
                const innerAnnots = curAnnots.filter(
                    (c) => c !== a && c.start >= a.start && c.end <= a.end,
                );
                const children = convertRange(a.start, a.end, innerAnnots);
                if (children === null) return null;

                if (a.type === 'source') {
                    nodes.push(...children);
                    const emitted = new Set<string>();
                    for (const id of a.sourceIds ?? []) for (const citation of sources.get(id) ?? []) {
                        if (emitted.has(citation.id)) continue;
                        emitted.add(citation.id);
                        nodes.push({ type: 'citationRef', citationId: citation.id });
                    }
                } else if (a.type === 0) {
                    nodes.push({ type: 'strong', children });
                } else if (a.type === 2 || a.type === 5) {
                    nodes.push({ type: 'emphasis', children });
                } else if (a.type === 12) {
                    nodes.push({ type: 'strikethrough', children });
                } else if (a.type === 6) {
                    nodes.push({ type: 'link', href: a.url || '', children });
                }
            } else {
                return null;
            }

            cursor = a.end;
        }

        if (cursor < end) {
            nodes.push(...textWithSoftBreaks(text.slice(cursor, end)));
        }

        return nodes;
    }

    return convertRange(0, text.length, sorted);
}

function convertCellChildren(children: GeminiStructuredNode[], sources: GeminiSourceCitations): InlineNode[] | null {
    const inlines: InlineNode[] = [];
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeType === 18) {
            if (child.jJ && child.jJ > 0) return null;
            const converted = convertGeminiInlines(child.text, child.annotations, sources);
            if (converted === null) return null;
            inlines.push(...converted);
        } else if (child.nodeType === 'paragraph' || child.nodeType === 'citationGroup') {
            const converted = convertCellChildren(child.children, sources);
            if (converted === null) return null;
            inlines.push(...converted);
        } else if (child.nodeType === 'citation') {
            if (!Number.isSafeInteger(child.number) || child.number < 1 || !child.title) return null;
            const citationId = `grounding-${child.number}`;
            if (!sources.get(citationId)?.some(citation => citation.id === citationId)) return null;
            // Native uploaded-file chips are hidden in the authored webpage text.
            // Keep their source metadata, but do not invent a visible numbered marker.
            // Text nodes (including literal [1] and inline code) remain untouched.
        } else if (child.nodeType === 12) {
            // Native display math can occur inside a table cell. Preserve its
            // source instead of falling back and reinterpreting other cell text.
            inlines.push({ type: 'inlineMath', source: child.FTa });
        } else if (child.nodeType === 13) {
            inlines.push({ type: 'lineBreak', kind: 'hard' });
        } else {
            // Unsupported node inside table cell -> fallback
            return null;
        }
    }
    return inlines;
}

export function geminiStructuredToContent(
    doc: GeminiStructuredDocument,
    sources: GeminiSourceCitations = new Map(),
): BlockNode[] | null {
    const blocks: BlockNode[] = [];

    for (const node of doc.children) {
        switch (node.nodeType) {
            case 'citation':
            case 'citationGroup': {
                const children = convertCellChildren([node], sources);
                if (children === null) return null;
                const previous = blocks[blocks.length - 1];
                if (previous?.type === 'paragraph' || previous?.type === 'heading') previous.children.push(...children);
                else blocks.push({ type: 'paragraph', children });
                break;
            }
            case 'paragraph': {
                const children = convertCellChildren(node.children, sources);
                if (children === null) return null;
                blocks.push({ type: 'paragraph', children });
                break;
            }
            case 18: {
                // Text / Heading / Paragraph
                const inlines = convertGeminiInlines(node.text, node.annotations, sources);
                if (inlines === null) return null;

                const level = node.jJ;
                if (level === 1 || level === 2 || level === 3 || level === 4 || level === 5 || level === 6) {
                    blocks.push({
                        type: 'heading',
                        level,
                        children: inlines,
                    });
                } else {
                    blocks.push({
                        type: 'paragraph',
                        children: inlines,
                    });
                }
                break;
            }

            case 12: {
                // Display Math
                blocks.push({
                    type: 'math',
                    source: node.FTa,
                });
                break;
            }

            case 1: {
                // Code block
                blocks.push({
                    type: 'code',
                    code: node.code,
                    ...(node.info ? { language: node.info } : {}),
                });
                break;
            }

            case 19: {
                // Thematic break
                blocks.push({
                    type: 'thematicBreak',
                });
                break;
            }

            case 20:
            case 14: {
                // Unordered (20) or Ordered (14) list
                const items: ListItem[] = [];
                for (const item of node.items) {
                    const itemBlocks = geminiStructuredToContent(
                        { children: item.children }, sources,
                    );
                    if (itemBlocks === null) return null;
                    items.push({ blocks: itemBlocks });
                }
                blocks.push({
                    type: 'list',
                    ordered: node.nodeType === 14,
                    ...(node.nodeType === 14 ? { start: node.VHa ?? 1 } : {}),
                    items,
                });
                break;
            }

            case 15: {
                // Blockquote
                const quoteBlocks = geminiStructuredToContent(
                    { children: node.children }, sources,
                );
                if (quoteBlocks === null) return null;
                blocks.push({
                    type: 'quote',
                    blocks: quoteBlocks,
                });
                break;
            }

            case 17: {
                // Table
                const tableRows: TableRow[] = [];
                for (const row of node.rows) {
                    const cells: TableCell[] = [];
                    for (const cell of row.cells) {
                        const cellInlines = convertCellChildren(cell.children, sources);
                        if (cellInlines === null) return null;
                        cells.push({
                            children: cellInlines,
                            ...(cell.colSpan !== undefined && cell.colSpan > 1 ? { colSpan: cell.colSpan } : {}),
                            ...(cell.rowSpan !== undefined && cell.rowSpan > 1 ? { rowSpan: cell.rowSpan } : {}),
                        });
                    }
                    tableRows.push({ cells });
                }
                const headerRows: TableRow[] = tableRows.length > 0 ? [tableRows[0]] : [];
                const dataRows: TableRow[] = tableRows.length > 1 ? tableRows.slice(1) : [];
                blocks.push({
                    type: 'table',
                    ...(headerRows.length ? { headerRows } : {}),
                    rows: dataRows,
                });
                break;
            }

            case 24: {
                blocks.push({ type: 'file', assetId: node.id, label: node.title });
                break;
            }

            case 0: {
                // Attachment nodes (nodeType: 0) such as search/web images (attachmentType: 36)
                // and UI chips/elicitations are handled authoritatively by the existing candidate
                // attachment/asset pipeline; not duplicated here in body blocks.
                break;
            }

            case 13: {
                // Standalone line break at root: ignore
                break;
            }

            default:
                // Unknown / unsupported node type -> reject and trigger fallback
                return null;
        }
    }

    return blocks;
}
