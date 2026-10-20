/**
 * tests/helpers/pdfTextExtract.ts
 *
 * Minimal PDF text extractor for D8 evidence tests. Scope is deliberately
 * narrow: extract selectable text from PDFs produced by the repo's own Typst
 * pipeline (subset fonts with ToUnicode CMaps, FlateDecode streams).
 *
 * NOT a general PDF parser. It exists because Tier 1 CI cannot rely on
 * pypdf/poppler; the extractor is unit-tested against known content below.
 *
 * Supported:
 *  - FlateDecode content + ToUnicode streams (zlib inflate)
 *  - Text-showing ops: Tj, TJ, ', "
 *  - Font selection: Tf (with /Resources /Font on the page)
 *  - ToUnicode bfchar / bfrange (incl. multi-byte Identity-H codes)
 *  - Fallback: WinAnsiEncoding 1-byte codes when a font has no ToUnicode
 */

export {};

const zlib = require('node:zlib');

export interface PdfObject { num: number; dict: string; stream: Buffer | null }

export function parseObjects(data: Buffer): Map<number, PdfObject> {
    const objs = new Map<number, PdfObject>();
    const text = data.toString('latin1');
    const re = /(\d+)\s+0\s+obj([\s\S]*?)endobj/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const num = parseInt(m[1], 10);
        const body = m[2];
        let stream: Buffer | null = null;
        const sm = /stream\r?\n/.exec(body);
        if (sm) {
            const streamStart = m.index + m[0].indexOf(m[2]) + sm.index + sm[0].length;
            const endIdx = text.indexOf('endstream', streamStart);
            stream = data.subarray(streamStart, endIdx);
            // strip trailing CRLF before endstream
            while (stream.length > 0 && (stream[stream.length - 1] === 0x0a || stream[stream.length - 1] === 0x0d)) {
                stream = stream.subarray(0, stream.length - 1);
            }
        }
        objs.set(num, { num, dict: body, stream });
    }
    return objs;
}

export function inflateIfNeeded(obj: PdfObject): Buffer | null {
    if (!obj.stream) return null;
    if (/\/FlateDecode/.test(obj.dict)) {
        try { return zlib.inflateSync(obj.stream); } catch { return null; }
    }
    return obj.stream;
}

export function parseHexPdfString(s: string): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i += 2) {
        bytes.push(parseInt(s.substr(i, 2), 16));
    }
    return bytes;
}

export function parseLiteralPdfString(s: string): number[] {
    // s is latin1-decoded; handle \( \) \\ escapes minimally
    const out: number[] = [];
    for (let i = 0; i < s.length; i += 1) {
        if (s[i] === '\\' && i + 1 < s.length) {
            const n = s[i + 1];
            if (n >= '0' && n <= '7') {
                // Octal escape: up to 3 octal digits (Typst emits \000\001 for 2-byte codes).
                let oct = '';
                let j = i + 1;
                while (j < s.length && oct.length < 3 && s[j] >= '0' && s[j] <= '7') {
                    oct += s[j];
                    j += 1;
                }
                out.push(parseInt(oct, 8));
                i = j - 1;
            } else if (n === 'n') { out.push(0x0a); i += 1; }
            else if (n === 'r') { out.push(0x0d); i += 1; }
            else if (n === 't') { out.push(0x09); i += 1; }
            else if (n === 'b') { out.push(0x08); i += 1; }
            else if (n === 'f') { out.push(0x0c); i += 1; }
            else if (n === '(' || n === ')' || n === '\\') { out.push(n.charCodeAt(0)); i += 1; }
            else { out.push(n.charCodeAt(0)); i += 1; }
        } else {
            out.push(s[i].charCodeAt(0) & 0xff);
        }
    }
    return out;
}

