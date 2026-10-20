/**
 * tests/pdf-options-metadata-resolution.test.ts
 *
 * P0: the Options workbench hands PdfExporter shallow metadata-only list
 * items (id/title/updatedAt, NO messages). The exporter must resolve the full
 * conversation through the existing BatchWorker.fetchChatDetail path BEFORE
 * normalizing — and must fail closed (never emit a "0 messages" PDF) when
 * detail cannot be resolved.
 *
 * The key regression input is deliberately metadata-only:
 *   options.conversations = [{ id: 'abc', title: '...', updatedAt: '...' }]
 * with fetchChatDetail injected to return the full conversation. Using
 * makeSample({ messages: [...] }) directly as the input would bypass the
 * production bug, so it is forbidden here.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { PdfExporter, PDF_NO_MESSAGES } = require('../src/core/export/pdf/index.js');
const { extractPdfText } = require('./helpers/pdfTextExtract.js');

const fixtureDir = path.join(__dirname, 'fixtures', 'canonical');
const sample = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'gemini-normalizer-sample.json'), 'utf8'));

const MARKER = 'REGRESSION-MARKER-9f2c71';

/** Full conversation as fetchChatDetail would return it (real messages). */
function makeFullChat(id: string, title: string): any {
    const c = JSON.parse(JSON.stringify(sample));
    c.id = id;
    c.title = title;
    for (const m of c.messages) {
        if (typeof m.content === 'string') m.content = `${m.content}\n\n${MARKER}\n`;
    }
    return c;
}

/** Recursively collect plain text from canonical bundle inline/block nodes. */
function flattenText(node: any): string {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(flattenText).join(' ');
    if (typeof node === 'object') {
        if (typeof node.text === 'string') return node.text;
        if (Array.isArray(node.children)) return node.children.map(flattenText).join('');
    }
    return '';
}

