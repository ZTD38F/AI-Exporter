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

interface PdfObject { num: number; dict: string; stream: Buffer | null }

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
            const length = /\/Length\s+(\d+)(?:\s+(\d+)\s+R)?/.exec(body.slice(0, sm.index));
            if (length && length[2] === undefined) {
                // Compressed data can legitimately end in CR/LF. /Length counts
                // binary bytes; trimming them corrupts the stream and hides pages.
                stream = data.subarray(streamStart, streamStart + Number(length[1]));
            } else {
                const endIdx = text.indexOf('endstream', streamStart);
                stream = data.subarray(streamStart, endIdx);
                if (stream.subarray(-2).equals(Buffer.from('\r\n'))) stream = stream.subarray(0, -2);
                else if (stream[stream.length - 1] === 0x0a) stream = stream.subarray(0, -1);
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

function dictionaryValue(dictionary: string, key: string): string {
    const tokens = tokenizeContent(dictionary);
    let depth = 0, arrays = 0;
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token === '<<') depth++;
        else if (token === '>>') depth--;
        else if (token === '[') arrays++;
        else if (token === ']') arrays--;
        else if (depth === 1 && arrays === 0 && token === key) {
            let end = index + 1;
            const start = tokens[end];
            if (start === '[' || start === '<<') {
                let nested = 0;
                const close = start === '[' ? ']' : '>>';
                for (; end < tokens.length; end++) {
                    if (tokens[end] === start) nested++;
                    if (tokens[end] === close) { nested--; if (nested === 0) break; }
                }
            } else if (tokens[end + 1] === '0' && tokens[end + 2] === 'R') end += 2;
            return tokens.slice(index + 1, end + 1).join(' ');
        }
    }
    return '';
}

function structureChildren(element: PdfObject, page: string | null): Array<{ ref?: number; key?: string }> {
    const kids = dictionaryValue(element.dict, '/K');
    const tokens = /<<[\s\S]*?>>|(\d+)\s+0\s+R|(\d+)/g;
    const values: Array<{ ref?: number; key?: string }> = [];
    let token: RegExpExecArray | null;
    while ((token = tokens.exec(kids)) !== null) {
        if (token[1]) values.push({ ref: Number(token[1]) });
        else if (token[2] && page) values.push({ key: `${page}:${token[2]}` });
        else if (token[0].startsWith('<<')) {
            const targetPage = /\/Pg\s+(\d+)\s+0\s+R/.exec(token[0])?.[1] ?? page;
            const mcid = /\/MCID\s+(\d+)/.exec(token[0])?.[1];
            if (targetPage && mcid) values.push({ key: `${targetPage}:${mcid}` });
        }
    }
    return values;
}

interface PdfContentRun { kind: 'text' | 'math' | 'code'; text: string; group: number | null }

interface ExtractedPdf {
    text: string;
    contentRuns: PdfContentRun[];
    pageCount: number;
    imageXObjectCount: number;
    fonts: string[];
}

