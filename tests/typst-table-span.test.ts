export {};
const test = require('node:test');
const assert = require('node:assert');

const { toTypstPayload } = require('../src/core/export/typst/payload.js');
const { renderCanonicalHtml } = require('../src/core/export/canonical/renderCanonicalHtml.js');
const { TypstSandboxCompiler } = require('../src/core/export/typst/typstSandboxCompiler.js');
const { convertMath } = require('../src/core/export/typst/mathConverter.js');
const { extractPdfText } = require('./helpers/pdfTextExtract.js');
const {
    RealWasmSandboxHost,
    repoRoot,
} = require('./helpers/realWasmSandbox.js');

function bundle(blocks: any[], extra: any = {}) {
    return {
        schemaVersion: 1,
        conversation: {
            key: { providerId: 'gemini', accountId: 'test-account', conversationId: 'c1' },
            title: 'Span',
            createdAt: '2026-09-26T10:00:00Z',
            messages: [{ id: 'm1', role: 'assistant', blocks }],
        },
        assets: [],
        citations: [],
        ...extra,
    };
}

function msg(id: string, role: string, blocks: any[]) {
    return { id, role, blocks };
}

const txt = (text: string) => ({ type: 'text', text });
const cell = (text: string, extra: any = {}) => ({ children: [txt(text)], ...extra });
const row = (...cells: any[]) => ({ cells });

const opts = { assetPath: (a: any) => `assets/${a.id}.png` };

function typstOf(blocks: any[]) {
    const { payload, diagnostics } = toTypstPayload(bundle(blocks), opts);
    return { node: payload.messages[0].blocks[0] as any, diagnostics: diagnostics as any[] };
}

function htmlOf(blocks: any[]) {
    return renderCanonicalHtml(bundle(blocks), {}).html as string;
}

async function compileOnce(blocks: any[]) {
    const b = bundle(blocks);
    const host = new RealWasmSandboxHost(repoRoot());
    const compiler = new TypstSandboxCompiler({ host });
    const assetPath = (a: any) => `/assets/${a.id}.png`;
    const { payload: document } = toTypstPayload(b, { assetPath, convertMath });
    const context = {
        bundle: b,
        assets: { resolve: async (id: string) => null },
        locale: 'en' as const,
        signal: new AbortController().signal,
        reportProgress: () => undefined,
    };
    try {
        return await compiler.compile(
            {
                rendererSchemaVersion: 1,
                sourceSchemaVersion: 1,
                bundle: b,
                document,
                assetPaths: new Map(),
            } as never,
            context as never,
        );
    } finally {
        compiler.dispose();
    }
}

test('colSpan maps to transport colspan and rowspan stays absent', async () => {
    const { node, diagnostics } = typstOf([{
        type: 'table',
        rows: [row(cell('wide', { colSpan: 2 }), cell('b'))],
    }]);
    assert.strictEqual(node.rows[0][0].colspan, 2);
    assert.strictEqual(node.rows[0][0].children[0].text, 'wide');
    assert.ok(!('colspan' in node.rows[0][1]));
    assert.ok(!('rowspan' in node.rows[0][0]));
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_TABLE_SPAN_IGNORED'));
});

test('rowSpan and combined spans map to transport', async () => {
    const { node } = typstOf([{
        type: 'table',
        rows: [
            row(cell('tall', { rowSpan: 2 }), cell('b')),
            row(cell('big', { colSpan: 2, rowSpan: 2 }), cell('c')),
            row(cell('d'), cell('e')),
        ],
    }]);
    assert.strictEqual(node.rows[0][0].rowspan, 2);
    assert.strictEqual(node.rows[1][0].colspan, 2);
    assert.strictEqual(node.rows[1][0].rowspan, 2);
});

test('header cells carry spans', async () => {
    const { node } = typstOf([{
        type: 'table',
        headerRows: [row(cell('merged-head', { colSpan: 2 }))],
        rows: [row(cell('a'), cell('b'))],
    }]);
    assert.strictEqual(node.headers[0][0].colspan, 2);
    assert.strictEqual(node.headers[0][0].children[0].text, 'merged-head');
});

test('span parity: HTML colspan/rowspan matches Typst transport', async () => {
    const blocks = [{
        type: 'table',
        rows: [
            row(cell('wide', { colSpan: 2 }), cell('b')),
            row(cell('tall', { rowSpan: 2 }), cell('c')),
        ],
    }];
    const html = htmlOf(blocks);
    assert.ok(html.includes('colspan="2"'), 'html keeps colspan');
    assert.ok(html.includes('rowspan="2"'), 'html keeps rowspan');
    const { node } = typstOf(blocks);
    assert.strictEqual(node.rows[0][0].colspan, 2);
    assert.strictEqual(node.rows[1][0].rowspan, 2);
});