function bundleBodyText(bundle: any, maxLen = 600): string {
    const msgs = bundle?.conversation?.messages ?? [];
    const parts: string[] = [];
    for (const m of msgs) {
        for (const b of m?.blocks ?? []) parts.push(flattenText(b));
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function escapePdfLiteral(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Minimal structurally valid PDF embedding title + body text. */
function buildTextPdf(title: string, body: string): Uint8Array {
    const enc = new TextEncoder();
    const content = [
        'BT /F1 24 Tf 72 720 Td',
        `(${escapePdfLiteral(title)}) Tj`,
        '0 -36 Td',
        '/F1 12 Tf',
        `(${escapePdfLiteral(body)}) Tj`,
        'ET',
    ].join('\n');
    const contentBytes = enc.encode(content);
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let bodyOut = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((dict, i) => {
        offsets.push(enc.encode(bodyOut).length);
        bodyOut += `${i + 1} 0 obj\n${dict}\nendobj\n`;
    });
    const xrefOffset = enc.encode(bodyOut).length;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
    const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return enc.encode(bodyOut + xref + trailer);
}

/** Test-local compiler: captures the bundle, counts calls, emits a real PDF. */
function makeCaptureCompiler(state: { calls: number; bundle: any }) {
    return new (class {
        readonly name = 'metadata-resolution-test-compiler';
        async compile(payload: any, _context: any) {
            state.calls++;
            state.bundle = payload?.bundle ?? null;
            const title =
                payload?.document?.title ??
                payload?.bundle?.conversation?.title ??
                'untitled';
            return { pdfBytes: buildTextPdf(String(title), bundleBodyText(payload?.bundle)), diagnostics: [] };
        }
    })() as any;
}

/** In-memory writer: records every written file for the fail-closed assertions. */
function makeMemoryWriter() {
    const files = new Map<string, Uint8Array>();
    return {
        files,
        async writeFile(name: string, content: any) {
            const bytes = content instanceof Uint8Array ? content : new Uint8Array(0);
            files.set(String(name), bytes);
            return String(name);
        },
        async close() {},
    };
}

// ---------------------------------------------------------------------------
// 1. Regression: metadata-only input resolves detail via fetchChatDetail
// ---------------------------------------------------------------------------

test('regression: metadata-only options.conversations item resolves full detail before normalize', async () => {
    const id = 'abc';
    const title = 'Options Metadata Chat';
    const fullChat = makeFullChat(id, title);
    // The production bug input: shallow metadata, NO messages key at all.
    const metadataOnly = { id, title, updatedAt: '2026-09-26T00:00:00.000Z' };
    assert.ok(!('messages' in metadataOnly), 'test input must be metadata-only');

    const fetchCalls: any[] = [];
    const fetchChatDetail = async (requestedItem: any, index: number, total: number, slot: string, skip: boolean, format: string) => {
        fetchCalls.push({ requestedItem, index, total, slot, skip, format });
        return { success: true, results: [JSON.parse(JSON.stringify(fullChat))] };
    };

    const compilerState = { calls: 0, bundle: null as any };
    const writer = makeMemoryWriter();
    const exporter = new PdfExporter(makeCaptureCompiler(compilerState));
    const exported: any[] = [];

    const result = await exporter.run(
        {
            selected: [{ id, title }],
            conversations: [metadataOnly],
            useZip: false,
            writer,
            fetchChatDetail,
        },
        { onItemExported: (cid: string, record: any) => exported.push({ cid, record }) }
    );

    // fetchChatDetail must have been called — the old code never called it.
    assert.strictEqual(fetchCalls.length, 1, 'fetchChatDetail must be called exactly once');
    assert.strictEqual(fetchCalls[0].requestedItem.id, id);
    assert.strictEqual(fetchCalls[0].format, 'pdf');

    // The normalized bundle must carry the real messages.
    const bundleMsgCount = compilerState.bundle?.conversation?.messages?.length ?? 0;
    assert.ok(bundleMsgCount > 0, `bundle message count must be > 0, got ${bundleMsgCount}`);

    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.succeeded, 1, 'export must succeed');
    assert.strictEqual(result.failed.length, 0);
    assert.strictEqual(compilerState.calls, 1, 'compiler must run exactly once');

    // The delivered PDF must not be a "0 messages" shell and must carry body text.
    assert.strictEqual(writer.files.size, 1, 'exactly one PDF written');
    const pdfBytes = [...writer.files.values()][0];
    const extracted = extractPdfText(pdfBytes);
    assert.ok(!extracted.text.includes('0 messages'), 'PDF must not contain "0 messages"');
    assert.ok(extracted.text.includes(MARKER), 'PDF must contain the expected body text');

    assert.strictEqual(exported.length, 1, 'success record must be emitted');
    assert.strictEqual(exported[0].record.status, 'ok');
});

// ---------------------------------------------------------------------------
// 2. Regression: metadata-only item comes from selected, not
//    options.conversations — the fetch + fail-closed guards must not depend
//    on where the shallow object came from.
// ---------------------------------------------------------------------------

test('regression: metadata-only selected (empty conversations) resolves full detail before normalize', async () => {
    const id = 'jkl';
    const title = 'Selected Metadata Chat';
    const fullChat = makeFullChat(id, title);
    // Shallow object carried in selected, with no list entry to find.
    const metadataOnly = { id, title, updatedAt: '2026-09-26T00:00:00.000Z' };
    assert.ok(!('messages' in metadataOnly), 'test input must be metadata-only');

    const fetchCalls: any[] = [];
    const fetchChatDetail = async (requestedItem: any, index: number, total: number, slot: string, skip: boolean, format: string) => {
        fetchCalls.push({ requestedItem, index, total, slot, skip, format });
        return { success: true, results: [JSON.parse(JSON.stringify(fullChat))] };
    };

    const compilerState = { calls: 0, bundle: null as any };
    const writer = makeMemoryWriter();
    const exporter = new PdfExporter(makeCaptureCompiler(compilerState));
    const exported: any[] = [];

    const result = await exporter.run(
        {
            selected: [metadataOnly],
            conversations: [],
            useZip: false,
            writer,
            fetchChatDetail,
        },
        { onItemExported: (cid: string, record: any) => exported.push({ cid, record }) }
    );

    assert.strictEqual(fetchCalls.length, 1, 'fetchChatDetail must be called exactly once');
    const bundleMsgCount = compilerState.bundle?.conversation?.messages?.length ?? 0;
    assert.ok(bundleMsgCount > 0, `bundle message count must be > 0, got ${bundleMsgCount}`);

    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.succeeded, 1, 'export must succeed');
    assert.strictEqual(result.failed.length, 0);
    assert.strictEqual(compilerState.calls, 1, 'compiler must run exactly once');

    assert.strictEqual(writer.files.size, 1, 'exactly one PDF written');
    const pdfBytes = [...writer.files.values()][0];
    const extracted = extractPdfText(pdfBytes);
    assert.ok(extracted.text.includes(MARKER), 'PDF must contain the expected body text');

    assert.strictEqual(exported.length, 1, 'success record must be emitted');
    assert.strictEqual(exported[0].record.status, 'ok');
});

test('fail-closed: metadata-only selected resolving to zero messages fails with PDF_NO_MESSAGES', async () => {
    const id = 'mno';
    const title = 'Selected Empty Chat';
    const metadataOnly = { id, title, updatedAt: '2026-09-26T00:00:00.000Z' };

    const fetchChatDetail = async () => ({
        success: true,
        results: [{ id, title, messages: [] }],
    });

    const compilerState = { calls: 0, bundle: null as any };
    const writer = makeMemoryWriter();
    const exporter = new PdfExporter(makeCaptureCompiler(compilerState));
    const exported: any[] = [];

    const result = await exporter.run(
        {
            selected: [metadataOnly],
            conversations: [],
            useZip: false,
            writer,
            fetchChatDetail,
        },
        { onItemExported: (cid: string, record: any) => exported.push({ cid, record }) }
    );

    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.succeeded, 0, 'succeeded must not increase');
    assert.strictEqual(result.failed.length, 1);
    assert.ok(
        result.failed[0].error.includes(PDF_NO_MESSAGES),
        `error must carry PDF_NO_MESSAGES, got: ${result.failed[0].error}`
    );
    assert.strictEqual(compilerState.calls, 0, 'compiler must not run');
    assert.strictEqual(writer.files.size, 0, 'no PDF must be written');
    assert.strictEqual(exported.length, 0, 'no success record must be emitted');
});

