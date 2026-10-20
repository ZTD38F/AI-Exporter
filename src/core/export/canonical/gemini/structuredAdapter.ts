import type { BlockNode, ListItem, TableCell, TableRow } from '../blocks.js';
import type { InlineNode } from '../inline.js';
import type { MarkdownParseContext } from '../markdown/index.js';
import type {
    GeminiAnnotation,
    GeminiStructuredDocument,
    GeminiStructuredNode,
} from '../../../api/parser/structuredContent.js';

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

function isLeafAnnotation(type: number): boolean {
    return type === 4 || type === 7;
}

export function convertGeminiInlines(
    text: string,
    annotations?: GeminiAnnotation[],
): InlineNode[] | null {
    if (!annotations || annotations.length === 0) {
        return textWithSoftBreaks(text);
    }

    // Validate annotations integrity and bounds
    for (const a of annotations) {
        if (typeof a.start !== 'number' || typeof a.end !== 'number' || typeof a.type !== 'number') {
            return null;
        }
        if (a.start < 0 || a.end > text.length || a.start > a.end) {
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
        if (![0, 2, 4, 5, 6, 7, 12].includes(a.type)) {
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
            } else if ([0, 2, 5, 6, 12].includes(a.type)) {
                // Container annotation with potential nested annotations
                const innerAnnots = curAnnots.filter(
                    (c) => c !== a && c.start >= a.start && c.end <= a.end,
                );
                const children = convertRange(a.start, a.end, innerAnnots);
                if (children === null) return null;

                if (a.type === 0) {
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

function convertCellChildren(children: GeminiStructuredNode[]): InlineNode[] | null {
    const inlines: InlineNode[] = [];
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!child || typeof child !== 'object' || typeof child.nodeType !== 'number') {
            return null;
        }
        if (child.nodeType === 18) {
            if (typeof child.text !== 'string') return null;
            const converted = convertGeminiInlines(child.text, child.annotations);
            if (converted === null) return null;
            inlines.push(...converted);
        } else if (child.nodeType === 13) {
            inlines.push({ type: 'lineBreak', kind: 'hard' });
        } else {
            // Unsupported node inside table cell -> fallback
            return null;
        }
    }
    return inlines;
}

export function geminiStructuredToCanonical(
    doc: unknown,
    idPrefix: string,
    ctx: MarkdownParseContext,
): BlockNode[] | null {
    if (!doc || typeof doc !== 'object') return null;

    let nodes: GeminiStructuredNode[];
    if (Array.isArray((doc as GeminiStructuredDocument).children)) {
        nodes = (doc as GeminiStructuredDocument).children;
    } else if (Array.isArray(doc)) {
        nodes = doc as GeminiStructuredNode[];
    } else {
        return null;
    }

    if (nodes.length === 0) {
        return [];
    }

    const blocks: BlockNode[] = [];

    for (const node of nodes) {
        if (!node || typeof node !== 'object' || typeof node.nodeType !== 'number') {
            return null;
        }

        switch (node.nodeType) {
            case 18: {
                // Text / Heading / Paragraph
                if (typeof node.text !== 'string') return null;
                const inlines = convertGeminiInlines(node.text, node.annotations);
                if (inlines === null) return null;

                if (node.jJ && node.jJ >= 1 && node.jJ <= 6) {
                    blocks.push({
                        id: ctx.nextBlockId(),
                        type: 'heading',
                        level: node.jJ as 1 | 2 | 3 | 4 | 5 | 6,
                        children: inlines,
                    });
                } else {
                    blocks.push({
                        id: ctx.nextBlockId(),
                        type: 'paragraph',
                        children: inlines,
                    });
                }
                break;
            }

            case 12: {
                // Display Math
                if (typeof node.FTa !== 'string') return null;
                blocks.push({
                    id: ctx.nextBlockId(),
                    type: 'math',
                    source: node.FTa,
                });
                break;
            }

            case 1: {
                // Code block
                if (typeof node.code !== 'string') return null;
                blocks.push({
                    id: ctx.nextBlockId(),
                    type: 'code',
                    code: node.code,
                    ...(node.info ? { language: node.info } : {}),
                });
                break;
            }

            case 19: {
                // Thematic break
                blocks.push({
                    id: ctx.nextBlockId(),
                    type: 'thematicBreak',
                });
                break;
            }

            case 20:
            case 14: {
                // Unordered (20) or Ordered (14) list
                if (!Array.isArray(node.items)) return null;
                const items: ListItem[] = [];
                for (const item of node.items) {
                    if (!item || !Array.isArray(item.children)) return null;
                    const itemBlocks = geminiStructuredToCanonical(
                        { children: item.children },
                        idPrefix,
                        ctx,
                    );
                    if (itemBlocks === null) return null;
                    items.push({ blocks: itemBlocks });
                }
                blocks.push({
                    id: ctx.nextBlockId(),
                    type: 'list',
                    ordered: node.nodeType === 14,
                    ...(node.nodeType === 14 ? { start: typeof node.VHa === 'number' ? node.VHa : 1 } : {}),
                    items,
                });
                break;
            }

            case 15: {
                // Blockquote
                if (!Array.isArray(node.children)) return null;
                const quoteBlocks = geminiStructuredToCanonical(
                    { children: node.children },
                    idPrefix,
                    ctx,
                );
                if (quoteBlocks === null) return null;
                blocks.push({
                    id: ctx.nextBlockId(),
                    type: 'quote',
                    blocks: quoteBlocks,
                });
                break;
            }

            case 17: {
                // Table
                if (!Array.isArray(node.rows)) return null;
                const tableRows: TableRow[] = [];
                for (const row of node.rows) {
                    if (!row || !Array.isArray(row.cells)) return null;
                    const cells: TableCell[] = [];
                    for (const cell of row.cells) {
                        if (!cell || !Array.isArray(cell.children)) return null;
                        const cellInlines = convertCellChildren(cell.children);
                        if (cellInlines === null) return null;
                        cells.push({
                            children: cellInlines,
                            ...(typeof cell.colSpan === 'number' && cell.colSpan > 1 ? { colSpan: cell.colSpan } : {}),
                            ...(typeof cell.rowSpan === 'number' && cell.rowSpan > 1 ? { rowSpan: cell.rowSpan } : {}),
                        });
                    }
                    tableRows.push({ cells });
                }
                const headerRows: TableRow[] = tableRows.length > 0 ? [tableRows[0]] : [];
                const dataRows: TableRow[] = tableRows.length > 1 ? tableRows.slice(1) : [];
                blocks.push({
                    id: ctx.nextBlockId(),
                    type: 'table',
                    ...(headerRows.length ? { headerRows } : {}),
                    rows: dataRows,
                });
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