test('real WASM: colspan table compiles with all text selectable', async () => {
    const result = await compileOnce([{
        type: 'table', id: 't1',
        headerRows: [row(cell('alpha'), cell('beta'))],
        rows: [
            row(cell('wide-cell', { colSpan: 2 })),
            row(cell('left'), cell('right')),
        ],
    }]);
    assert.ok(result.pdfBytes && result.pdfBytes.length > 0, 'compile must produce PDF bytes');
    const extracted = extractPdfText(result.pdfBytes);
    for (const needle of ['alpha', 'beta', 'wide-cell', 'left', 'right']) {
        assert.ok(extracted.text.includes(needle), `missing from PDF text: ${needle}`);
    }
});

test('real WASM: rowspan and combined spans compile with all text selectable', async () => {
    const result = await compileOnce([{
        type: 'table', id: 't1',
        rows: [
            row(cell('tall-cell', { rowSpan: 2 }), cell('top-right')),
            row(cell('bottom-right')),
            row(cell('big-cell', { colSpan: 2, rowSpan: 1 })),
        ],
    }]);
    assert.ok(result.pdfBytes && result.pdfBytes.length > 0, 'compile must produce PDF bytes');
    const extracted = extractPdfText(result.pdfBytes);
    for (const needle of ['tall-cell', 'top-right', 'bottom-right', 'big-cell']) {
        assert.ok(extracted.text.includes(needle), `missing from PDF text: ${needle}`);
    }
});

test('real WASM: header span and oversized span compile without data loss', async () => {
    const result = await compileOnce([{
        type: 'table', id: 't1',
        headerRows: [row(cell('merged-header', { colSpan: 2 }))],
        rows: [
            row(cell('oversized', { colSpan: 5 }), cell('b')),
            row(cell('c'), cell('d')),
        ],
    }]);
    assert.ok(result.pdfBytes && result.pdfBytes.length > 0, 'compile must produce PDF bytes');
    const extracted = extractPdfText(result.pdfBytes);
    for (const needle of ['merged-header', 'oversized', 'b', 'c', 'd']) {
        assert.ok(extracted.text.includes(needle), `missing from PDF text: ${needle}`);
    }
});

test('real WASM: multi-cell staggered rowspan occupancy compiles and retains all text', async () => {
    // 3-column table with staggered rowspans:
    // Row 0: R0C0 (span 2 rows), R0C1 (span 3 rows), R0C2 (1 row)
    // Row 1: R1C2 (cols 0, 1 occupied by R0C0, R0C1)
    // Row 2: R2C0 (1 row), R2C2 (col 1 occupied by R0C1)
    // Row 3: R3C0, R3C1, R3C2 (all 1 row)
    const blocks = [{
        type: 'table', id: 't_staggered',
        rows: [
            row(cell('R0C0-span2', { rowSpan: 2 }), cell('R0C1-span3', { rowSpan: 3 }), cell('R0C2')),
            row(cell('R1C2')),
            row(cell('R2C0'), cell('R2C2')),
            row(cell('R3C0'), cell('R3C1'), cell('R3C2')),
        ],
    }];

    const html = htmlOf(blocks);
    assert.ok(html.includes('rowspan="2"'));
    assert.ok(html.includes('rowspan="3"'));

    const result = await compileOnce(blocks);
    assert.ok(result.pdfBytes && result.pdfBytes.length > 0, 'compile must produce PDF bytes');
    const extracted = extractPdfText(result.pdfBytes);
    const needles = ['R0C0-span2', 'R0C1-span3', 'R0C2', 'R1C2', 'R2C0', 'R2C2', 'R3C0', 'R3C1', 'R3C2'];
    for (const needle of needles) {
        assert.ok(extracted.text.includes(needle), `missing from PDF text: ${needle}`);
    }
});

test('real WASM: 2x2 multi-cell block span occupancy compiles cleanly', async () => {
    // 3-column table with a 2x2 merged block:
    // Row 0: 2x2-block (rowspan: 2, colspan: 2), R0C2
    // Row 1: R1C2 (cols 0, 1 occupied by 2x2-block)
    // Row 2: R2C0, R2C1, R2C2
    const blocks = [{
        type: 'table', id: 't_block2x2',
        rows: [
            row(cell('block-2x2', { rowSpan: 2, colSpan: 2 }), cell('R0C2-side')),
            row(cell('R1C2-side')),
            row(cell('R2C0-base'), cell('R2C1-base'), cell('R2C2-base')),
        ],
    }];

    const html = htmlOf(blocks);
    assert.ok(html.includes('rowspan="2"'));
    assert.ok(html.includes('colspan="2"'));

    const result = await compileOnce(blocks);
    assert.ok(result.pdfBytes && result.pdfBytes.length > 0, 'compile must produce PDF bytes');
    const extracted = extractPdfText(result.pdfBytes);
    const needles = ['block-2x2', 'R0C2-side', 'R1C2-side', 'R2C0-base', 'R2C1-base', 'R2C2-base'];
    for (const needle of needles) {
        assert.ok(extracted.text.includes(needle), `missing from PDF text: ${needle}`);
    }
});
