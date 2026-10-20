import { GEMINI_JSPB_SCHEMA } from "./extractors.js";

export interface GeminiAnnotation {
    start: number;
    end: number;
    type: number;
    url?: string;
}

export interface GeminiTextNode {
    nodeType: 18;
    text: string;
    jJ?: number; // heading level 1..6, or 0/undefined for paragraph
    annotations?: GeminiAnnotation[];
}

export interface GeminiMathBlockNode {
    nodeType: 12;
    FTa: string;
}

export interface GeminiCodeBlockNode {
    nodeType: 1;
    code: string;
    info?: string;
}

export interface GeminiThematicBreakNode {
    nodeType: 19;
}

export interface GeminiLineBreakNode {
    nodeType: 13;
}

export interface GeminiTableCell {
    children: GeminiStructuredNode[];
    colSpan?: number;
    rowSpan?: number;
}

export interface GeminiTableRow {
    cells: GeminiTableCell[];
}

export interface GeminiTableNode {
    nodeType: 17;
    rows: GeminiTableRow[];
}

export interface GeminiListItem {
    children: GeminiStructuredNode[];
}

export interface GeminiUnorderedListNode {
    nodeType: 20;
    items: GeminiListItem[];
}

export interface GeminiOrderedListNode {
    nodeType: 14;
    items: GeminiListItem[];
    VHa?: number; // 1-based start number
}

export interface GeminiQuoteNode {
    nodeType: 15;
    children: GeminiStructuredNode[];
}

export interface GeminiAttachmentNode {
    nodeType: 0;
    Xj?: Array<{
        attachmentType?: number;
        [key: string]: unknown;
    }>;
}

export type GeminiStructuredNode =
    | GeminiTextNode
    | GeminiMathBlockNode
    | GeminiCodeBlockNode
    | GeminiThematicBreakNode
    | GeminiLineBreakNode
    | GeminiTableNode
    | GeminiUnorderedListNode
    | GeminiOrderedListNode
    | GeminiQuoteNode
    | GeminiAttachmentNode;

export interface GeminiStructuredDocument {
    children: GeminiStructuredNode[];
}

export function decodeGeminiAnnotation(wa: unknown): GeminiAnnotation | null {
    if (!wa) return null;
    if (typeof wa === "object" && !Array.isArray(wa)) {
        const d = wa as Record<string, unknown>;
        if (typeof d.start === "number" && typeof d.end === "number" && typeof d.type === "number") {
            // Supported inline annotation types:
            // 0: strong (bold)
            // 2: emphasis (italic)
            // 4: inline math
            // 5: subtle/italic emphasis
            // 6: link
            // 7: inline code
            // 12: strikethrough
            if ([0, 2, 4, 5, 6, 7, 12].includes(d.type)) {
                return {
                    start: d.start,
                    end: d.end,
                    type: d.type,
                    ...(typeof d.url === "string" ? { url: d.url } : {})
                };
            }
        }
        return null;
    }
    if (!Array.isArray(wa) || wa.length < 2) return null;
    const start = wa[0];
    const end = wa[1];
    if (typeof start !== "number" || typeof end !== "number") return null;

    const style = Array.isArray(wa[2]) ? wa[2] : [];
    let t: number | null = null;
    let url: string | undefined;

    // In JSPB wire:
    // style[2] non-null -> type 4 (inline math)
    if (style.length > 2 && style[2] !== null && style[2] !== undefined) {
        t = 4;
    } else if (style.length > 0 && Array.isArray(style[0])) {
        const s0 = style[0];
        const flag = s0.length > 4 ? s0[4] : null;
        if (flag === 2) {
            t = 0; // strong (bold)
        } else if (flag === 1) {
            t = 5; // emphasis (subtle/italic)
        }
    } else if (style.length > 1 && Array.isArray(style[1])) {
        // link url or other formatting
        const s1 = style[1];
        if (s1.length > 0 && typeof s1[0] === "string") {
            t = 6;
            url = s1[0];
        }
    }

    // Fail closed: Unknown or unsupported annotation must NEVER be coerced or guessed as bold.
    if (t === null) {
        return null;
    }

    return {
        start,
        end,
        type: t,
        ...(url ? { url } : {})
    };
}