// ---------------------------------------------------------------------------
// 3. Fail closed: detail fetch failure
// ---------------------------------------------------------------------------

test('fail-closed: detail fetch failure fails the item without compiling or writing', async () => {
    const id = 'def';
    const title = 'Broken Chat';
    const metadataOnly = { id, title, updatedAt: '2026-09-26T00:00:00.000Z' };

    const fetchChatDetail = async () => ({ success: false, error: 'network down' });

    const compilerState = { calls: 0, bundle: null as any };
    const writer = makeMemoryWriter();
    const exporter = new PdfExporter(makeCaptureCompiler(compilerState));
    const exported: any[] = [];

    const result = await exporter.run(
        {
            selected: [{ id, title }],
            conversations: [metadataOnly],
            useZip: false,
            writer,
            fetchChatDetail,
        },
        { onItemExported: (cid: string, record: any) => exported.push({ cid, record }) }
    );

    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.succeeded, 0, 'succeeded must not increase');
    assert.strictEqual(result.failed.length, 1);
    assert.ok(
        result.failed[0].error.includes(PDF_NO_MESSAGES),
        `error must carry PDF_NO_MESSAGES, got: ${result.failed[0].error}`
    );
    assert.strictEqual(compilerState.calls, 0, 'compiler must not run');
    assert.strictEqual(writer.files.size, 0, 'no PDF must be written');
    assert.strictEqual(exported.length, 0, 'no success record must be emitted');
});

// ---------------------------------------------------------------------------
// 4. Fail closed: resolved conversation still has no usable messages
// ---------------------------------------------------------------------------

test('fail-closed: resolved conversation without messages fails with PDF_NO_MESSAGES', async () => {
    const id = 'ghi';
    const title = 'Empty Chat';
    const metadataOnly = { id, title, updatedAt: '2026-09-26T00:00:00.000Z' };

    const fetchChatDetail = async () => ({
        success: true,
        results: [{ id, title, messages: [] }],
    });

    const compilerState = { calls: 0, bundle: null as any };
    const writer = makeMemoryWriter();
    const exporter = new PdfExporter(makeCaptureCompiler(compilerState));
    const exported: any[] = [];

    const result = await exporter.run(
        {
            selected: [{ id, title }],
            conversations: [metadataOnly],
            useZip: false,
            writer,
            fetchChatDetail,
        },
        { onItemExported: (cid: string, record: any) => exported.push({ cid, record }) }
    );

    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.succeeded, 0, 'succeeded must not increase');
    assert.strictEqual(result.failed.length, 1);
    assert.ok(
        result.failed[0].error.includes(PDF_NO_MESSAGES),
        `error must carry PDF_NO_MESSAGES, got: ${result.failed[0].error}`
    );
    assert.strictEqual(compilerState.calls, 0, 'compiler must not run');
    assert.strictEqual(writer.files.size, 0, 'no PDF must be written');
    assert.strictEqual(exported.length, 0, 'no success record must be emitted');
});
