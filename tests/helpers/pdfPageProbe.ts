/**
 * tests/helpers/pdfPageProbe.ts
 *
 * Per-page layout probe for PDFs produced by the repo's Typst pipeline.
 * Goes one step beyond tests/helpers/pdfTextExtract.ts (which only yields
 * whole-document text): it walks each page's content stream tracking the
 * graphics/text state, and reports per-page text runs with approximate
 * positions plus image draw rects. Used by the fixed visual-corpus test to
 * check overflow/clipping, blank pages, duplicated runs and image bounds
 * programmatically — no pixel comparison, no screenshots.
 *
 * Position tracking is approximate by design:
 * - text-run widths are estimated from font size and script class
 *   (CJK ~0.95em, latin ~0.5em), because parsing CID /W tables is out of
 *   scope; the bounds check therefore uses a tolerance and only flags
 *   gross overflow, never hairline differences.
 * - only the operators Typst emits are interpreted (q/Q/cm/BT/ET/Tf/Tm/
 *   Td/TD/T-star/Tj/TJ/quote/double-quote/Do); anything else is ignored.
 *
 * Reuses the low-level PDF parsing (objects, ToUnicode, tokenizer) from
 * pdfTextExtract.ts so the two stay consistent.
 */

export {};

const {
    parseObjects,
    inflateIfNeeded,
    parseToUnicode,
    tokenizeContent,
    decodeBytes,
    parseHexPdfString,
    parseLiteralPdfString,
} = require('./pdfTextExtract.js');

type Matrix = [number, number, number, number, number, number];

const IDENT: Matrix = [1, 0, 0, 1, 0, 0];

function mul(m1: Matrix, m2: Matrix): Matrix {
    const [a, b, c, d, e, f] = m1;
    const [a2, b2, c2, d2, e2, f2] = m2;
    return [
        a * a2 + b * c2,
        a * b2 + b * d2,
        c * a2 + d * c2,
        c * b2 + d * d2,
        e * a2 + f * c2 + e2,
        e * b2 + f * d2 + f2,
    ];
}

function applyPt(m: Matrix, x: number, y: number): [number, number] {
    const [a, b, c, d, e, f] = m;
    return [a * x + c * y + e, b * x + d * y + f];
}

export interface TextRun {
    page: number;
    text: string;
    /** Baseline origin in PDF points (y-up), composed CTM x text matrix. */
    x: number;
    y: number;
    size: number;
    /** Estimated advance width in points (heuristic, see file header). */
    width: number;
}

export interface ImageDraw {
    page: number;
    name: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface PageLayout {
    index: number;
    width: number;
    height: number;
    text: string;
    charCount: number;
    runs: TextRun[];
    imageDraws: ImageDraw[];
    imageXObjects: number;
}

export interface LayoutReport {
    pages: PageLayout[];
    fonts: string[];
    totalImageXObjects: number;
}

interface FontEntry {
    toUnicode: Map<string, string> | null;
    baseFont: string;
}

function parseResourceMap(section: string): Map<string, number> {
    const map = new Map<string, number>();
    const r = /\/(\S+)\s+(\d+)\s+0\s+R/g;
    let m: RegExpExecArray | null;
    while ((m = r.exec(section)) !== null) map.set(m[1], parseInt(m[2], 10));
    return map;
}

/** Heuristic advance width for a decoded string at the given font size. */
function estimateWidth(text: string, size: number): number {
    let w = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if (code > 0x2e7f) w += size * 0.95; // CJK + math alphanumerics
        else if (code < 128) w += size * 0.5;
        else w += size * 0.55;
    }
    return w;
}

function decodeToken(token: string, font: FontEntry | null): { bytes: number[]; text: string } {
    let bytes: number[];
    if (token.startsWith('<')) {
        bytes = parseHexPdfString(token.slice(1, -1).replace(/\s+/g, ''));
    } else if (token.startsWith('(')) {
        bytes = parseLiteralPdfString(token.slice(1, -1));
    } else {
        return { bytes: [], text: '' };
    }
    return { bytes, text: decodeBytes(bytes, font?.toUnicode ?? null) };
}