export function decodeGeminiStructuredNode(w: unknown): GeminiStructuredNode | null {
    if (!w) return null;
    if (typeof w === "object" && !Array.isArray(w)) {
        const node = w as Record<string, unknown>;
        if (typeof node.nodeType !== "number") return null;
        switch (node.nodeType) {
            case 18: {
                if (typeof node.text !== "string") return null;
                if (Array.isArray(node.annotations)) {
                    for (const a of node.annotations) {
                        if (!decodeGeminiAnnotation(a)) return null;
                    }
                }
                return node as unknown as GeminiStructuredNode;
            }
            case 12: {
                if (typeof node.FTa !== "string") return null;
                return node as unknown as GeminiStructuredNode;
            }
            case 1: {
                if (typeof node.code !== "string") return null;
                return node as unknown as GeminiStructuredNode;
            }
            case 19:
            case 13:
            case 0:
                return node as unknown as GeminiStructuredNode;
            case 15: {
                if (!Array.isArray(node.children)) return null;
                for (const c of node.children) {
                    if (!decodeGeminiStructuredNode(c)) return null;
                }
                return node as unknown as GeminiStructuredNode;
            }
            case 20:
            case 14: {
                if (!Array.isArray(node.items)) return null;
                for (const item of node.items as any[]) {
                    if (!item || !Array.isArray(item.children)) return null;
                    for (const c of item.children) {
                        if (!decodeGeminiStructuredNode(c)) return null;
                    }
                }
                return node as unknown as GeminiStructuredNode;
            }
            case 17: {
                if (!Array.isArray(node.rows)) return null;
                for (const row of node.rows as any[]) {
                    if (!row || !Array.isArray(row.cells)) return null;
                    for (const cell of row.cells) {
                        if (!cell || !Array.isArray(cell.children)) return null;
                        for (const c of cell.children) {
                            if (!decodeGeminiStructuredNode(c)) return null;
                        }
                    }
                }
                return node as unknown as GeminiStructuredNode;
            }
            default:
                return null;
        }
    }
    if (!Array.isArray(w)) return null;

    // Field 34: Display Math
    if (w.length > 34 && w[34] !== null && w[34] !== undefined) {
        const mathPayload = w[34];
        const fta = Array.isArray(mathPayload) && mathPayload.length > 0 && typeof mathPayload[0] === "string"
            ? mathPayload[0]
            : "";
        return { nodeType: 12, FTa: fta };
    }

    // Field 23: Line break
    if (w.length > 23 && w[23] !== null && w[23] !== undefined) {
        return { nodeType: 13 };
    }

    // Field 19: Thematic break
    if (w.length > 19 && w[19] !== null && w[19] !== undefined) {
        return { nodeType: 19 };
    }

    // Field 15: Blockquote
    if (w.length > 15 && w[15] !== null && w[15] !== undefined) {
        const bqPayload = w[15];
        const rawChildren = Array.isArray(bqPayload) && bqPayload.length > 0 && Array.isArray(bqPayload[0])
            ? bqPayload[0]
            : [];
        const children: GeminiStructuredNode[] = [];
        for (const rc of rawChildren) {
            const dn = decodeGeminiStructuredNode(rc);
            if (!dn) return null; // Fail closed on unsupported nested node
            children.push(dn);
        }
        return { nodeType: 15, children };
    }

    // Field 12: Ordered list
    if (w.length > 12 && w[12] !== null && w[12] !== undefined) {
        const olPayload = w[12];
        const rawItems = Array.isArray(olPayload) && olPayload.length > 0 && Array.isArray(olPayload[0])
            ? olPayload[0]
            : [];
        const items: GeminiListItem[] = [];
        for (const rit of rawItems) {
            const rawChildren = Array.isArray(rit) && rit.length > 0 && Array.isArray(rit[0]) ? rit[0] : [];
            const children: GeminiStructuredNode[] = [];
            for (const rc of rawChildren) {
                const dn = decodeGeminiStructuredNode(rc);
                if (!dn) return null; // Fail closed on unsupported nested node
                children.push(dn);
            }
            items.push({ children });
        }
        const vha = Array.isArray(olPayload) && olPayload.length > 1 && typeof olPayload[1] === "number"
            ? olPayload[1]
            : 1;
        return { nodeType: 14, VHa: vha, items };
    }

    // Field 11: Unordered list
    if (w.length > 11 && w[11] !== null && w[11] !== undefined) {
        const ulPayload = w[11];
        const rawItems = Array.isArray(ulPayload) && ulPayload.length > 0 && Array.isArray(ulPayload[0])
            ? ulPayload[0]
            : [];
        const items: GeminiListItem[] = [];
        for (const rit of rawItems) {
            const rawChildren = Array.isArray(rit) && rit.length > 0 && Array.isArray(rit[0]) ? rit[0] : [];
            const children: GeminiStructuredNode[] = [];
            for (const rc of rawChildren) {
                const dn = decodeGeminiStructuredNode(rc);
                if (!dn) return null; // Fail closed on unsupported nested node
                children.push(dn);
            }
            items.push({ children });
        }
        return { nodeType: 20, items };
    }

    // Field 10: Table
    if (w.length > 10 && w[10] !== null && w[10] !== undefined) {
        const tblPayload = w[10];
        const rawRows = Array.isArray(tblPayload) && tblPayload.length > 0 && Array.isArray(tblPayload[0])
            ? tblPayload[0]
            : [];
        const rows: GeminiTableRow[] = [];
        for (const rr of rawRows) {
            const rawCells = Array.isArray(rr) && rr.length > 1 && Array.isArray(rr[1]) ? rr[1] : [];
            const cells: GeminiTableCell[] = [];
            for (const rc of rawCells) {
                const rawChildren = Array.isArray(rc) && rc.length > 0 && Array.isArray(rc[0]) ? rc[0] : [];
                const children: GeminiStructuredNode[] = [];
                for (const rch of rawChildren) {
                    const dn = decodeGeminiStructuredNode(rch);
                    if (!dn) return null; // Fail closed on unsupported nested node
                    children.push(dn);
                }
                const cellObj: GeminiTableCell = { children };
                if (Array.isArray(rc)) {
                    if (typeof rc[1] === "number" && rc[1] > 1) cellObj.colSpan = rc[1];
                    if (typeof rc[2] === "number" && rc[2] > 1) cellObj.rowSpan = rc[2];
                }
                cells.push(cellObj);
            }
            rows.push({ cells });
        }
        return { nodeType: 17, rows };
    }

    // Field 3: Code block
    if (w.length > 3 && w[3] !== null && w[3] !== undefined) {
        const codePayload = w[3];
        const code = Array.isArray(codePayload) && typeof codePayload[0] === "string" ? codePayload[0] : "";
        const info = Array.isArray(codePayload) && typeof codePayload[1] === "string" ? codePayload[1] : undefined;
        return { nodeType: 1, code, ...(info ? { info } : {}) };
    }

    // Field 1: Text / Heading / Paragraph
    if (w.length > 1 && w[1] !== null && w[1] !== undefined) {
        const textPayload = w[1];
        if (Array.isArray(textPayload)) {
            const text = typeof textPayload[2] === "string" ? textPayload[2] : "";
            const jJ = typeof textPayload[1] === "number" && textPayload[1] > 0 ? textPayload[1] : undefined;
            const rawAnnots = Array.isArray(textPayload[3]) ? textPayload[3] : [];
            const annotations: GeminiAnnotation[] = [];
            for (const ra of rawAnnots) {
                const da = decodeGeminiAnnotation(ra);
                if (!da) return null; // Fail closed on unknown annotation
                annotations.push(da);
            }
            return {
                nodeType: 18,
                text,
                ...(jJ ? { jJ } : {}),
                ...(annotations.length ? { annotations } : {})
            };
        }
    }

    // Field 0 or 2: Attachments / follow-up chips
    if ((w.length > 0 && w[0] !== null && typeof w[0] === 'object' && !Array.isArray(w[0])) ||
        (w.length >= 3 && w[0] === null && w[1] === null && w[2] !== null)) {
        return { nodeType: 0 };
    }

    return null;
}

