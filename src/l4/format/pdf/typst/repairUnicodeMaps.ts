import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObjectParser, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';
import ByteStream from 'pdf-lib/cjs/core/parser/ByteStream.js';

interface Glyph { font: PDFDict; cid: number }
interface Span { text: string | undefined; glyphs: Glyph[] }

// Only the content syntax emitted by Typst is consumed here. PDF objects, strings,
// escaping and compression are decoded by pdf-lib, never searched as raw PDF bytes.
function* operators(bytes: Uint8Array, context: PDFContext): Generator<{ name: string; args: PDFObject[] }> {
    const stream = ByteStream.of(bytes);
    const parser = PDFObjectParser.forByteStream(stream, context);
    let args: PDFObject[] = [];
    const whitespace = (code: number): boolean => [0, 9, 10, 12, 13, 32].includes(code);
    while (!stream.done()) {
        if (whitespace(stream.peek())) { stream.next(); continue; }
        if (stream.peek() === 37) {
            while (!stream.done() && stream.next() !== 10) { /* PDF comment */ }
            continue;
        }
        const first = stream.peek();
        if ([40, 60, 47, 91, 43, 45, 46].includes(first) || (first >= 48 && first <= 57)) {
            args.push(parser.parseObject());
            continue;
        }
        let name = '';
        while (!stream.done() && !whitespace(stream.peek()) && ![40, 60, 47, 91, 37].includes(stream.peek())) {
            name += String.fromCharCode(stream.next());
        }
        if (!name || name === 'BI') throw new Error('Unsupported Typst PDF content syntax');
        yield { name, args };
        args = [];
    }
}

function unicodeHex(text: string): string {
    let hex = '';
    for (let i = 0; i < text.length; i += 1) hex += text.charCodeAt(i).toString(16).padStart(4, '0');
    return hex.toUpperCase();
}

/** Keep ToUnicode usable for readers that ignore ActualText. Typst assigns a
 * cluster to its first glyph and leaves subsequent mark glyphs unmapped. With
 * GPOS-split clusters it can instead map the complete cluster more than once.
 * The bundled Mono font keeps each affected cluster inside one ActualText span;
 * its authoritative source and glyph sequence provide the per-glyph mapping.
 * Only Latin/dotted-circle clusters with unambiguous one-codepoint-per-glyph
 * NFC decompositions are rewritten. Complex scripts need shaping-order metadata.
 * Content streams, glyph positions, original ActualText and tagging are retained.
 */
export async function repairUnicodeMaps(bytes: Uint8Array): Promise<Uint8Array> {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const assignments = new Map<PDFDict, Map<number, string | null>>();
    const record = (span: Span): void => {
        if (span.text === undefined || !/\p{M}/u.test(span.text) || !span.glyphs.length) return;
        if (!/^[\p{Script=Latin}\p{M}\u25cc\s]+$/u.test(span.text)
            || span.glyphs.some(glyph => glyph.cid === 0)) return;
        const points = Array.from(span.text.normalize('NFC'));
        const parts = span.glyphs.length === 1 ? [span.text] : points;
        if (parts.length !== span.glyphs.length) return;
        for (const [i, glyph] of span.glyphs.entries()) {
            const text = parts[i];
            if (text === undefined) throw new Error('Invalid PDF cluster decomposition');
            let map = assignments.get(glyph.font);
            if (!map) { map = new Map(); assignments.set(glyph.font, map); }
            const previous = map.get(glyph.cid);
            map.set(glyph.cid, previous === undefined || previous === text ? text : null);
        }
    };
    for (const page of doc.getPages()) {
        const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
        const contents = page.node.Contents();
        const streams = contents instanceof PDFArray ? contents.asArray().map(entry => doc.context.lookup(entry)) : [contents];
        let font: PDFDict | undefined;
        const spans: Span[] = [];
        for (const content of streams) {
            if (!(content instanceof PDFRawStream)) continue;
            for (const { name, args } of operators(decodePDFRawStream(content).decode(), doc.context)) {
                if (name === 'Tf') {
                    const selected = args[0];
                    font = selected instanceof PDFName ? fonts?.lookupMaybe(selected, PDFDict) : undefined;
                } else if (name === 'BDC' || name === 'BMC') {
                    const properties = args[1];
                    const actual = properties instanceof PDFDict ? properties.lookup(PDFName.of('ActualText')) : undefined;
                    spans.push({ text: actual instanceof PDFString || actual instanceof PDFHexString ? actual.decodeText() : undefined, glyphs: [] });
                } else if (name === 'EMC') {
                    const span = spans.pop();
                    if (span) record(span);
                } else if (name === 'Tj' || name === 'TJ' || name === "'" || name === '"') {
                    // The outermost ActualText replaces nested marked sequences.
                    const active = spans.find(span => span.text !== undefined);
                    if (!active || !font) continue;
                    const last = args.at(-1);
                    const strings = last instanceof PDFArray ? last.asArray() : [last];
                    for (const value of strings) {
                        if (!(value instanceof PDFString || value instanceof PDFHexString)) continue;
                        const encoded = value.asBytes();
                        if (encoded.length % 2) throw new Error('Typst Identity-H text has an odd byte length');
                        const cids = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
                        for (let i = 0; i < encoded.length; i += 2) {
                            active.glyphs.push({ font, cid: cids.getUint16(i) });
                        }
                    }
                }
            }
        }
    }
    let changed = false;
    for (const [font, proposed] of assignments) {
        const cmap = font.lookup(PDFName.of('ToUnicode'));
        if (!(cmap instanceof PDFRawStream)) continue;
        const original = new TextDecoder().decode(decodePDFRawStream(cmap).decode());
        const map = new Map<string, string>();
        for (const block of original.matchAll(/\d+\s+beginbfchar([\s\S]*?)endbfchar/g)) {
            for (const entry of (block[1] ?? '').matchAll(/<([\da-f]+)>\s*<([\da-f]*)>/gi)) {
                const cid = entry[1], text = entry[2];
                if (cid !== undefined && text !== undefined) map.set(cid.toUpperCase(), text.toUpperCase());
            }
        }
        let updated = false;
        for (const [cid, text] of proposed) {
            if (text === null) continue; // Conflicting aliases still use the original ActualText.
            const key = cid.toString(16).padStart(4, '0').toUpperCase();
            const hex = unicodeHex(text);
            if (map.get(key) !== hex) { map.set(key, hex); updated = true; }
        }
        if (!updated) continue;
        const entries = [...map].map(([cid, text]) => `<${cid}> <${text}>`);
        const blocks: string[] = [];
        for (let i = 0; i < entries.length; i += 100) {
            const group = entries.slice(i, i + 100);
            blocks.push(`${group.length} beginbfchar\n${group.join('\n')}\nendbfchar`);
        }
        const rewritten = original.replace(/\d+\s+beginbfchar[\s\S]*?endbfchar/g, '')
            .replace('endcmap', `${blocks.join('\n')}\nendcmap`);
        font.set(PDFName.of('ToUnicode'), doc.context.register(doc.context.flateStream(rewritten)));
        changed = true;
    }
    return changed ? doc.save({ useObjectStreams: false }) : bytes;
}
