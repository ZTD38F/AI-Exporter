import { extractImageEvidence, type ImageAttachment } from "./sourceAttachments.js";
import { isJsonValue, type JsonValue } from "../../../../shared/utils/jsonTypes.js";

export interface GeminiAnnotation {
    start: number;
    end: number;
    type: number | 'source';
    sourceIds?: string[];
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

interface GeminiTableCell {
    children: GeminiStructuredNode[];
    colSpan?: number;
    rowSpan?: number;
}

interface GeminiTableRow {
    cells: GeminiTableCell[];
}

export interface GeminiTableNode {
    nodeType: 17;
    rows: GeminiTableRow[];
}

interface GeminiListItem {
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
    /** Resource facts are decoded at attachment ingress, before typed traversal. */
    images?: ImageAttachment[];
}

export interface GeminiFileNode { nodeType: 24; id: string; title: string }

/** Inline fragments share one paragraph; wire field 13 is not a line break. */
export interface GeminiCompositeParagraph { nodeType: 'paragraph'; children: GeminiStructuredNode[] }
export interface GeminiFileCitation { nodeType: 'citation'; number: number; title: string }
export interface GeminiCitationGroup { nodeType: 'citationGroup'; children: GeminiFileCitation[] }

export type GeminiStructuredNode =
    | GeminiCompositeParagraph
    | GeminiFileCitation
    | GeminiCitationGroup
    | GeminiTextNode
    | GeminiMathBlockNode
    | GeminiCodeBlockNode
    | GeminiThematicBreakNode
    | GeminiLineBreakNode
    | GeminiTableNode
    | GeminiUnorderedListNode
    | GeminiOrderedListNode
    | GeminiQuoteNode
    | GeminiAttachmentNode
    | GeminiFileNode;

export interface GeminiStructuredDocument {
    children: GeminiStructuredNode[];
}

/** Local diagnostic evidence. Raw values may contain source text, URLs and file tokens. */
export interface GeminiStructuredDecodeIssue {
    kind: 'annotation' | 'node' | 'payload';
    nodeType?: number;
    fields?: number[];
    styleFlag?: number;
    rawValue?: JsonValue;
    /** JSON Pointer relative to rawDocument; the empty string denotes its root. */
    path?: string;
}

type DecodeIssues = GeminiStructuredDecodeIssue[];

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Wire values remain untrusted through every JSPB array check. This
 * narrowing prevents unchecked nested fields from bypassing validation. */
function isWireArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

/** Source annotations in both RPC wire tuples and runtime objects use
 * the same source-ID grammar and never leak unchecked arrays. */
function decodeSourceIds(value: unknown): string[] | null {
    if (!isWireArray(value) || value.length === 0) return null;
    return value.every((id): id is string => typeof id === 'string' && /^spp_[\w-]+$/.test(id))
        ? [...value] : null;
}

export function decodeGeminiAnnotation(wa: unknown, issues?: DecodeIssues): GeminiAnnotation | null {
    const decoded = decodeAnnotation(wa);
    if (!decoded && issues && !issues.length) {
        const flag = isWireArray(wa) && isWireArray(wa[2]) && isWireArray(wa[2][0]) ? wa[2][0][4] : undefined;
        issues.push({ kind: 'annotation', ...(typeof flag === 'number' ? { styleFlag: flag } : {}),
            ...(isJsonValue(wa) ? { rawValue: wa } : {}) });
    }
    return decoded;
}

function decodeAnnotation(wa: unknown): GeminiAnnotation | null {
    if (!wa) return null;
    if (isRecord(wa)) {
        const d = wa;
        const start = d.start;
        const end = d.end;
        const type = d.type;
        if (typeof start === 'number' && typeof end === 'number' && type === 'source') {
            const sourceIds = decodeSourceIds(d.sourceIds);
            if (sourceIds) return { start, end, type, sourceIds };
        }
        if (typeof start === "number" && typeof end === "number" && typeof type === "number") {
            if ([0, 2, 4, 5, 6, 7, 12].includes(type)) {
                return {
                    start,
                    end,
                    type,
                    ...(typeof d.url === "string" ? { url: d.url } : {})
                };
            }
        }
        return null;
    }
    if (!isWireArray(wa) || wa.length < 2) return null;
    const slots = wa;
    const start = slots[0];
    const end = slots[1];
    if (typeof start !== "number" || typeof end !== "number") return null;

    const rawStyle = slots[2];
    const style = isWireArray(rawStyle) ? rawStyle : [];
    const attribution = style[3];
    if (isWireArray(attribution)) {
        const attributionSlots = attribution;
        if (attributionSlots.length === 2 && attributionSlots[0] === null) {
            const sourceIds = decodeSourceIds(attributionSlots[1]);
            if (sourceIds && style.every((value, index) => value == null || index === 3)) {
                return { start, end, type: 'source', sourceIds };
            }
        }
    }
    if (attribution != null) return null;
    let t: number | null = null;
    let url: string | undefined;

    if (style.length > 2 && style[2] !== null && style[2] !== undefined) {
        t = 4;
    } else if (style.length > 0 && isWireArray(style[0])) {
        const s0 = style[0];
        const flag = s0.length > 4 ? s0[4] : null;
        if (flag === 2) {
            t = 0; // strong (bold)
        } else if (flag === 1) {
            t = 5; // emphasis (subtle/italic)
        } else if (flag === 3) {
            t = 7; // inline code; captured RPC style flag, not internal annotation enum
        }
    } else if (style.length > 1 && isWireArray(style[1])) {
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

export function decodeGeminiStructuredNode(w: unknown, issues?: DecodeIssues): GeminiStructuredNode | null {
    const decoded = decodeStructuredNode(w, issues);
    if (!decoded && issues && !issues.length) {
        const nodeType = isRecord(w) ? w.nodeType : undefined;
        issues.push({ kind: 'node',
            ...(typeof nodeType === 'number' ? { nodeType } : {}),
            ...(isWireArray(w) ? { fields: w.flatMap((value, index) => value == null ? [] : [index]) } : {}),
            ...(isJsonValue(w) ? { rawValue: w } : {}),
        });
    }
    return decoded;
}

function decodeStructuredNode(w: unknown, issues?: DecodeIssues): GeminiStructuredNode | null {
    if (!w) return null;
    if (isRecord(w)) {
        const node = w;
        const nodeType = node.nodeType;
        switch (nodeType) {
            case 'citationGroup': {
                if (!isWireArray(node.children) || !node.children.length) return null;
                const children: GeminiFileCitation[] = [];
                for (const child of node.children) {
                    const decoded = decodeGeminiStructuredNode(child, issues);
                    if (decoded?.nodeType !== 'citation') return null;
                    children.push(decoded);
                }
                return { nodeType, children };
            }
            case 'paragraph': {
                if (!isWireArray(node.children)) return null;
                const children: GeminiStructuredNode[] = [];
                for (const child of node.children) {
                    const decoded = decodeGeminiStructuredNode(child, issues);
                    if (!decoded) return null;
                    children.push(decoded);
                }
                return { nodeType, children };
            }
            case 'citation': {
                const number = node.number;
                return Number.isSafeInteger(number) && typeof number === 'number' && number > 0 && typeof node.title === 'string' && node.title
                    ? { nodeType, number, title: node.title } : null;
            }
            case 18: {
                if (typeof node.text !== "string") return null;
                if (node.annotations !== undefined && !isWireArray(node.annotations)) return null;
                let annotations: GeminiAnnotation[] | undefined;
                if (isWireArray(node.annotations)) {
                    annotations = [];
                    for (const a of node.annotations) {
                        const decoded = decodeGeminiAnnotation(a, issues);
                        if (!decoded) return null;
                        annotations.push(decoded);
                    }
                }
                return {
                    nodeType: 18,
                    text: node.text,
                    ...(typeof node.jJ === "number" ? { jJ: node.jJ } : {}),
                    ...(annotations !== undefined ? { annotations } : {})
                };
            }
            case 12: {
                if (typeof node.FTa !== "string") return null;
                return { nodeType: 12, FTa: node.FTa };
            }
            case 1: {
                if (typeof node.code !== "string") return null;
                return {
                    nodeType: 1,
                    code: node.code,
                    ...(typeof node.info === "string" ? { info: node.info } : {})
                };
            }
            case 24:
                return typeof node.id === 'string' && node.id && typeof node.title === 'string'
                    ? { nodeType: 24, id: node.id, title: node.title } : null;
            case 19:
            case 13:
            case 0:
                if (nodeType === 19) return { nodeType: 19 };
                if (nodeType === 13) return { nodeType: 13 };
                const rawXj = node.Xj;
                if (rawXj === undefined) return { nodeType: 0 };
                if (!isWireArray(rawXj)) return null;
                for (const entry of rawXj) {
                    if (!isJsonValue(entry) || !isRecord(entry)) return null;
                }
                return { nodeType: 0, images: extractImageEvidence(rawXj) };
            case 15: {
                if (!isWireArray(node.children)) return null;
                const children: GeminiStructuredNode[] = [];
                for (const c of node.children) {
                    const decoded = decodeGeminiStructuredNode(c, issues);
                    if (!decoded) return null;
                    children.push(decoded);
                }
                return { nodeType: 15, children };
            }
            case 20:
            case 14: {
                if (!isWireArray(node.items)) return null;
                const items: GeminiListItem[] = [];
                for (const item of node.items) {
                    if (!isRecord(item)) return null;
                    const itemRecord = item;
                    if (!isWireArray(itemRecord.children)) return null;
                    const children: GeminiStructuredNode[] = [];
                    for (const c of itemRecord.children) {
                        const decoded = decodeGeminiStructuredNode(c, issues);
                        if (!decoded) return null;
                        children.push(decoded);
                    }
                    items.push({ children });
                }
                return nodeType === 20
                    ? { nodeType: 20, items }
                    : { nodeType: 14, items, ...(typeof node.VHa === "number" ? { VHa: node.VHa } : {}) };
            }
            case 17: {
                if (!isWireArray(node.rows)) return null;
                const rows: GeminiTableRow[] = [];
                for (const row of node.rows) {
                    if (!isRecord(row)) return null;
                    const rawCells = row.cells;
                    if (!isWireArray(rawCells)) return null;
                    const cells: GeminiTableCell[] = [];
                    for (const cell of rawCells) {
                        if (!isRecord(cell)) return null;
                        const cellRecord = cell;
                        if (!isWireArray(cellRecord.children)) return null;
                        const children: GeminiStructuredNode[] = [];
                        for (const c of cellRecord.children) {
                            const decoded = decodeGeminiStructuredNode(c, issues);
                            if (!decoded) return null;
                            children.push(decoded);
                        }
                        cells.push({
                            children,
                            ...(typeof cellRecord.colSpan === "number" ? { colSpan: cellRecord.colSpan } : {}),
                            ...(typeof cellRecord.rowSpan === "number" ? { rowSpan: cellRecord.rowSpan } : {})
                        });
                    }
                    rows.push({ cells });
                }
                return { nodeType: 17, rows };
            }
            default:
                return null;
        }
    }
    if (!isWireArray(w)) return null;

    // Captured file citation. The quote is source metadata, never visible body text.
    if (w[31] != null) {
        const payload = w[31];
        if (!w.every((value, index) => value == null || index === 31)
            || !isWireArray(payload) || payload.length !== 1) return null;
        const citation = payload[0];
        if (!isWireArray(citation) || citation.length !== 3
            || !isWireArray(citation[0]) || citation[0].length !== 2 || citation[0][1] !== 0
            || typeof citation[0][0] !== 'string'
            || !isWireArray(citation[1]) || !citation[1].length
            || !isWireArray(citation[2]) || citation[2].length !== 2
            || typeof citation[2][0] !== 'string' || citation[2][1] !== 0) return null;
        const match = /^\[cite:\s*(\d+(?:\s*,\s*\d+)*)\]$/i.exec(citation[0][0]);
        if (!match) return null;
        const numbers = match[1].split(',').map(Number);
        if (numbers.length !== citation[1].length || new Set(numbers).size !== numbers.length
            || numbers.some(number => !Number.isSafeInteger(number) || number < 1)) return null;
        const children: GeminiFileCitation[] = [];
        for (const [index, source] of citation[1].entries()) {
            const file = isWireArray(source) && source.length === 2 && source[0] === null ? source[1] : undefined;
            const metadata = isWireArray(file) ? file[0] : undefined;
            if (!isWireArray(file) || typeof file[6] !== 'string' || !file[6]
                || !isWireArray(metadata) || metadata[2] !== file[6]
                || typeof metadata[11] !== 'string') return null;
            children.push({ nodeType: 'citation', number: numbers[index], title: file[6] });
        }
        return children.length === 1 ? children[0] : { nodeType: 'citationGroup', children };
    }

    if (w[13] != null) {
        const payload = w[13];
        if (!w.every((value, index) => value == null || index === 13)
            || !isWireArray(payload) || payload.length !== 1 || !isWireArray(payload[0]) || !payload[0].length) return null;
        const children: GeminiStructuredNode[] = [];
        for (const raw of payload[0]) {
            const child = decodeGeminiStructuredNode(raw, issues);
            if (!child) return null;
            children.push(child);
        }
        return { nodeType: 'paragraph', children };
    }

    if (w.length > 34 && w[34] !== null && w[34] !== undefined) {
        const mathPayload = w[34];
        const fta = isWireArray(mathPayload) && mathPayload.length > 0 && typeof mathPayload[0] === "string"
            ? mathPayload[0]
            : "";
        return { nodeType: 12, FTa: fta };
    }

    // A generated code-document chip retains its position and source identity.
    if (isWireArray(w[24]) && w[24].length === 1) {
        const chip = w[24][0];
        if (isWireArray(chip) && chip[7] === 26 && typeof chip[1] === 'string' && chip[1]
            && typeof chip[3] === 'string') return { nodeType: 24, id: chip[1], title: chip[3] };
        return null;
    }

    if (w.length > 23 && w[23] !== null && w[23] !== undefined) {
        return { nodeType: 13 };
    }

    if (w.length > 19 && w[19] !== null && w[19] !== undefined) {
        return { nodeType: 19 };
    }

    // Captured native blockquote (field 16); field 15 is a legacy encoding.
    if (w[16] != null) {
        const payload = w[16];
        if (!w.every((value, index) => value == null || index === 16)
            || !isWireArray(payload) || payload.length !== 1
            || !isWireArray(payload[0]) || !payload[0].length) return null;
        const children: GeminiStructuredNode[] = [];
        for (const raw of payload[0]) {
            const child = decodeGeminiStructuredNode(raw, issues);
            if (!child) return null;
            children.push(child);
        }
        return { nodeType: 15, children };
    }

    if (w.length > 15 && w[15] !== null && w[15] !== undefined) {
        const bqPayload = w[15];
        const rawChildren = isWireArray(bqPayload) && bqPayload.length > 0 && isWireArray(bqPayload[0])
            ? bqPayload[0]
            : [];
        const children: GeminiStructuredNode[] = [];
        for (const rc of rawChildren) {
            const dn = decodeGeminiStructuredNode(rc, issues);
            if (!dn) return null; // Fail closed on unsupported nested node
            children.push(dn);
        }
        return { nodeType: 15, children };
    }

    if (w.length > 12 && w[12] !== null && w[12] !== undefined) {
        const olPayload = w[12];
        const rawItems = isWireArray(olPayload) && olPayload.length > 0 && isWireArray(olPayload[0])
            ? olPayload[0]
            : [];
        const items: GeminiListItem[] = [];
        for (const rit of rawItems) {
            const rawChildren = isWireArray(rit) && rit.length > 0 && isWireArray(rit[0]) ? rit[0] : [];
            const children: GeminiStructuredNode[] = [];
            for (const rc of rawChildren) {
                const dn = decodeGeminiStructuredNode(rc, issues);
                if (!dn) return null; // Fail closed on unsupported nested node
                children.push(dn);
            }
            items.push({ children });
        }
        const vha = isWireArray(olPayload) && olPayload.length > 1 && typeof olPayload[1] === "number"
            ? olPayload[1]
            : 1;
        return { nodeType: 14, VHa: vha, items };
    }

    if (w.length > 11 && w[11] !== null && w[11] !== undefined) {
        const ulPayload = w[11];
        const rawItems = isWireArray(ulPayload) && ulPayload.length > 0 && isWireArray(ulPayload[0])
            ? ulPayload[0]
            : [];
        const items: GeminiListItem[] = [];
        for (const rit of rawItems) {
            const rawChildren = isWireArray(rit) && rit.length > 0 && isWireArray(rit[0]) ? rit[0] : [];
            const children: GeminiStructuredNode[] = [];
            for (const rc of rawChildren) {
                const dn = decodeGeminiStructuredNode(rc, issues);
                if (!dn) return null; // Fail closed on unsupported nested node
                children.push(dn);
            }
            items.push({ children });
        }
        return { nodeType: 20, items };
    }

    if (w.length > 10 && w[10] !== null && w[10] !== undefined) {
        const tblPayload = w[10];
        const rawRows = isWireArray(tblPayload) && tblPayload.length > 0 && isWireArray(tblPayload[0])
            ? tblPayload[0]
            : [];
        const rows: GeminiTableRow[] = [];
        for (const rr of rawRows) {
            const rawCells = isWireArray(rr) && rr.length > 1 && isWireArray(rr[1]) ? rr[1] : [];
            const cells: GeminiTableCell[] = [];
            for (const rc of rawCells) {
                const rawChildren = isWireArray(rc) && rc.length > 0 && isWireArray(rc[0]) ? rc[0] : [];
                const children: GeminiStructuredNode[] = [];
                for (const rch of rawChildren) {
                    const dn = decodeGeminiStructuredNode(rch, issues);
                    if (!dn) return null; // Fail closed on unsupported nested node
                    children.push(dn);
                }
                const cellObj: GeminiTableCell = { children };
                if (isWireArray(rc)) {
                    if (typeof rc[1] === "number" && rc[1] > 1) cellObj.colSpan = rc[1];
                    if (typeof rc[2] === "number" && rc[2] > 1) cellObj.rowSpan = rc[2];
                }
                cells.push(cellObj);
            }
            rows.push({ cells });
        }
        return { nodeType: 17, rows };
    }

    // Captured Imagen resource panel (field 9). Its image files are bound by
    // the shared resource pipeline, just like other nodeType 0 attachments.
    // Decode resource facts here; prompt/UI metadata is not a body node.
    if (isWireArray(w[9]) && w[9].length === 1 && isWireArray(w[9][0]) && w[9][0].length > 0) {
        const panels = w[9][0];
        const knownPanels = w.every((value, index) => value == null || index === 9) && panels.every(panel => isWireArray(panel) && panel.length === 12
            && isWireArray(panel[0]) && isWireArray(panel[1])
            && typeof panel[1][0] === 'string'
            && /^https?:\/\/googleusercontent\.com\/image_generation_content\//.test(panel[1][0])
            && extractImageEvidence(panel[0]).some(image => image.isGenerated));
        if (knownPanels && isJsonValue(w[9])) {
            return { nodeType: 0, images: extractImageEvidence(w[9]) };
        }
        return null;
    }

    if (w.length > 3 && w[3] !== null && w[3] !== undefined) {
        const codePayload = w[3];
        const code = isWireArray(codePayload) && typeof codePayload[0] === "string" ? codePayload[0] : "";
        const info = isWireArray(codePayload) && typeof codePayload[1] === "string" ? codePayload[1] : undefined;
        return { nodeType: 1, code, ...(info ? { info } : {}) };
    }

    if (w.length > 1 && w[1] !== null && w[1] !== undefined) {
        const textPayload = w[1];
        if (isWireArray(textPayload)) {
            const text = typeof textPayload[2] === "string" ? textPayload[2] : "";
            const jJ = typeof textPayload[1] === "number" && textPayload[1] > 0 ? textPayload[1] : undefined;
            const rawAnnots = isWireArray(textPayload[3]) ? textPayload[3] : [];
            const annotations: GeminiAnnotation[] = [];
            for (const ra of rawAnnots) {
                const da = decodeGeminiAnnotation(ra, issues);
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

    // Captured live execution panels use extension 39 in the field-0 envelope.
    // Preserve their original code/stdout fence identity instead of treating
    // every extension object as an attachment and silently dropping its body.
    const extension = w[0];
    if (extension && typeof extension === 'object' && !isWireArray(extension) && '39' in extension) {
        const event = extension['39'];
        if (!isWireArray(event)) return null;
        const eventSlots = event;
        if (eventSlots.length !== 5 || typeof eventSlots[0] !== 'string'
            || typeof eventSlots[1] !== 'string' || !/^[\w+-]+$/.test(eventSlots[1])
            || !Number.isInteger(eventSlots[2])) return null;
        const eventIndex = eventSlots[2];
        if (typeof eventIndex !== 'number' || eventIndex < 1 || eventSlots[3] !== null) return null;
        if (eventSlots[4] !== 0 && eventSlots[4] !== 1) return null;
        return { nodeType: 1, code: eventSlots[0],
            info: `${eventSlots[1]}?${eventSlots[4] === 0 ? 'code_reference' : 'code_stdout'}&code_event_index=${eventIndex}` };
    }

    if ((w.length > 0 && w[0] !== null && typeof w[0] === 'object' && !isWireArray(w[0])) ||
        (w.length >= 3 && w[0] === null && w[1] === null && w[2] !== null)) {
        return { nodeType: 0 };
    }

    return null;
}

export function decodeGeminiStructuredPayload(raw: unknown, issues?: DecodeIssues): GeminiStructuredDocument | null {
    if (!raw) return null;

    if (isRecord(raw)) {
        const doc = raw;
        if (isWireArray(doc.children)) {
            const children: GeminiStructuredNode[] = [];
            for (const ch of doc.children) {
                const node = decodeGeminiStructuredNode(ch, issues);
                if (node) children.push(node);
                else return null;
            }
            return { children };
        }
        return null;
    }

    if (isWireArray(raw)) {
        let nodeArray = raw;
        // Captured Imagen documents add an empty metadata trailer: [[[nodes]], []].
        // Nonempty trailers remain unsupported; never discard unknown metadata.
        if (nodeArray.length === 2 && isWireArray(nodeArray[1]) && nodeArray[1].length === 0
            && isWireArray(nodeArray[0]) && nodeArray[0].length === 1 && isWireArray(nodeArray[0][0])) {
            nodeArray = [nodeArray[0]];
        }
        if (nodeArray.length === 1 && isWireArray(nodeArray[0])) {
            if (nodeArray[0].length === 1 && isWireArray(nodeArray[0][0])) {
                nodeArray = nodeArray[0][0];
            } else if (nodeArray[0].length > 1 && isWireArray(nodeArray[0][0])) {
                nodeArray = nodeArray[0];
            }
        }

        const children: GeminiStructuredNode[] = [];
        for (const item of nodeArray) {
            const node = decodeGeminiStructuredNode(item, issues);
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

export type GeminiStructuredExtraction =
    | { status: 'decoded'; document: GeminiStructuredDocument }
    | { status: 'missing' | 'candidate_unmatched' }
    | { status: 'decode_rejected'; issue: GeminiStructuredDecodeIssue; rawDocument?: JsonValue };

/** Find the rejected object by identity, keeping its original parent/wire positions.
 * Primitive equality cannot establish a unique source location. */
function rejectedValuePath(document: JsonValue, target: JsonValue, path = ''): string | undefined {
    if (document === target) return path;
    if (document === null || typeof document !== 'object') return undefined;
    for (const [key, value] of Object.entries(document)) {
        const found = rejectedValuePath(value, target, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
        if (found !== undefined) return found;
    }
    return undefined;
}

/** Source ownership comes from decodeTurn; never re-interpret the raw Turn. */
interface GeminiStructuredEvidenceInput {
    turnDocument: unknown;
    candidateIndex: number;
}

export function inspectStructuredContent(input: GeminiStructuredEvidenceInput): GeminiStructuredExtraction {
    // Turn-level document field 12 belongs only to primary Candidate 0 (PR #705).
    if (input.turnDocument == null) return { status: 'missing' };
    if (input.candidateIndex !== 0) return { status: 'candidate_unmatched' };
    const issues: DecodeIssues = [];
    const document = decodeGeminiStructuredPayload(input.turnDocument, issues);
    if (document) return { status: 'decoded', document };
    const issue = issues[0] ?? { kind: 'payload' };
    if (!isJsonValue(input.turnDocument)) return { status: 'decode_rejected', issue };
    if (!issues.length) { issue.rawValue = input.turnDocument; issue.path = ''; }
    else if (issue.rawValue !== null && typeof issue.rawValue === 'object') {
        issue.path = rejectedValuePath(input.turnDocument, issue.rawValue);
    }
    return { status: 'decode_rejected', issue, rawDocument: input.turnDocument };
}