export function decodeGeminiStructuredPayload(raw: unknown): GeminiStructuredDocument | null {
    if (!raw) return null;

    // Case 1: Already structured document object
    if (typeof raw === "object" && !Array.isArray(raw)) {
        const doc = raw as Record<string, unknown>;
        if (Array.isArray(doc.children)) {
            const children: GeminiStructuredNode[] = [];
            for (const ch of doc.children) {
                const node = decodeGeminiStructuredNode(ch);
                if (node) children.push(node);
                else return null;
            }
            return { children };
        }
        return null;
    }

    // Case 2: Array payload (wire format or array of nodes)
    if (Array.isArray(raw)) {
        let nodeArray: unknown[] = raw;
        // Turn field 12 envelope in JSPB: [ [ [ node_0, node_1, ... ] ] ]
        if (nodeArray.length === 1 && Array.isArray(nodeArray[0])) {
            if (nodeArray[0].length === 1 && Array.isArray(nodeArray[0][0])) {
                nodeArray = nodeArray[0][0] as unknown[];
            } else if (nodeArray[0].length > 1 && Array.isArray(nodeArray[0][0])) {
                nodeArray = nodeArray[0] as unknown[];
            }
        }

        const children: GeminiStructuredNode[] = [];
        for (const item of nodeArray) {
            const node = decodeGeminiStructuredNode(item);
            if (node) {
                children.push(node);
            } else {
                return null;
            }
        }
        return { children };
    }

    return null;
}

