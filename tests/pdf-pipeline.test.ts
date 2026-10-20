/**
 * tests/pdf-pipeline.test.ts
 * Tier 1 tests for the D7 pipeline skeleton (M1).
 *
 * Locks the frozen M1 semantics with fake stages:
 * - stages run strictly in resources->deliver order;
 * - diagnostics accumulate in stage order and are never dropped;
 * - a plain throw is wrapped as StageError carrying the stage name;
 * - StageError passes through untouched (code/retryable preserved);
 * - abort yields 'aborted', never 'failed';
 * - 'delivered' is returned only after the deliver stage completes.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { PdfPipeline } = require('../src/core/export/pdf/pipeline/orchestrator.js');
const { StageError } = require('../src/core/export/pdf/pipeline/types.js');
const { runStage } = require('../src/core/export/pdf/pipeline/runner.js');

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

function okStage(name: string, output: any, diagnostics: any[] = [], seen: string[] = []) {
    return async (input: any, _ctx: any) => {
        seen.push(name);
        return { output, diagnostics };
    };
}

function fakeInput() {
    return {
        conversationId: 'c1',
        title: 'T',
        bundle: { conversation: { messages: [] } },
        byteStore: { get: () => undefined },
        locale: 'zh',
        compiler: { name: 'fake', compile: async () => ({ pdfBytes: new Uint8Array([1]), diagnostics: [] }) },
        fonts: { fonts: [], diagnostics: [], fallbackChain: [], localFontsAvailable: false },
        useZip: true,
        writer: {},
        folderName: 'f',
    };
}

function fakeStages(seen: string[], overrides: any = {}) {
    return {
        resources: okStage('resources', { pathMap: new Map(), mounts: [], unresolved: [] }, [], seen),
        payload: okStage('payload', { payload: { schemaVersion: 1 } }, [], seen),
        compile: okStage('compile', { pdfBytes: new Uint8Array([0x25, 0x50]) }, [], seen),
        deliver: okStage('deliver', { writeReport: { fileName: 'a.pdf', target: 'zip', bytesWritten: 2, writtenAt: 't' }, finalized: true }, [], seen),
        ...overrides,
    };
}

test('stages run in resources->deliver order and happy path delivers', async () => {
    const seen: string[] = [];
    const p = new PdfPipeline(fakeStages(seen));
    const progress: any[] = [];
    const res: any = await p.runOne(fakeInput(), makeCtx({ reportProgress: (...args: any[]) => progress.push(args) }));
    assert.deepStrictEqual(progress, [['resources', 0, 4], ['payload', 1, 4], ['compile', 2, 4], ['deliver', 3, 4], ['done', 4, 4]]);
    assert.deepStrictEqual(seen, ['resources', 'payload', 'compile', 'deliver']);
    assert.strictEqual(res.status, 'delivered');
    assert.ok(res.writeReport);
    assert.strictEqual(res.error, undefined);
});

test('deliver stage returning finalized:false yields staged, never delivered', async () => {
    const seen: string[] = [];
    const stages = fakeStages(seen, {
        deliver: okStage('deliver', {
            writeReport: { fileName: 'a.pdf', target: 'zip', bytesWritten: 2, writtenAt: 't' },
            finalized: false,
        }, [], seen),
    });
    const p = new PdfPipeline(stages);
    const res: any = await p.runOne(fakeInput(), makeCtx());
    assert.strictEqual(res.status, 'staged');
    // A staged item has no delivery proof: writeReport must be absent so no
    // consumer can mistake it for success (#556/#567).
    assert.strictEqual(res.writeReport, undefined);
    assert.strictEqual(res.error, undefined);
    // ...but it carries its OWN artifact identity (file name + PDF byte
    // length) so the batch driver can write honest per-item records — never
    // the whole-ZIP size (#585 HIGH fix).
    assert.deepStrictEqual(res.stagedArtifact, { fileName: 'a.pdf', bytesWritten: 2 });
});
test('diagnostics accumulate in stage order and are never dropped', async () => {
    const seen: string[] = [];
    const d = (code: string) => ({ severity: 'warning' as const, code, message: code });
    const stages = fakeStages(seen, {
        payload: okStage('payload', { payload: {} }, [d('T1'), d('T2')], seen),
        deliver: okStage('deliver', { writeReport: {}, finalized: true }, [d('D')], seen),
    });
    const p = new PdfPipeline(stages);
    const res: any = await p.runOne(fakeInput(), makeCtx());
    assert.strictEqual(res.status, 'delivered');
    assert.deepStrictEqual(res.diagnostics.map((x: any) => x.code), ['T1', 'T2', 'D']);
});

test('plain throw is wrapped as StageError with the stage name; item failed and retryable', async () => {
    const seen: string[] = [];
    const stages = fakeStages(seen, {
        compile: async () => { throw new Error('boom'); },
    });
    const p = new PdfPipeline(stages);
    const res: any = await p.runOne(fakeInput(), makeCtx());
    assert.strictEqual(res.status, 'failed');
    assert.strictEqual(res.error.stage, 'compile');
    assert.strictEqual(res.error.retryable, true);
    assert.strictEqual(res.writeReport, undefined);
    // deliver must not run after a compile failure
    assert.deepStrictEqual(seen, ['resources', 'payload']);
});

test('StageError passes through untouched', async () => {
    const seen: string[] = [];
    const stages = fakeStages(seen, {
        resources: async () => {
            throw new StageError('resources', 'NO_BYTES', 'no bytes', { retryable: false });
        },
    });
    const p = new PdfPipeline(stages);
    const res: any = await p.runOne(fakeInput(), makeCtx());
    assert.strictEqual(res.status, 'failed');
    assert.strictEqual(res.error.stage, 'resources');
    assert.strictEqual(res.error.code, 'NO_BYTES');
    assert.strictEqual(res.error.retryable, false);
});

test('StageError diagnostics are preserved on failure, exactly once', async () => {
    const seen: string[] = [];
    const d = (code: string) => ({ severity: 'warning' as const, code, message: code });
    const stages = fakeStages(seen, {
        resources: okStage('resources', { pathMap: new Map(), mounts: [], unresolved: [] }, [d('R')], seen),
        payload: async () => {
            throw new StageError('payload', 'ASSET_CORRUPT', 'bad bytes', {
                retryable: true,
                diagnostics: [d('R1'), d('R2')],
            });
        },
    });
    const p = new PdfPipeline(stages);
    const res: any = await p.runOne(fakeInput(), makeCtx());
    assert.strictEqual(res.status, 'failed');
    assert.strictEqual(res.error.stage, 'payload');
    assert.strictEqual(res.error.code, 'ASSET_CORRUPT');
    // Prior stage diagnostics first, then the throwing stage's own, each once.
    assert.deepStrictEqual(res.diagnostics.map((x: any) => x.code), ['R', 'R1', 'R2']);
    assert.strictEqual(res.writeReport, undefined);
});

test('abort yields aborted, never failed', async () => {
    const seen: string[] = [];
    const { controller, ...rest } = makeCtx();
    const stages = fakeStages(seen, {
        payload: async (_input: any, ctx: any) => {
            ctx.signal; // touch
            throw new DOMException('stop', 'AbortError');
        },
    });
    const p = new PdfPipeline(stages);
    const res: any = await p.runOne(fakeInput(), { ...rest, signal: controller.signal });
    assert.strictEqual(res.status, 'aborted');
    assert.strictEqual(res.error, undefined);
});

test('already-aborted signal before runOne aborts without running stages', async () => {
    const seen: string[] = [];
    const ctx = makeCtx();
    ctx.controller.abort();
    const p = new PdfPipeline(fakeStages(seen));
    const res: any = await p.runOne(fakeInput(), ctx);
    assert.strictEqual(res.status, 'aborted');
    assert.deepStrictEqual(seen, []);
});

test('runStage lets AbortError propagate and wraps unknown throws', async () => {
    const ctx = makeCtx();
    await assert.rejects(
        runStage('compile', async () => { throw new DOMException('x', 'AbortError'); }, {}, ctx),
        (e: any) => e instanceof DOMException && e.name === 'AbortError',
    );
    const wrapped: any = await runStage('payload', async () => { throw new Error('nope'); }, {}, ctx).catch((e: any) => e);
    assert.ok(wrapped instanceof StageError);
    assert.strictEqual(wrapped.stage, 'payload');
    assert.strictEqual(wrapped.code, 'STAGE_THREW');
});

test('frozen stage order constant matches wiring', async () => {
    const { PIPELINE_STAGE_ORDER } = require('../src/core/export/pdf/pipeline/types.js');
    assert.deepStrictEqual([...PIPELINE_STAGE_ORDER], ['resources', 'payload', 'compile', 'deliver']);
});