/** Extract selectable text from a PDF. */
export function extractPdfText(pdfBytes: Uint8Array, honorActualText = true): ExtractedPdf {
    const data = Buffer.from(pdfBytes);
    const objs = parseObjects(data);

    // Resolve marked content to its independent PDF structure ancestry. The
    // production renderer is not used to reconstruct expected message text.
    const contentKinds = new Map<string, { kind: 'text' | 'math' | 'code' | 'label'; group: number | null }>();
    for (const obj of objs.values()) {
        if (!/\/Type\s*\/StructElem/.test(obj.dict)) continue;
        let page: string | null = null;
        let parent: PdfObject | undefined = obj;
        let kind: 'text' | 'math' | 'code' | 'label' = 'text';
        let group: number | null = null;
        const visited = new Set<number>();
        while (parent && !visited.has(parent.num)) {
            visited.add(parent.num);
            page ??= /^(\d+)\s+0\s+R/.exec(dictionaryValue(parent.dict, '/Pg'))?.[1] ?? null;
            const role = /\/S\s*\/(\w+)/.exec(parent.dict)?.[1];
            // A formula may contain a tagged table and nested Formula cells.
            // Its outer Formula is one authored expression, including all cells.
            if (role === 'Formula' || role === 'Code' || role === 'Lbl') {
                kind = role === 'Formula' ? 'math' : role === 'Code' ? 'code' : 'label';
                group = parent.num;
            }
            const ref = /\/P\s+(\d+)\s+0\s+R/.exec(parent.dict);
            parent = ref ? objs.get(Number(ref[1])) : undefined;
        }
        // A single formula/code span can use integer MCIDs on its first page
        // and explicit MCR dictionaries on later pages. Page refs are not MCIDs.
        for (const child of structureChildren(obj, page)) {
            if (child.key) contentKinds.set(child.key, { kind, group });
        }
    }
    const contentRuns: PdfContentRun[] = [];
    const markedText = new Map<string, string>();
    const markedEntries: Array<{ key: string; text: string }> = [];

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
                const markedContentStack: Array<{ actualText: string | null; artifact: boolean; mcid: string | null }> = [];
                const append = (text: string): void => {
                    pageText.push(text);
                    if (!text || markedContentStack.some(entry => entry.artifact)) return;
                    const mcid = [...markedContentStack].reverse().find(entry => entry.mcid !== null)?.mcid;
                    if (mcid != null) {
                        const key = `${obj.num}:${mcid}`;
                        markedText.set(key, (markedText.get(key) ?? '') + text);
                        markedEntries.push({ key, text });
                    }
                    const type = mcid != null ? contentKinds.get(`${obj.num}:${mcid}`) : undefined;
                    if (type?.kind === 'label') return;
                    const kind = type?.kind ?? 'text';
                    const group = type?.group ?? null;
                    const last = contentRuns.at(-1);
                    if (last && last.kind === kind && last.group === group) last.text += text;
                    else contentRuns.push({ kind, group, text });
                };
                while (i < tokens.length) {
                    const t = tokens[i];
                    if (t === 'BDC' || t === 'BMC') {
                        let actualText: string | null = null;
                        const actIdx = stack.lastIndexOf('/ActualText');
                        if (honorActualText && actIdx !== -1 && actIdx + 1 < stack.length) {
                            actualText = parseActualTextString(stack[actIdx + 1]);
                        }
                        const mcidIndex = stack.lastIndexOf('/MCID');
                        markedContentStack.push({ actualText, artifact: stack.includes('/Artifact'),
                            mcid: mcidIndex === -1 ? null : stack[mcidIndex + 1] ?? null });
                        stack.length = 0;
                    } else if (t === 'EMC') {
                        const entry = markedContentStack.at(-1);
                        // An outer ActualText replaces the entire nested marked sequence.
                        if (entry?.actualText != null && !markedContentStack.slice(0, -1).some(m => m.actualText != null))
                            append(entry.actualText);
                        markedContentStack.pop();
                        stack.length = 0;
                    } else if (t === 'Tj' || t === "'") {
                        const s = stack.pop() ?? '';
                        if (!markedContentStack.some(m => m.actualText != null)) {
                            append(renderStringToken(s, currentFont));
                        }
                        stack.length = 0;
                    } else if (t === '"') {
                        // " : aw ac string " — discard word/char spacing, show string.
                        const s = stack.pop() ?? '';
                        stack.pop(); stack.pop();
                        if (!markedContentStack.some(m => m.actualText != null)) {
                            append(renderStringToken(s, currentFont));
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
                            append(out);
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

    // A paginated table can emit cell fragments in page/paint order. Read its
    // tagged logical structure to preserve cell and source-code reading order.
    const logicalRuns: PdfContentRun[] = [];
    const appendLogical = (text: string, kind: PdfContentRun['kind'], group: number | null): void => {
        if (!text) return;
        const last = logicalRuns.at(-1);
        if (last && last.kind === kind && last.group === group) last.text += text;
        else logicalRuns.push({ kind, group, text });
    };
    const metadata = (element: PdfObject, page: string | null, kind: PdfContentRun['kind'], group: number | null) => {
        const role = /\/S\s*\/(\w+)/.exec(element.dict)?.[1];
        return { role, page: /^(\d+)\s+0\s+R/.exec(dictionaryValue(element.dict, '/Pg'))?.[1] ?? page,
            kind: group === null ? (role === 'Formula' ? 'math' as const : role === 'Code' ? 'code' as const : kind) : kind,
            group: group === null && (role === 'Formula' || role === 'Code') ? element.num : group };
    };
    const collect = (num: number, page: string | null, kind: PdfContentRun['kind'], group: number | null, owned: Map<string, { kind: PdfContentRun['kind']; group: number | null }>, path: Set<number>): void => {
        const element = objs.get(num);
        if (!element || path.has(num)) return;
        const ancestors = new Set(path); ancestors.add(num);
        const meta = metadata(element, page, kind, group);
        if (meta.role === 'Lbl') return;
        for (const child of structureChildren(element, meta.page)) {
            if (child.ref) collect(child.ref, meta.page, meta.kind, meta.group, owned, ancestors);
            else if (child.key) owned.set(child.key, { kind: meta.kind, group: meta.group });
        }
    };
    const visit = (num: number, inheritedPage: string | null, inheritedKind: PdfContentRun['kind'], inheritedGroup: number | null, path: Set<number>): void => {
        const element = objs.get(num);
        if (!element || path.has(num)) return;
        const meta = metadata(element, inheritedPage, inheritedKind, inheritedGroup);
        if (meta.role === 'Lbl') return;
        // Keep physical inline order inside an atomic paragraph/cell/code block;
        // Typst's mixed K arrays can list inline child references before MCIDs.
        // Only block/cell order comes from the logical structure tree.
        if (meta.role && /^(?:P|H[1-6]|TD|TH|Code|Formula|LBody)$/.test(meta.role)) {
            const owned = new Map<string, { kind: PdfContentRun['kind']; group: number | null }>();
            collect(num, inheritedPage, inheritedKind, inheritedGroup, owned, path);
            for (const entry of markedEntries) {
                const type = owned.get(entry.key);
                if (type) appendLogical(entry.text, type.kind, type.group);
            }
            return;
        }
        const ancestors = new Set(path); ancestors.add(num);
        for (const child of structureChildren(element, meta.page)) {
            if (child.ref) visit(child.ref, meta.page, meta.kind, meta.group, ancestors);
            else if (child.key) appendLogical(markedText.get(child.key) ?? '', meta.kind, meta.group);
        }
    };
    const tables = [...objs.values()].filter(obj => {
        if (!/\/Type\s*\/StructElem/.test(obj.dict) || !/\/S\s*\/Table\b/.test(obj.dict)) return false;
        let parent = obj;
        const visited = new Set<number>();
        while (!visited.has(parent.num)) {
            visited.add(parent.num);
            const ref = /\/P\s+(\d+)\s+0\s+R/.exec(parent.dict);
            const next = ref ? objs.get(Number(ref[1])) : undefined;
            if (!next) break;
            if (/\/S\s*\/(?:Formula|Code)\b/.test(next.dict)) return false;
            parent = next;
        }
        return true;
    });
    const tableKeys = new Map<string, number>();
    const tableRuns = new Map<number, PdfContentRun[]>();
    for (const table of tables) {
        const owned = new Map<string, { kind: PdfContentRun['kind']; group: number | null }>();
        collect(table.num, null, 'text', null, owned, new Set());
        for (const key of owned.keys()) tableKeys.set(key, table.num);
        const begin = logicalRuns.length;
        visit(table.num, null, 'text', null, new Set());
        tableRuns.set(table.num, logicalRuns.splice(begin));
    }
    const emitted = new Set<number>();
    for (const entry of markedEntries) {
        const table = tableKeys.get(entry.key);
        if (table !== undefined) {
            if (!emitted.has(table)) {
                emitted.add(table);
                for (const run of tableRuns.get(table) ?? []) appendLogical(run.text, run.kind, run.group);
            }
        } else {
            const type = contentKinds.get(entry.key);
            if (type?.kind !== 'label') appendLogical(entry.text, type?.kind ?? 'text', type?.group ?? null);
        }
    }
    return { text: pageText.join(''), contentRuns: markedEntries.length ? logicalRuns : contentRuns, pageCount, imageXObjectCount, fonts };
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