export function extractStructuredContent(turn: unknown, cand?: unknown, candidateIndex: number = 0): GeminiStructuredDocument | undefined {
    // 1. Check if mock / test fixture already populated structuredContent directly on cand
    if (cand && typeof cand === "object" && "structuredContent" in cand && (cand as any).structuredContent) {
        const decoded = decodeGeminiStructuredPayload((cand as any).structuredContent);
        if (decoded) return decoded;
    }

    // 2. Direct turn-attached structuredContent (test fixture / mock): only applies to primary candidate
    if (turn && typeof turn === "object" && !Array.isArray(turn) && "structuredContent" in turn && (turn as any).structuredContent) {
        if (candidateIndex === 0) {
            const decoded = decodeGeminiStructuredPayload((turn as any).structuredContent);
            if (decoded) return decoded;
        }
        return undefined;
    }

    // 3. Wire path: turn[3][12]
    // PR #705 established turn[3][12] correlation specifically for the primary model candidate (index 0).
    // Candidate 1+ must not inherit turn[3][12] without proven wire evidence.
    if (candidateIndex !== 0) {
        return undefined;
    }

    if (!Array.isArray(turn) || turn.length <= GEMINI_JSPB_SCHEMA.TURN.MODEL_PAYLOAD) {
        return undefined;
    }
    const modelPayload = turn[GEMINI_JSPB_SCHEMA.TURN.MODEL_PAYLOAD];
    if (!Array.isArray(modelPayload) || modelPayload.length <= (GEMINI_JSPB_SCHEMA.MODEL_PAYLOAD.STRUCTURED_CONTENT ?? 12)) {
        return undefined;
    }
    const rawF12 = modelPayload[GEMINI_JSPB_SCHEMA.MODEL_PAYLOAD.STRUCTURED_CONTENT ?? 12];
    if (!rawF12) return undefined;

    const decoded = decodeGeminiStructuredPayload(rawF12);
    return decoded || undefined;
}