/** Parse a ToUnicode CMap stream into code->unicode-string map. Codes are hex strings (may be multi-byte). */
export function parseToUnicode(stream: Buffer): Map<string, string> {
    const map = new Map<string, string>();
    const text = stream.toString('latin1');
    const hexToStr = (hex: string): string => {
        let out = '';
        for (let i = 0; i < hex.length; i += 4) {
            out += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
        }
        return out;
    };
    const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
    let m: RegExpExecArray | null;
    while ((m = bfchar.exec(text)) !== null) {
        const line = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
        let l: RegExpExecArray | null;
        while ((l = line.exec(m[1])) !== null) {
            map.set(l[1].toUpperCase(), hexToStr(l[2]));
        }
    }
    const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = bfrange.exec(text)) !== null) {
        const rangeLine = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
        let l: RegExpExecArray | null;
        while ((l = rangeLine.exec(m[1])) !== null) {
            const lo = parseInt(l[1], 16);
            const hi = parseInt(l[2], 16);
            const codeLen = l[1].length;
            if (l[3]) {
                const dstLo = parseInt(l[3], 16);
                for (let c = lo; c <= hi; c += 1) {
                    const key = c.toString(16).toUpperCase().padStart(codeLen, '0');
                    map.set(key, hexToStr((dstLo + (c - lo)).toString(16).toUpperCase().padStart(l[3].length, '0')));
                }
            } else if (l[4]) {
                const arr = l[4].match(/<([0-9a-fA-F]+)>/g) ?? [];
                arr.forEach((h, idx) => {
                    const key = (lo + idx).toString(16).toUpperCase().padStart(codeLen, '0');
                    map.set(key, hexToStr(h.slice(1, -1)));
                });
            }
        }
    }
    return map;
}

// WinAnsiEncoding subset for fallback (ASCII range is identity; map common extras minimally)
function winAnsiFallback(code: number): string {
    if (code < 128) return String.fromCharCode(code);
    const extra: Record<number, number> = { 0x2013: 0x2013 };
    return String.fromCharCode(extra[code] ?? code);
}

