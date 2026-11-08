import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { parseObjects, inflateIfNeeded, extractPdfText } from './helpers/pdfTextExtract.js';

for (const ending of [0x0a, 0x0d]) {
    test(`PDF probe preserves compressed stream ending in ${ending.toString(16)}`, () => {
        const original = Buffer.from([0, ending - 1]);
        const compressed = deflateSync(original);
        assert.equal(compressed.at(-1), ending, 'fixture exercises a real compressed CR/LF byte');
        const pdf = Buffer.concat([
            Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`),
            compressed, Buffer.from('\nendstream\nendobj\n%%EOF\n'),
        ]);
        const obj = parseObjects(pdf).get(1)!;
        assert.deepEqual(obj.stream, compressed);
        assert.deepEqual(inflateIfNeeded(obj), original);
    });
}

test('PDF probe preserves declared plain-text stream including trailing line breaks', () => {
    const original = Buffer.from('BT (text) Tj ET\n\n');
    const pdf = Buffer.concat([Buffer.from(`1 0 obj\n<< /Length ${original.length} >>\nstream\n`), original, Buffer.from('\nendstream\nendobj')]);
    assert.deepEqual(parseObjects(pdf).get(1)?.stream, original);
});


test('outer ActualText replaces nested glyph spans once and preserves real repetition', () => {
    const content = 'BT /Span << /ActualText <FEFF00780302> >> BDC /Span << /ActualText (x) >> BDC (x) Tj EMC (hat) Tj EMC (xx) Tj ET';
    const pdf = Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n2 0 obj\n<< /Type /Page /Contents 1 0 R >>\nendobj`);
    assert.equal(extractPdfText(pdf).text, 'x\u0302xx');
});
