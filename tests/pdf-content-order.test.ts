import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText } from './helpers/pdfTextExtract.js';

function fixture(atomic?: 'Formula' | 'Code' | 'matrix'): Buffer {
    const stream = (text: string) => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
    const span = (mcid: number, text: string) => `/Span << /MCID ${mcid} >> BDC BT /F1 10 Tf (${text}) Tj ET EMC\n`;
    const objects = new Map<number, string>([
        [1, '<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 30 0 R >>'],
        [2, '<< /Type /Pages /Count 2 /Kids [4 0 R 5 0 R] >>'],
        [3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
        [4, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 6 0 R >>'],
        [5, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 7 0 R >>'],
        [6, stream(span(0, 'Question.First sentence.Middle sentence.Final sentence.') + span(1, 'Alpha') + span(2, 'Beta') + span(3, 'x') + '/Artifact << /Subtype /Footer >> BDC BT /F1 10 Tf (1) Tj ET EMC')],
        [7, stream(span(0, 'endA') + span(1, 'endB') + span(2, 'Answer tail.') + span(3, 'if x < 3: print(x)'))],
        [10, '<< /Type /StructElem /S /Document /P 30 0 R /K [11 0 R 12 0 R 20 0 R 21 0 R] >>'],
        [11, '<< /Type /StructElem /S /P /P 10 0 R /Pg 4 0 R /K [0] >>'],
        [12, '<< /Type /StructElem /S /Table /P 10 0 R /K [13 0 R] >>'],
        [13, '<< /Type /StructElem /S /TR /P 12 0 R /K [14 0 R 15 0 R] >>'],
        // Explicit MCR dictionaries cross pages; nested Pg is not a parent Pg.
        [14, '<< /Type /StructElem /S /TD /P 13 0 R /K [<< /Type /MCR /Pg 4 0 R /MCID 1 >> 16 0 R << /Type /MCR /Pg 5 0 R /MCID 0 >>] >>'],
        [15, '<< /Type /StructElem /S /TD /P 13 0 R /K [<< /Type /MCR /Pg 4 0 R /MCID 2 >> << /Type /MCR /Pg 5 0 R /MCID 1 >>] >>'],
        [16, '<< /Type /StructElem /S /Formula /P 14 0 R /Pg 4 0 R /K [3] >>'],
        [20, '<< /Type /StructElem /S /P /P 10 0 R /Pg 5 0 R /K [2] >>'],
        [21, '<< /Type /StructElem /S /Code /P 10 0 R /K [22 0 R] >>'],
        [22, '<< /Type /StructElem /S /P /P 21 0 R /Pg 5 0 R /K [3] >>'],
        [30, '<< /Type /StructTreeRoot /K [10 0 R] >>'],
    ]);
    if (atomic === 'matrix') {
        // Live Typst array/cases output: Formula > Table > TD > Formula.
        // Cell formulas belong to the single outer authored expression.
        objects.set(10, '<< /Type /StructElem /S /Document /P 30 0 R /K [11 0 R 23 0 R 20 0 R 21 0 R] >>');
        objects.set(23, '<< /Type /StructElem /S /Formula /P 10 0 R /K [12 0 R] >>');
        objects.set(12, '<< /Type /StructElem /S /Table /P 23 0 R /K [13 0 R] >>');
    } else if (atomic) {
        for (const id of [12, 13, 14, 15, 21, 22]) objects.delete(id);
        objects.set(6, stream(span(0, 'first')));
        objects.set(7, stream(span(0, 'second') + span(1, 'tail')));
        objects.set(10, '<< /Type /StructElem /S /Document /P 30 0 R /K [16 0 R 20 0 R] >>');
        objects.set(16, `<< /Type /StructElem /S /${atomic} /P 10 0 R /Pg 4 0 R /K [0 << /Type /MCR /MCID 0 /Pg 5 0 R >>] >>`);
        objects.set(20, '<< /Type /StructElem /S /P /P 10 0 R /Pg 5 0 R /K [1] >>');
    }
    let text = '%PDF-1.7\n';
    const offsets = new Map<number, number>();
    for (const [number, body] of objects) { offsets.set(number, Buffer.byteLength(text)); text += `${number} 0 obj\n${body}\nendobj\n`; }
    const start = Buffer.byteLength(text);
    text += 'xref\n0 31\n0000000000 65535 f \n';
    for (let n = 1; n <= 30; n++) text += offsets.has(n) ? `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n` : '0000000000 00000 f \n';
    text += `trailer\n<< /Size 31 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
    return Buffer.from(text);
}

test('nested tagged matrix cells count as one formula and retain every cell across pages', () => {
    const pdf = extractPdfText(fixture('matrix'));
    assert.deepEqual(pdf.contentRuns, [
        { kind: 'text', group: null, text: 'Question.First sentence.Middle sentence.Final sentence.' },
        { kind: 'math', group: 23, text: 'AlphaBetaxendAendB' },
        { kind: 'text', group: null, text: 'Answer tail.' },
        { kind: 'code', group: 21, text: 'if x < 3: print(x)' },
    ]);
});

test('independent PDF extraction preserves complete prose/code and logical paginated cell order', () => {
    const pdf = extractPdfText(fixture());
    assert.equal(pdf.pageCount, 2);
    assert.deepEqual(pdf.contentRuns, [
        { kind: 'text', group: null, text: 'Question.First sentence.Middle sentence.Final sentence.Alpha' },
        { kind: 'math', group: 16, text: 'x' },
        { kind: 'text', group: null, text: 'endABetaendBAnswer tail.' },
        { kind: 'code', group: 21, text: 'if x < 3: print(x)' },
    ]);
    assert.ok(pdf.text.includes('1'), 'raw extraction still includes pagination for existing callers');
    assert.ok(!pdf.contentRuns.some(run => run.text === '1'), 'semantic content excludes tagged footer');
});


for (const role of ['Formula', 'Code'] as const) {
    test(`independent PDF extraction keeps ${role} classification across explicit page references`, () => {
        const pdf = extractPdfText(fixture(role));
        assert.equal(pdf.pageCount, 2);
        assert.deepEqual(pdf.contentRuns, [
            { kind: role === 'Formula' ? 'math' : 'code', group: 16, text: 'firstsecond' },
            { kind: 'text', group: null, text: 'tail' },
        ]);
    });
}