/** Extract per-page layout info from a PDF. */
export function probePdfLayout(pdfBytes: Uint8Array): LayoutReport {
    const data = Buffer.from(pdfBytes);
    const objs = parseObjects(data);

    const fonts: string[] = [];
    const fontObjs = new Map<number, { toUnicode: Map<string, string> | null; baseFont: string }>();
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
            fontObjs.set(obj.num, { toUnicode, baseFont });
        }
    }

    const pages: PageLayout[] = [];
    let pageIndex = 0;
    for (const obj of objs.values()) {
        if (!/\/Type\s*\/Page[^s]/.test(obj.dict)) continue;
        const mb = /\/MediaBox\s*\[([\d.\s-]+)\]/.exec(obj.dict);
        const dims = mb ? mb[1].trim().split(/\s+/).map(Number) : [0, 0, 595.28, 841.89];
        const width = dims[2] - dims[0];
        const height = dims[3] - dims[1];

        const fontSec = /\/Font\s*<<([\s\S]*?)>>/.exec(obj.dict);
        const fontMap = fontSec ? parseResourceMap(fontSec[1]) : new Map<string, number>();
        const xobjSec = /\/XObject\s*<<([\s\S]*?)>>/.exec(obj.dict);
        const xobjMap = xobjSec ? parseResourceMap(xobjSec[1]) : new Map<string, number>();
        const imageNames = new Set<string>();
        let imageXObjects = 0;
        for (const [name, num] of xobjMap) {
            const x = objs.get(num);
            if (x && /\/Subtype\s*\/Image/.test(x.dict)) {
                imageNames.add(name);
                imageXObjects += 1;
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

        const runs: TextRun[] = [];
        const imageDraws: ImageDraw[] = [];
        const pageTexts: string[] = [];

        for (const ref of contentRefs) {
            const cObj = objs.get(ref);
            if (!cObj) continue;
            const inflated = inflateIfNeeded(cObj);
            if (!inflated) continue;
            const tokens = tokenizeContent(inflated.toString('latin1'));

            const stack: string[] = [];
            const gstack: Matrix[] = [IDENT];
            let tm: Matrix = IDENT;
            let inText = false;
            let fontSize = 10;
            let font: FontEntry | null = null;
            let leading = 12;

            const ctm = (): Matrix => gstack[gstack.length - 1];

            const recordString = (token: string): void => {
                const { text } = decodeToken(token, font);
                if (!text) return;
                const [x, y] = applyPt(ctm(), ...applyPt(tm, 0, 0));
                const width = estimateWidth(text, fontSize);
                runs.push({ page: pageIndex, text, x, y, size: fontSize, width });
                pageTexts.push(text);
                // Advance the text matrix by the estimated width.
                tm = mul([1, 0, 0, 1, width, 0], tm);
            };

            for (const t of tokens) {
                switch (t) {
                    case 'q':
                        gstack.push([...ctm()] as Matrix);
                        break;
                    case 'Q':
                        if (gstack.length > 1) gstack.pop();
                        break;
                    case 'BT':
                        inText = true;
                        tm = IDENT;
                        break;
                    case 'ET':
                        inText = false;
                        stack.length = 0;
                        break;
                    case 'T*':
                        tm = mul([1, 0, 0, 1, 0, -leading], tm);
                        break;
                    case 'Tj':
                    case "'": {
                        const s = stack.pop() ?? '';
                        stack.length = 0;
                        if (inText) recordString(s);
                        break;
                    }
                    case '"': {
                        const s = stack.pop() ?? '';
                        stack.pop();
                        stack.pop();
                        stack.length = 0;
                        if (inText) recordString(s);
                        break;
                    }
                    case 'TJ': {
                        const elems: string[] = [];
                        while (stack.length > 0) {
                            const e = stack.pop() as string;
                            if (e === '[') break;
                            if (e !== ']') elems.unshift(e);
                        }
                        stack.length = 0;
                        if (!inText) break;
                        for (const e of elems) {
                            if (e.startsWith('<') || e.startsWith('(')) {
                                recordString(e);
                            } else {
                                const kern = parseFloat(e);
                                if (Number.isFinite(kern)) {
                                    tm = mul([1, 0, 0, 1, (-kern / 1000) * fontSize, 0], tm);
                                }
                            }
                        }
                        break;
                    }
                    case 'Tf': {
                        const sizeTok = stack.pop() ?? '';
                        const name = (stack.pop() ?? '').replace(/^\//, '');
                        stack.length = 0;
                        const sz = parseFloat(sizeTok);
                        if (Number.isFinite(sz)) fontSize = sz;
                        const num = fontMap.get(name);
                        font = num !== undefined ? (fontObjs.get(num) ?? null) : null;
                        break;
                    }
                    case 'Tm':
                    case 'Td':
                    case 'TD':
                    case 'cm':
                    case 'Do': {
                        // Operands were pushed as strings; handle by arity below.
                        break;
                    }
                    default: {
                        stack.push(t);
                        break;
                    }
                }
                // Multi-operand operators: inspect the stack tail.
                if (t === 'cm' || t === 'Tm') {
                    const f = parseFloat(stack.pop() ?? 'NaN');
                    const e = parseFloat(stack.pop() ?? 'NaN');
                    const d = parseFloat(stack.pop() ?? 'NaN');
                    const c = parseFloat(stack.pop() ?? 'NaN');
                    const b = parseFloat(stack.pop() ?? 'NaN');
                    const a = parseFloat(stack.pop() ?? 'NaN');
                    stack.length = 0;
                    if ([a, b, c, d, e, f].every(Number.isFinite)) {
                        if (t === 'cm') gstack[gstack.length - 1] = mul(ctm(), [a, b, c, d, e, f]);
                        else tm = [a, b, c, d, e, f];
                    }
                } else if (t === 'Td' || t === 'TD') {
                    const ty = parseFloat(stack.pop() ?? 'NaN');
                    const tx = parseFloat(stack.pop() ?? 'NaN');
                    stack.length = 0;
                    if (Number.isFinite(tx) && Number.isFinite(ty)) {
                        if (t === 'TD') leading = -ty;
                        tm = mul([1, 0, 0, 1, tx, ty], tm);
                    }
                } else if (t === 'Do') {
                    const name = (stack.pop() ?? '').replace(/^\//, '');
                    stack.length = 0;
                    if (imageNames.has(name)) {
                        const m = ctm();
                        const corners = [
                            applyPt(m, 0, 0),
                            applyPt(m, 1, 0),
                            applyPt(m, 0, 1),
                            applyPt(m, 1, 1),
                        ];
                        const xs = corners.map((p) => p[0]);
                        const ys = corners.map((p) => p[1]);
                        const x0 = Math.min(...xs);
                        const x1 = Math.max(...xs);
                        const y0 = Math.min(...ys);
                        const y1 = Math.max(...ys);
                        imageDraws.push({ page: pageIndex, name, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
                    }
                }
            }
        }

        const text = pageTexts.join('');
        pages.push({
            index: pageIndex,
            width,
            height,
            text,
            charCount: text.length,
            runs,
            imageDraws,
            imageXObjects,
        });
        pageIndex += 1;
    }

    return {
        pages,
        fonts,
        totalImageXObjects: pages.reduce((n, p) => n + p.imageXObjects, 0),
    };
}

export interface ProbeIssue {
    check: string;
    message: string;
}

const BOUND_TOL_PT = 4;

/**
 * Gross overflow / clipping check: every text run and image draw must lie
 * (approximately) inside its page MediaBox. Widths are estimated, so only
 * violations beyond the tolerance are reported.
 */
export function checkContentBounds(report: LayoutReport): ProbeIssue[] {
    const issues: ProbeIssue[] = [];
    for (const page of report.pages) {
        const { width: w, height: h } = page;
        for (const run of page.runs) {
            const x1 = run.x + run.width;
            const top = run.y + run.size * 0.9;
            const bottom = run.y - run.size * 0.3;
            if (run.x < -BOUND_TOL_PT || x1 > w + BOUND_TOL_PT || bottom < -BOUND_TOL_PT || top > h + BOUND_TOL_PT) {
                issues.push({
                    check: 'overflow',
                    message:
                        `page ${page.index + 1}: text run outside page bounds ` +
                        `(x=${run.x.toFixed(1)}..${x1.toFixed(1)}, y=${bottom.toFixed(1)}..${top.toFixed(1)}, ` +
                        `page=${w.toFixed(1)}x${h.toFixed(1)}): ${JSON.stringify(run.text.slice(0, 40))}`,
                });
            }
        }
        for (const d of page.imageDraws) {
            if (d.w < 1 || d.h < 1) {
                issues.push({ check: 'image', message: `page ${page.index + 1}: image ${d.name} drawn with ~zero size (${d.w.toFixed(1)}x${d.h.toFixed(1)}pt)` });
                continue;
            }
            if (d.x < -BOUND_TOL_PT || d.x + d.w > w + BOUND_TOL_PT || d.y < -BOUND_TOL_PT || d.y + d.h > h + BOUND_TOL_PT) {
                issues.push({
                    check: 'image-overflow',
                    message:
                        `page ${page.index + 1}: image ${d.name} rect outside page bounds ` +
                        `(x=${d.x.toFixed(1)}, y=${d.y.toFixed(1)}, ${d.w.toFixed(1)}x${d.h.toFixed(1)}pt, page=${w.toFixed(1)}x${h.toFixed(1)})`,
                });
            }
        }
    }
    return issues;
}

/**
 * Blank-page / broken-pagination check: middle pages must carry a minimum
 * amount of text; the last page must not be nearly empty either.
 */
export function checkBlankPages(
    report: LayoutReport,
    opts: { midMinChars?: number; lastMinChars?: number } = {},
): ProbeIssue[] {
    const midMin = opts.midMinChars ?? 100;
    const lastMin = opts.lastMinChars ?? 20;
    const issues: ProbeIssue[] = [];
    report.pages.forEach((page, i) => {
        const isLast = i === report.pages.length - 1;
        const min = isLast ? lastMin : midMin;
        if (page.imageDraws && page.imageDraws.length > 0) return;
        if (page.charCount < min) {
            issues.push({
                check: isLast ? 'blank-tail' : 'blank-page',
                message: `page ${page.index + 1}${isLast ? ' (last)' : ''}: only ${page.charCount} text chars (< ${min}) — possible large blank area / broken pagination`,
            });
        }
    });
    return issues;
}

/**
 * Duplicated-content check: no long verbatim run (>= 400 chars) may repeat
 * across consecutive pages (catches double-rendered paragraphs).
 */
export function checkDuplicatedRuns(report: LayoutReport, minLen = 400): ProbeIssue[] {
    const issues: ProbeIssue[] = [];
    for (let i = 0; i + 1 < report.pages.length; i += 1) {
        const a = report.pages[i].text;
        const b = report.pages[i + 1].text;
        if (a.length < minLen || b.length < minLen) continue;
        for (let off = 0; off + minLen <= a.length && issues.length < 5; off += 150) {
            const chunk = a.slice(off, off + minLen);
            if (b.includes(chunk)) {
                issues.push({
                    check: 'duplicated-content',
                    message: `pages ${i + 1}->${i + 2}: ${minLen}-char run repeats verbatim: ${JSON.stringify(chunk.slice(0, 60))}…`,
                });
                break;
            }
        }
    }
    return issues;
}

/** Collapse all whitespace so PDF line breaks don't break phrase matching. */
export function normalizeText(s: string): string {
    return s.replace(/\s+/g, '');
}

export function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let n = 0;
    let i = 0;
    for (;;) {
        i = haystack.indexOf(needle, i);
        if (i === -1) return n;
        n += 1;
        i += needle.length;
    }
}
