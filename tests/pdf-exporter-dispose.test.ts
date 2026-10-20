/**
 * tests/pdf-exporter-dispose.test.ts
 *
 * Tier 1 tests for the #592 P1 fix: the production-owned Typst sandbox
 * compiler must be disposed at run end, and an injected/shared compiler
 * must never be disposed by the exporter.
 *
 * Background: every production export built a fresh TypstSandboxCompiler
 * (hidden iframe + window message listener capturing `this` + WASM state +
 * cached font bytes), but nothing ever called its dispose() — exportController
 * only nulled the reference and PdfExporter.abort() only aborts. One export
 * leaked one sandbox; repeated exports accumulated them.
 *
 * Ownership rule under test:
 * - `new PdfExporter()` (no compiler) owns its compiler -> dispose() must
 *   tear it down. The production controller calls dispose() in its
 *   run-finally on every path (success / failure / abort).
 * - `new PdfExporter(injected)` never owns it -> dispose() must not touch
 *   the caller's compiler. Same for a per-run `options.compiler`.
 * - abort() is cancel-only and never disposes.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { PdfExporter } = require('../src/core/export/pdf/index.js');
const { buildMinimalValidPdf } = require('./helpers/stubPdfCompiler.js');
const { TypstSandboxCompiler } = require('../src/core/export/typst/typstSandboxCompiler.js');

const fixtureDir = path.join(__dirname, 'fixtures', 'canonical');
const sample = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'gemini-normalizer-sample.json'), 'utf8'));

/** Fake an extension page context so `new PdfExporter()` builds the real default compiler. */
function fakeExtensionPageContext() {
    const g = globalThis as any;
    const prevDocument = g.document;
    const prevChrome = g.chrome;
    g.document = {};
    g.chrome = { runtime: { getURL: (p: string) => `chrome-extension://fake/${p}` } };
    return () => {
        if (prevDocument === undefined) delete g.document;
        else g.document = prevDocument;
        if (prevChrome === undefined) delete g.chrome;
        else g.chrome = prevChrome;
    };
}

/** Spy on TypstSandboxCompiler.prototype.dispose; restores on cleanup. */
function spyOnSandboxDispose() {
    const proto = TypstSandboxCompiler.prototype;
    const original = proto.dispose;
    let calls = 0;
    proto.dispose = function (this: any, ...args: any[]) {
        calls += 1;
        return original.apply(this, args);
    };
    return {
        get calls() {
            return calls;
        },
        restore() {
            proto.dispose = original;
        },
    };
}

function makeFakeWriter() {
    const files: Array<{ name: string; bytes: Uint8Array }> = [];
    const writer = {
        files,
        async writeFile(relativePath: string, content: any) {
            const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(String(content));
            files.push({ name: relativePath, bytes });
            return relativePath;
        },
        async generateBlob() {
            return new Blob(files.map((f) => f.bytes as any), { type: 'application/zip' });
        },
    };
    return writer;
}

/** A per-run injected compiler the exporter must never dispose. */
function makeFakeCompiler(opts: { throws?: boolean } = {}) {
    const calls = { dispose: 0, compile: 0 };
    return {
        calls,
        name: 'fake-test-compiler',
        async compile() {
            calls.compile += 1;
            if (opts.throws) throw new Error('fake compile boom');
            return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
        },
        dispose() {
            calls.dispose += 1;
        },
    };
}

function baseOptions(writer: any, extra: any = {}) {
    return {
        selected: [{ id: sample.id, title: sample.title }],
        conversations: [sample],
        useZip: false,
        writer,
        ...extra,
    };
}

/**
 * Mirror of the production controller's run-finally
 * (exportController.runExport): dispose the owned compiler on every path,
 * then drop the reference.
 */
async function runLikeController(exporter: any, options: any) {
    try {
        return await exporter.run(options, { onLog: () => {} });
    } finally {
        try {
            exporter?.dispose?.();
        } finally {
            /* controller nulls its activeEngine ref here */
        }
    }
}

test('dispose: production-owned compiler (constructor default) is disposed', () => {
    const restoreCtx = fakeExtensionPageContext();
    const spy = spyOnSandboxDispose();
    try {
        const exporter = new PdfExporter();
        exporter.dispose();
        assert.strictEqual(spy.calls, 1, 'the owned TypstSandboxCompiler must be disposed');
    } finally {
        spy.restore();
        restoreCtx();
    }
});

test('dispose: an injected/shared compiler is never disposed', async () => {
    const fake = makeFakeCompiler();
    const writer = makeFakeWriter();
    const exporter = new PdfExporter(fake as any);
    const result = await runLikeController(exporter, baseOptions(writer, { compiler: fake }));
    assert.strictEqual(result.succeeded, 1);
    assert.strictEqual(fake.calls.dispose, 0, 'injected compilers belong to their caller');
});

test('dispose: owned compiler disposed after a successful run; per-run injected compiler untouched', async () => {
    const restoreCtx = fakeExtensionPageContext();
    const spy = spyOnSandboxDispose();
    try {
        const fake = makeFakeCompiler();
        const writer = makeFakeWriter();
        const exporter = new PdfExporter();
        const result = await runLikeController(exporter, baseOptions(writer, { compiler: fake }));
        assert.strictEqual(result.succeeded, 1, 'run itself must succeed');
        assert.strictEqual(spy.calls, 1, 'owned constructor compiler disposed at run end');
        assert.strictEqual(fake.calls.dispose, 0, 'per-run injected compiler must not be disposed');
    } finally {
        spy.restore();
        restoreCtx();
    }
});

test('dispose: owned compiler disposed after a failed run; per-run injected compiler untouched', async () => {
    const restoreCtx = fakeExtensionPageContext();
    const spy = spyOnSandboxDispose();
    try {
        const fake = makeFakeCompiler({ throws: true });
        const writer = makeFakeWriter();
        const exporter = new PdfExporter();
        const result = await runLikeController(exporter, baseOptions(writer, { compiler: fake }));
        assert.strictEqual(result.succeeded, 0);
        assert.strictEqual(result.failed.length, 1, 'the throwing compile must surface as a failed item');
        assert.strictEqual(spy.calls, 1, 'owned constructor compiler disposed even on the failure path');
        assert.strictEqual(fake.calls.dispose, 0, 'per-run injected compiler must not be disposed');
    } finally {
        spy.restore();
        restoreCtx();
    }
});

test('dispose: abort() is cancel-only and never disposes', () => {
    const restoreCtx = fakeExtensionPageContext();
    const spy = spyOnSandboxDispose();
    try {
        const exporter = new PdfExporter();
        exporter.abort();
        assert.strictEqual(exporter.aborted, true);
        assert.strictEqual(spy.calls, 0, 'abort must not dispose; disposal happens at run end');
        exporter.dispose();
        assert.strictEqual(spy.calls, 1);
    } finally {
        spy.restore();
        restoreCtx();
    }
});

test('dispose: idempotent, safe to call twice', () => {
    const restoreCtx = fakeExtensionPageContext();
    const spy = spyOnSandboxDispose();
    try {
        const exporter = new PdfExporter();
        exporter.dispose();
        exporter.dispose();
        assert.strictEqual(spy.calls, 2, 'double dispose must not throw; underlying dispose is idempotent');
    } finally {
        spy.restore();
        restoreCtx();
    }
});
