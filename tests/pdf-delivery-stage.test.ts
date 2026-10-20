/**
 * tests/pdf-delivery-stage.test.ts
 * Tier 1 tests for the delivery stage (M5, corrected): staged/finalized
 * batch-ZIP semantics.
 *
 * Locks the corrected behavior (per D7 coordinator, M1b #577):
 * - folder (useZip=false): writeFile() resolving IS delivery -> finalized:true;
 * - ZIP (useZip=true): deliverStage per item only STAGES into the batch
 *   writer -> finalized:false; generateBlob() and downloadHandler() are NEVER
 *   called per item (N conversations must not trigger N downloads);
 * - finalizeZipDelivery() runs the SINGLE batch-level generateBlob() +
 *   downloadHandler() and returns the delivered blob size;
 * - missing downloadHandler fails fast (MISSING_DOWNLOAD_HANDLER, not
 *   retryable) BEFORE any write work;
 * - write/finalize/download failures throw StageError (retryable) carrying
 *   diagnostics that spell out staged-but-NOT-delivered (never silent);
 * - abort is never converted into a quiet failure; after a cancel there is
 *   no package and no download.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { deliverStage, finalizeZipDelivery } = require('../src/core/export/pdf/pipeline/deliveryStage.js');
const { StageError } = require('../src/core/export/pdf/pipeline/types.js');
const { runStage } = require('../src/core/export/pdf/pipeline/runner.js');
const { buildExportFileName } = require('../src/core/utils/pathUtils.js');

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // '%PDF-'

function makeCtx(overrides: any = {}) {
    const controller = new AbortController();
    return {
        controller,
        signal: controller.signal,
        reportProgress: (_s: string, _c: number, _t: number) => {},
        log: (_m: string, _l?: string) => {},
        ...overrides,
    };
}

function makeInput(overrides: any = {}) {
    return {
        conversationId: 'c1',
        title: 'Hello World',
        pdfBytes: PDF_BYTES,
        useZip: false,
        writer: {},
        folderName: 'gemini_export',
        ...overrides,
    };
}

function fakeWriter(overrides: any = {}) {
    const calls: any[] = [];
    return {
        calls,
        writeFile: async (name: string, content: any) => {
            calls.push(['writeFile', name, content]);
            return name;
        },
        ...overrides,
    };
}

async function assertStageError(promise: Promise<any>, code: string, retryable: boolean) {
    try {
        await promise;
    } catch (e: any) {
        assert.ok(e instanceof StageError, `expected StageError, got ${e}`);
        assert.strictEqual(e.stage, 'deliver');
        assert.strictEqual(e.code, code);
        assert.strictEqual(e.retryable, retryable);
        return e as any;
    }
    assert.fail(`expected StageError(${code}) but the promise resolved`);
}

// ---------------------------------------------------------------------------
// deliverStage: per-item staged/finalized
// ---------------------------------------------------------------------------

test('zip: deliverStage only STAGES (finalized:false); never packages or downloads per item', async () => {
    let generateBlobCalls = 0;
    let handlerCalls = 0;
    const writer = fakeWriter({
        generateBlob: async () => {
            generateBlobCalls++;
            return new Blob(['x']);
        },
    });
    const ctx = makeCtx();
    const res: any = await deliverStage(
        makeInput({
            useZip: true,
            writer,
            downloadHandler: async () => {
                handlerCalls++;
            },
        }),
        ctx,
    );
    const expectedFileName = buildExportFileName('Hello World', 'c1', 'pdf');
    // The PDF was staged into the writer.
    assert.strictEqual(writer.calls.length, 1);
    assert.strictEqual(writer.calls[0][0], 'writeFile');
    assert.strictEqual(writer.calls[0][1], expectedFileName);
    assert.strictEqual(writer.calls[0][2], PDF_BYTES);
    // But NOT finalized: no per-item package or download may happen.
    assert.strictEqual(generateBlobCalls, 0, 'generateBlob must not run per item');
    assert.strictEqual(handlerCalls, 0, 'downloadHandler must not run per item');
    assert.strictEqual(res.output.finalized, false);
    assert.deepStrictEqual(Object.keys(res.output.writeReport).sort(), [
        'bytesWritten',
        'fileName',
        'target',
        'writtenAt',
    ]);
    assert.strictEqual(res.output.writeReport.fileName, expectedFileName);
    assert.strictEqual(res.output.writeReport.target, 'zip');
    assert.strictEqual(res.output.writeReport.bytesWritten, PDF_BYTES.byteLength);
    assert.ok(!Number.isNaN(Date.parse(res.output.writeReport.writtenAt)), 'writtenAt must be a valid ISO timestamp');
    assert.deepStrictEqual(res.diagnostics, []);
});

test('zip without downloadHandler fails fast with MISSING_DOWNLOAD_HANDLER (not retryable)', async () => {
    const writer = fakeWriter();
    const err = await assertStageError(
        deliverStage(makeInput({ useZip: true, writer }), makeCtx()),
        'MISSING_DOWNLOAD_HANDLER',
        false,
    );
    // Fail-fast: no write work may happen before the config check.
    assert.deepStrictEqual(writer.calls, []);
    assert.ok(err.diagnostics.length > 0, 'config error must carry diagnostics');
    assert.strictEqual(err.diagnostics[0].code, 'MISSING_DOWNLOAD_HANDLER');
});

test('folder: writeFile resolving IS delivery (finalized:true); no handler or generateBlob needed', async () => {
    const writer = fakeWriter();
    const res: any = await deliverStage(makeInput({ useZip: false, writer }), makeCtx());
    assert.strictEqual(writer.calls.length, 1);
    assert.strictEqual(writer.calls[0][1], buildExportFileName('Hello World', 'c1', 'pdf'));
    assert.strictEqual(res.output.finalized, true);
    assert.strictEqual(res.output.writeReport.target, 'folder');
    assert.strictEqual(res.output.writeReport.bytesWritten, PDF_BYTES.byteLength);
    assert.strictEqual(res.output.writeReport.fileName, buildExportFileName('Hello World', 'c1', 'pdf'));
});

test('writeFile throwing -> WRITE_FAILED (retryable) with diagnostics', async () => {
    const writer = fakeWriter({
        writeFile: async () => {
            throw new Error('disk full');
        },
    });
    const logged: any[] = [];
    const err = await assertStageError(
        deliverStage(makeInput({ useZip: false, writer }), makeCtx({ log: (m: string, l?: string) => logged.push([m, l]) })),
        'WRITE_FAILED',
        true,
    );
    assert.strictEqual(err.diagnostics.length, 1);
    assert.strictEqual(err.diagnostics[0].code, 'WRITE_FAILED');
    assert.ok(err.diagnostics[0].message.includes('disk full'));
    // Loud: the failure must reach the visible log channel.
    assert.ok(logged.some(([m, l]: any) => l === 'error' && m.includes('disk full')));
});

test('abort propagates as AbortError through runStage (never converted)', async () => {
    const ctx = makeCtx();
    ctx.controller.abort();
    const writer = fakeWriter();
    try {
        await runStage('deliver', deliverStage, makeInput({ useZip: false, writer }), ctx);
        assert.fail('expected AbortError');
    } catch (e: any) {
        assert.strictEqual(e.name, 'AbortError');
        assert.deepStrictEqual(writer.calls, [], 'no write may happen after abort');
    }
});

// ---------------------------------------------------------------------------
// finalizeZipDelivery: the single batch-level package + download
// ---------------------------------------------------------------------------

test('finalize: success calls generateBlob and downloadHandler exactly once', async () => {
    const blob = new Blob(['zip-bytes'], { type: 'application/zip' });
    let generateBlobCalls = 0;
    const seen: any[] = [];
    const writer = fakeWriter({
        generateBlob: async () => {
            generateBlobCalls++;
            return blob;
        },
    });
    const zipFileName = buildExportFileName('Batch', 'batch-1', 'zip');
    const res: any = await finalizeZipDelivery(
        writer,
        async (b: Blob, name: string) => {
            seen.push([b, name]);
        },
        zipFileName,
        makeCtx(),
    );
    assert.strictEqual(generateBlobCalls, 1);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0][0], blob);
    assert.strictEqual(seen[0][1], zipFileName);
    assert.strictEqual(res.bytesWritten, blob.size);
});

test('finalize: missing generateBlob -> ZIP_FINALIZE_UNAVAILABLE (not retryable)', async () => {
    const writer = fakeWriter(); // no generateBlob
    const err = await assertStageError(
        finalizeZipDelivery(writer, async () => {}, 'batch.zip', makeCtx()),
        'ZIP_FINALIZE_UNAVAILABLE',
        false,
    );
    assert.ok(err.diagnostics.length > 0);
    assert.ok(err.diagnostics[0].message.includes('NOT delivered'));
});

test('finalize: generateBlob throwing -> ZIP_FINALIZE_FAILED (retryable), staged-but-NOT-delivered', async () => {
    const writer = fakeWriter({
        generateBlob: async () => {
            throw new Error('jszip oom');
        },
    });
    const err = await assertStageError(
        finalizeZipDelivery(writer, async () => {}, 'batch.zip', makeCtx()),
        'ZIP_FINALIZE_FAILED',
        true,
    );
    assert.ok(err.diagnostics.length > 0);
    assert.strictEqual(err.diagnostics[0].code, 'ZIP_FINALIZE_FAILED');
    assert.ok(err.diagnostics[0].message.includes('NOT delivered'));
    assert.ok(err.diagnostics[0].message.includes('jszip oom'));
});

test('finalize: downloadHandler throwing -> DOWNLOAD_FAILED (retryable)', async () => {
    const blob = new Blob(['x'], { type: 'application/zip' });
    const writer = fakeWriter({
        generateBlob: async () => blob,
    });
    const err = await assertStageError(
        finalizeZipDelivery(
            writer,
            async () => {
                throw new Error('user blocked the download');
            },
            'batch.zip',
            makeCtx(),
        ),
        'DOWNLOAD_FAILED',
        true,
    );
    assert.strictEqual(err.diagnostics.length, 1);
    assert.strictEqual(err.diagnostics[0].code, 'DOWNLOAD_FAILED');
    assert.ok(err.diagnostics[0].message.includes('NOT delivered to the user'));
});

test('finalize: missing downloadHandler fails fast with MISSING_DOWNLOAD_HANDLER', async () => {
    const writer = fakeWriter({
        generateBlob: async () => new Blob(['x']),
    });
    const err = await assertStageError(
        finalizeZipDelivery(writer, undefined as any, 'batch.zip', makeCtx()),
        'MISSING_DOWNLOAD_HANDLER',
        false,
    );
    assert.ok(err.diagnostics.length > 0);
});

test('finalize: abort before finalize -> AbortError; no package, no download', async () => {
    const ctx = makeCtx();
    ctx.controller.abort();
    let generateBlobCalled = false;
    let handlerCalled = false;
    const writer = fakeWriter({
        generateBlob: async () => {
            generateBlobCalled = true;
            return new Blob(['x']);
        },
    });
    try {
        await finalizeZipDelivery(
            writer,
            async () => {
                handlerCalled = true;
            },
            'batch.zip',
            ctx,
        );
        assert.fail('expected AbortError');
    } catch (e: any) {
        assert.strictEqual(e.name, 'AbortError');
    }
    assert.strictEqual(generateBlobCalled, false, 'never package after a cancel');
    assert.strictEqual(handlerCalled, false, 'never download after a cancel');
});