export function decodeBytes(bytes: number[], toUnicode: Map<string, string> | null): string {
    if (toUnicode && toUnicode.size > 0) {
        // Determine code length from the first key.
        const firstKey = toUnicode.keys().next().value as string;
        const codeLen = firstKey.length; // hex chars
        const codeBytes = codeLen / 2;
        let out = '';
        for (let i = 0; i + codeBytes <= bytes.length; i += codeBytes) {
            const key = bytes.slice(i, i + codeBytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
            const uni = toUnicode.get(key);
            out += uni !== undefined ? uni : '�';
        }
        return out;
    }
    return bytes.map(winAnsiFallback).join('');
}

export function tokenizeContent(content: string): string[] {
    // Manual scanner (not a single regex): literal strings may contain RAW
    // balanced '(' / ')' bytes (Typst emits CID bytes 0x28/0x29 unescaped,
    // legal per PDF 7.3.4.2), which a flat regex cannot match.
    const tokens: string[] = [];
    let i = 0;
    const n = content.length;
    const isWs = (c: string): boolean =>
        c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\0';
    const isDelim = (c: string): boolean => c === '<' || c === '>' || c === '[' || c === ']' || c === '(' || c === ')' || c === '/';
    while (i < n) {
        const c = content[i];
        if (isWs(c)) { i += 1; continue; }
        if (c === '%') {
            while (i < n && content[i] !== '\n' && content[i] !== '\r') i += 1;
            continue;
        }
        if (c === '(') {
            let j = i + 1;
            let depth = 1;
            while (j < n && depth > 0) {
                const d = content[j];
                if (d === '\\') { j += 2; continue; }
                if (d === '(') depth += 1;
                else if (d === ')') depth -= 1;
                j += 1;
            }
            tokens.push(content.slice(i, j));
            i = j;
            continue;
        }
        if (c === '<') {
            if (content[i + 1] === '<') { tokens.push('<<'); i += 2; continue; }
            const j = content.indexOf('>', i + 1);
            const end = j === -1 ? n : j + 1;
            tokens.push(content.slice(i, end));
            i = end;
            continue;
        }
        if (c === '>') {
            if (content[i + 1] === '>') { tokens.push('>>'); i += 2; continue; }
            tokens.push('>'); i += 1; continue;
        }
        if (c === '[' || c === ']') { tokens.push(c); i += 1; continue; }
        let j = i + (c === '/' ? 1 : 0);
        while (j < n && !isWs(content[j]) && !isDelim(content[j])) j += 1;
        if (j > i) tokens.push(content.slice(i, j));
        else i += 1; // unreachable defensive
        i = j > i ? j : i + 1;
    }
    return tokens;
}

export interface ExtractedPdf {
    text: string;
    pageCount: number;
    imageXObjectCount: number;
    fonts: string[];
}

/** Extract selectable text from a PDF. */
export function extractPdfText(pdfBytes: Uint8Array): ExtractedPdf {
    const data = Buffer.from(pdfBytes);
    const objs = parseObjects(data);

    // Build font info: resource name -> { toUnicode, baseFont }
    const fontInfo = new Map<string, { toUnicode: Map<string, string> | null; baseFont: string }>();
    const fonts: string[] = [];
    for (const obj of objs.values()) {
        if (/\/Type\s*\/Font/.test(obj.dict) || /\/BaseFont/.test(obj.dict)) {
            const baseFont = (/\/BaseFont\s*\/(\S+)/.exec(obj.dict) ?? [])[1] ?? 'unknown';
            fonts.push(baseFont);
            const tuRef = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(obj.dict);
            let toUnicode: Map<string, string> | null = null;
            if (tuRef) {
                const tuObj = objs.get(parseInt(tuRef[1], 10));
                if (tuObj) {
                    const inflated = inflateIfNeeded(tuObj);
                    if (inflated) toUnicode = parseToUnicode(inflated);
                }
            }
            fontInfo.set(String(obj.num), { toUnicode, baseFont });
        }
    }

    // Map resource name (/F1) -> font object num via page /Resources.
    let imageXObjectCount = 0;
    let pageCount = 0;
    const pageText: string[] = [];
    for (const obj of objs.values()) {
        if (/\/Type\s*\/Page[^s]/.test(obj.dict)) {
            pageCount += 1;
            const resName2num = new Map<string, number>();
            const fontSec = /\/Font\s*<<([\s\S]*?)>>/.exec(obj.dict);
            if (fontSec) {
                const r = /\/(\S+)\s+(\d+)\s+0\s+R/g;
                let fm: RegExpExecArray | null;
                while ((fm = r.exec(fontSec[1])) !== null) resName2num.set(fm[1], parseInt(fm[2], 10));
            }
            const xobjSec = /\/XObject\s*<<([\s\S]*?)>>/.exec(obj.dict);
            if (xobjSec) {
                const r = /\/(\S+)\s+(\d+)\s+0\s+R/g;
                let xm: RegExpExecArray | null;
                while ((xm = r.exec(xobjSec[1])) !== null) {
                    const xobj = objs.get(parseInt(xm[2], 10));
                    if (xobj && /\/Subtype\s*\/Image/.test(xobj.dict)) imageXObjectCount += 1;
                }
            }
            const contentRefs: number[] = [];
            const c1 = /\/Contents\s+(\d+)\s+0\s+R/.exec(obj.dict);
            const cArr = /\/Contents\s*\[([^\]]*)\]/.exec(obj.dict);
            if (c1) contentRefs.push(parseInt(c1[1], 10));
            if (cArr) {
                const r = /(\d+)\s+0\s+R/g;
                let cm: RegExpExecArray | null;
                while ((cm = r.exec(cArr[1])) !== null) contentRefs.push(parseInt(cm[1], 10));
            }
            let currentFont: { toUnicode: Map<string, string> | null } | null = null;
            for (const ref of contentRefs) {
                const cObj = objs.get(ref);
                if (!cObj) continue;
                const inflated = inflateIfNeeded(cObj);
                if (!inflated) continue;
                const tokens = tokenizeContent(inflated.toString('latin1'));
                let i = 0;
                const stack: string[] = [];
                const markedContentStack: Array<{ actualText: string | null }> = [];
                while (i < tokens.length) {
                    const t = tokens[i];
                    if (t === 'BDC' || t === 'BMC') {
                        let actualText: string | null = null;
                        const actIdx = stack.lastIndexOf('/ActualText');
                        if (actIdx !== -1 && actIdx + 1 < stack.length) {
                            actualText = parseActualTextString(stack[actIdx + 1]);
                        }
                        markedContentStack.push({ actualText });
                        stack.length = 0;
                    } else if (t === 'EMC') {
                        const entry = markedContentStack.pop();
                        if (entry && entry.actualText != null) {
                            pageText.push(entry.actualText);
                        }
                        stack.length = 0;
                    } else if (t === 'Tj' || t === "'") {
                        const s = stack.pop() ?? '';
                        if (!markedContentStack.some(m => m.actualText != null)) {
                            pageText.push(renderStringToken(s, currentFont));
                        }
                        stack.length = 0;
                    } else if (t === '"') {
                        // " : aw ac string " — discard word/char spacing, show string.
                        const s = stack.pop() ?? '';
                        stack.pop(); stack.pop();
                        if (!markedContentStack.some(m => m.actualText != null)) {
                            pageText.push(renderStringToken(s, currentFont));
                        }
                        stack.length = 0;
                    } else if (t === 'TJ') {
                        // Stack holds: '[', elements..., ']'. Render in order.
                        const elems: string[] = [];
                        while (stack.length > 0) {
                            const e = stack.pop() as string;
                            if (e === '[') break;
                            if (e !== ']') elems.unshift(e);
                        }
                        if (!markedContentStack.some(m => m.actualText != null)) {
                            let out = '';
                            for (const e of elems) {
                                if (e.startsWith('<') || e.startsWith('(')) out += renderStringToken(e, currentFont);
                            }
                            pageText.push(out);
                        }
                        stack.length = 0;
                    } else if (t === 'Tf') {
                        const size = stack.pop();
                        const name = (stack.pop() ?? '').replace(/^\//, '');
                        const num = resName2num.get(name);
                        currentFont = num !== undefined ? (fontInfo.get(String(num)) ?? null) : null;
                        void size;
                    } else if (t === 'BT' || t === 'ET') {
                        stack.length = 0;
                    } else {
                        stack.push(t);
                    }
                    i += 1;
                }
            }
        }
    }

    return { text: pageText.join(''), pageCount, imageXObjectCount, fonts };
}

function parseActualTextString(raw: string): string {
    if (raw.startsWith('(')) {
        const bytes = parseLiteralPdfString(raw.slice(1, -1));
        if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
            let out = '';
            for (let i = 2; i + 1 < bytes.length; i += 2) {
                out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
            }
            return out;
        }
        return bytes.map(b => String.fromCharCode(b)).join('');
    } else if (raw.startsWith('<')) {
        const bytes = parseHexPdfString(raw.slice(1, -1).replace(/\s+/g, ''));
        if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
            let out = '';
            for (let i = 2; i + 1 < bytes.length; i += 2) {
                out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
            }
            return out;
        }
        return bytes.map(b => String.fromCharCode(b)).join('');
    }
    return '';
}

function renderStringToken(token: string, font: { toUnicode: Map<string, string> | null } | null): string {
    let bytes: number[];
    if (token.startsWith('<')) {
        bytes = parseHexPdfString(token.slice(1, -1).replace(/\s+/g, ''));
    } else if (token.startsWith('(')) {
        bytes = parseLiteralPdfString(token.slice(1, -1));
    } else {
        return '';
    }
    return decodeBytes(bytes, font?.toUnicode ?? null);
}

