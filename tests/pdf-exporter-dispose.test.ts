import test from 'node:test';
import assert from 'node:assert/strict';
import { TypstSandboxCompiler } from '../src/l4/format/pdf/typst/typstSandboxCompiler.js';
import { compileDocumentPdf } from '../src/l4/format/pdf/compileDocumentPdf.js';
import { runExport } from '../src/application/export/runExport.js';
import { v2ExportHost, seedExportConversation, exportRequest } from './helpers/v2ExportHost.js';
import { buildMinimalValidPdf } from './helpers/stubPdfCompiler.js';
import type { DocumentAst } from '../src/l3b/ast/ast.js';

// Compiler lifetime moved from PdfExporter/UI controller into unified Export.
const document: DocumentAst = { title: 'Owned compiler', metadata: { id: 'dispose', provider: 'gemini' }, messages: [] };
const context = () => ({ signal: new AbortController().signal, reportProgress() {} });
test('pure PDF format leaves an injected compiler owned by its caller on success and failure', async () => {
    let disposed = 0, fail = false;
    const compiler = { name: 'caller-owned', dispose() { disposed++; }, async compile() {
        if (fail) throw new Error('compile failed'); return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
    } };
    await compileDocumentPdf(document, {}, new Map(), compiler, context());
    fail = true;
    await assert.rejects(compileDocumentPdf(document, {}, new Map(), compiler, context()), /compile failed/);
    assert.equal(disposed, 0);
});
for (const mode of ['success', 'failure', 'abort'] as const) {
    test(`unified Export disposes its owned compiler exactly once after ${mode}`, async t => {
        const host = v2ExportHost(t);
        await seedExportConversation('dispose');
        const controller = new AbortController();
        const compile = t.mock.method(TypstSandboxCompiler.prototype, 'compile', async () => {
            if (mode === 'failure') throw new Error('compile failed');
            if (mode === 'abort') { controller.abort(); controller.signal.throwIfAborted(); }
            return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
        });
        const dispose = t.mock.method(TypstSandboxCompiler.prototype, 'dispose');
        const result = await runExport(exportRequest(['dispose'], { format: 'pdf' }), { signal: controller.signal });
        assert.equal(compile.mock.callCount(), 1);
        assert.equal(dispose.mock.callCount(), 1);
        assert.equal(host.clicks(), mode === 'success' ? 1 : 0);
        assert.equal(result.exported, mode === 'success' ? 1 : 0);
        assert.equal(result.aborted, mode === 'abort');
        assert.equal(result.failed.length, mode === 'failure' ? 1 : 0);
    });
}
test('cancellation before compiler initialization allocates no sandbox', async t => {
    v2ExportHost(t);
    const dispose = t.mock.method(TypstSandboxCompiler.prototype, 'dispose');
    const controller = new AbortController(); controller.abort();
    assert.equal((await runExport(exportRequest(['unstarted'], { format: 'pdf' }), { signal: controller.signal })).aborted, true);
    assert.equal(dispose.mock.callCount(), 0);
});
test('batch conversations share one compiler and dispose it once at task end', async t => {
    v2ExportHost(t);
    await seedExportConversation('one'); await seedExportConversation('two');
    const { __setZipConstructor, __getZipConstructor } = require('../src/l4/packaging/writers/zipWriter.js');
    const previous = __getZipConstructor(); __setZipConstructor(require('../lib/jszip.min.js'));
    t.after(() => __setZipConstructor(previous));
    const instances = new Set<TypstSandboxCompiler>();
    t.mock.method(TypstSandboxCompiler.prototype, 'compile', async function(this: TypstSandboxCompiler) {
        instances.add(this); return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
    });
    const dispose = t.mock.method(TypstSandboxCompiler.prototype, 'dispose');
    assert.equal((await runExport(exportRequest(['one', 'two'], { format: 'pdf' }))).exported, 2);
    assert.equal(instances.size, 1); assert.equal(dispose.mock.callCount(), 1);
});
test('sandbox disposal itself is idempotent before and after initialization', () => {
    const compiler = new TypstSandboxCompiler();
    assert.doesNotThrow(() => compiler.dispose());
    assert.doesNotThrow(() => compiler.dispose());
});
