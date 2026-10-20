/**
 * tests/pdf-compile-stage.test.ts
 * Tier 1 tests for the compile stage (M4).
 *
 * Focused coverage with an injected stub compiler:
 * - happy path: stub output verified and returned; RenderContext carries
 *   bundle/locale/signal and the mount-backed resolver; the compiler gets
 *   the prebuilt doc + pathMap slots (D7 M1c contract);
 * - resolver: deterministic pathMap lookup (assetId -> pathMap -> mount);
 *   hash-shaped virtual paths resolve; unmapped / unmatched / ambiguous /
 *   empty mounts return null + a diagnostic (placeholder semantics, never
 *   silent, never guessed);
 * - verification failures (empty / non-PDF / truncated) -> StageError,
 *   never a blank PDF marked ok;
 * - compiler throw -> StageError with cause;
 * - abort propagates untouched, never wrapped in StageError;
 * - injected font resolution diagnostics are forwarded, never dropped.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { compileStage } = require('../src/core/export/pdf/pipeline/compileStage.js');
const { StageError } = require('../src/core/export/pdf/pipeline/types.js');
const { buildMinimalValidPdf } = require('./helpers/stubPdfCompiler.js');

/**
 * The only valid "minimal PDF" in this file. Its startxref offset is
 * computed by the builder and genuinely points at the xref table — the
 * hand-written `startxref 0` fixtures of the past are not valid PDFs and
 * are rejected by the pointer check below.
 */
function pdfBytes(text?: string): Uint8Array {
    return text === undefined ? buildMinimalValidPdf() : new TextEncoder().encode(text);
}

/** Decode a built PDF back to text so a test can surgically corrupt it. */
function validPdfText(): string {
    return new TextDecoder().decode(buildMinimalValidPdf());
}

function makeCtx() {
    const controller = new AbortController();
    const logs: Array<{ message: string; level?: string }> = [];
    return {
        controller,
        logs,
        signal: controller.signal,
        reportProgress: (_s: string, _c: number, _t: number) => {},
        log: (message: string, level?: string) => {
            logs.push({ message, level });
        },
    };
}

function fakeBundle(assets: any[] = []) {
    return {
        conversation: { messages: [] },
        assets,
    };
}

function fakeInput(overrides: any = {}) {
    return {
        payload: { schemaVersion: 1, title: 'T', provider: 'gemini', date: '2026-09-26', messageCount: 0, messages: [] },
        bundle: fakeBundle([{ id: 'a1', kind: 'image', status: 'available' }]),
        mounts: [],
        pathMap: new Map<string, string>(),
        fonts: { fonts: [], diagnostics: [], fallbackChain: [], localFontsAvailable: false },
        compiler: makeStub().compiler,
        locale: 'zh',
        ...overrides,
    };
}

/** Configurable stub IPdfCompiler; captures what the stage handed it. */
function makeStub(options: {
    bytes?: Uint8Array;
    failWith?: string;
    delayMs?: number;
    resolveIds?: string[];
    diagnostics?: any[];
} = {}) {
    const captured: {
        payload?: any;
        context?: any;
        resolved: Record<string, any>;
    } = { resolved: {} };
    const compiler = {
        name: 'test-stub',
        compile: async (payload: any, context: any) => {
            captured.payload = payload;
            captured.context = context;
            if (options.delayMs) {
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(resolve, options.delayMs);
                    context.signal.addEventListener(
                        'abort',
                        () => {
                            clearTimeout(timer);
                            reject(new DOMException('test stub aborted', 'AbortError'));
                        },
                        { once: true },
                    );
                });
            }
            if (options.failWith) throw new Error(options.failWith);
            for (const id of options.resolveIds ?? []) {
                captured.resolved[id] = await context.assets.resolve(id);
            }
            return {
                pdfBytes: options.bytes ?? pdfBytes(),
                diagnostics: options.diagnostics ?? [{ severity: 'info', code: 'STUB_OK', message: 'stub ok' }],
            };
        },
    };
    return { compiler, captured };
}

test('happy path: verified pdfBytes returned; compiler got bundle/locale/signal + prebuilt slots', async () => {
    const { compiler, captured } = makeStub();
    const input = fakeInput({ compiler });
    const ctx = makeCtx();
    const { output, diagnostics } = await compileStage(input, ctx);

    assert.ok(output.pdfBytes instanceof Uint8Array);
    assert.ok(output.pdfBytes.length > 0);
    assert.strictEqual(String.fromCharCode(...output.pdfBytes.slice(0, 5)), '%PDF-');

    // The frozen IPdfCompiler takes TypstRenderPayload: the stage re-wraps the
    // bundle and carries the prebuilt payload + resource pathMap (M1c contract).
    assert.strictEqual(captured.payload.rendererSchemaVersion, 1);
    assert.strictEqual(captured.payload.sourceSchemaVersion, 1);
    assert.strictEqual(captured.payload.bundle, input.bundle);
    assert.strictEqual(captured.payload.document, input.payload);
    assert.strictEqual(captured.payload.assetPaths, input.pathMap);
    assert.strictEqual(captured.context.bundle, input.bundle);
    assert.strictEqual(captured.context.locale, 'zh');
    assert.strictEqual(captured.context.signal, ctx.signal);
    assert.strictEqual(typeof captured.context.assets.resolve, 'function');

    // Compiler diagnostics flow through.
    assert.ok(diagnostics.some((d: any) => d.code === 'STUB_OK'));
});

test('resolver: hash-shaped virtualPath resolves via pathMap', async () => {
    const mountBytes = new Uint8Array([9, 9, 9]);
    const { compiler, captured } = makeStub({ resolveIds: ['a1'] });
    const input = fakeInput({
        compiler,
        bundle: fakeBundle([{ id: 'a1', kind: 'image', status: 'available' }]),
        pathMap: new Map([['a1', 'assets/sha256/deadbeef1234.png']]),
        mounts: [{ virtualPath: 'assets/sha256/deadbeef1234.png', bytes: mountBytes, mimeType: 'image/png' }],
    });
    const { diagnostics } = await compileStage(input, makeCtx());

    assert.deepStrictEqual(captured.resolved['a1']?.bytes, mountBytes);
    assert.strictEqual(captured.resolved['a1']?.asset.id, 'a1');
    assert.ok(!diagnostics.some((d: any) => d.code.startsWith('COMPILE_ASSET_')), 'no asset diagnostics expected');
});

test('resolver: assetId without pathMap entry returns null + diagnostic, never guesses', async () => {
    const { compiler, captured } = makeStub({ resolveIds: ['a1'] });
    // These mounts would have fooled the old best-effort matching (exact
    // virtualPath == assetId, filename-stem == assetId); the new contract
    // must not guess.
    const input = fakeInput({
        compiler,
        mounts: [
            { virtualPath: 'a1', bytes: new Uint8Array([1]), mimeType: 'image/png' },
            { virtualPath: 'assets/a1.png', bytes: new Uint8Array([2]), mimeType: 'image/png' },
        ],
    });
    const { diagnostics } = await compileStage(input, makeCtx());
    assert.strictEqual(captured.resolved['a1'], null);
    assert.ok(diagnostics.some((d: any) => d.code === 'COMPILE_ASSET_PATHMAP_MISSING'));
});

test('resolver: pathMap entry with no matching mount -> null + MOUNT_MISSING', async () => {
    const { compiler, captured } = makeStub({ resolveIds: ['a1', 'nope'] });
    const input = fakeInput({
        compiler,
        pathMap: new Map([['a1', 'assets/sha256/gone.png']]),
        mounts: [{ virtualPath: 'assets/sha256/other.png', bytes: new Uint8Array([1]), mimeType: 'image/png' }],
    });
    const { diagnostics } = await compileStage(input, makeCtx());
    assert.strictEqual(captured.resolved['a1'], null);
    assert.strictEqual(captured.resolved['nope'], null);
    const codes = diagnostics.map((d: any) => d.code);
    assert.ok(codes.includes('COMPILE_ASSET_MOUNT_MISSING'), `expected mount-missing diagnostic, got ${codes}`);
    assert.ok(codes.includes('COMPILE_ASSET_UNKNOWN_ID'), `expected unknown-id diagnostic, got ${codes}`);
});

test('resolver: duplicate mounts on one virtualPath refuse to guess', async () => {
    const { compiler, captured } = makeStub({ resolveIds: ['a1'] });
    const vp = 'assets/sha256/dup.png';
    const input = fakeInput({
        compiler,
        pathMap: new Map([['a1', vp]]),
        mounts: [
            { virtualPath: vp, bytes: new Uint8Array([1]), mimeType: 'image/png' },
            { virtualPath: vp, bytes: new Uint8Array([2]), mimeType: 'image/png' },
        ],
    });
    const { diagnostics } = await compileStage(input, makeCtx());
    assert.strictEqual(captured.resolved['a1'], null);
    assert.ok(diagnostics.some((d: any) => d.code === 'COMPILE_ASSET_MOUNT_AMBIGUOUS'));
});

test('resolver: mount with no bytes -> null + MOUNT_EMPTY', async () => {
    const { compiler, captured } = makeStub({ resolveIds: ['a1'] });
    const vp = 'assets/sha256/empty.png';
    const input = fakeInput({
        compiler,
        pathMap: new Map([['a1', vp]]),
        mounts: [{ virtualPath: vp, bytes: new Uint8Array(0), mimeType: 'image/png' }],
    });
    const { diagnostics } = await compileStage(input, makeCtx());
    assert.strictEqual(captured.resolved['a1'], null);
    assert.ok(diagnostics.some((d: any) => d.code === 'COMPILE_ASSET_MOUNT_EMPTY'));
});

test('empty pdfBytes -> StageError PDF_VERIFY_FAILED, never a blank pdf marked ok', async () => {
    const { compiler } = makeStub({ bytes: new Uint8Array(0) });
    await assert.rejects(() => compileStage(fakeInput({ compiler }), makeCtx()), (e: any) => {
        assert.ok(e instanceof StageError);
        assert.strictEqual(e.stage, 'compile');
        assert.strictEqual(e.code, 'PDF_VERIFY_FAILED');
        return true;
    });
});

test('non-PDF bytes -> StageError PDF_VERIFY_FAILED', async () => {
    const { compiler } = makeStub({ bytes: pdfBytes('this is not a pdf at all and it is long enough to exceed the minimum byte threshold') });
    await assert.rejects(() => compileStage(fakeInput({ compiler }), makeCtx()), (e: any) => {
        assert.ok(e instanceof StageError);
        assert.strictEqual(e.code, 'PDF_VERIFY_FAILED');
        return true;
    });
});

test('truncated PDF (magic but under minimum byte threshold) -> StageError PDF_VERIFY_FAILED', async () => {
    const { compiler } = makeStub({ bytes: pdfBytes('%PDF-short') });
    await assert.rejects(() => compileStage(fakeInput({ compiler }), makeCtx()), (e: any) => {
        assert.ok(e instanceof StageError);
        assert.strictEqual(e.code, 'PDF_VERIFY_FAILED');
        assert.ok(/empty or truncated/.test(e.message));
        return true;
    });
});

test('structurally complete minimal PDF passes verification', async () => {
    const { compiler } = makeStub();
    const { output } = await compileStage(fakeInput({ compiler }), makeCtx());
    assert.ok(output.pdfBytes.length > 0);
    assert.strictEqual(String.fromCharCode(...output.pdfBytes.slice(0, 5)), '%PDF-');
});

test('compiler throw -> StageError COMPILE_FAILED with cause and diagnostics preserved', async () => {
    const { compiler } = makeStub({ failWith: 'sandbox exploded' });
    const fontDiag = { severity: 'warning', code: 'TYPST_LOCAL_FONTS_DENIED', message: 'denied' };
    const input = fakeInput({ compiler, fonts: { fonts: [], diagnostics: [fontDiag], fallbackChain: [], localFontsAvailable: false } });
    await assert.rejects(() => compileStage(input, makeCtx()), (e: any) => {
        assert.ok(e instanceof StageError);
        assert.strictEqual(e.stage, 'compile');
        assert.strictEqual(e.code, 'COMPILE_FAILED');
        assert.ok(/sandbox exploded/.test(e.message));
        assert.ok(e.cause instanceof Error);
        assert.ok(e.diagnostics.some((d: any) => d.code === 'TYPST_LOCAL_FONTS_DENIED'));
        return true;
    });
});

test('abort mid-compile propagates as AbortError, never wrapped in StageError', async () => {
    const { compiler } = makeStub({ delayMs: 5000 });
    const ctx = makeCtx();
    const promise = compileStage(fakeInput({ compiler }), ctx);
    setTimeout(() => ctx.controller.abort(), 20);
    await assert.rejects(promise, (e: any) => {
        assert.strictEqual(e.name, 'AbortError');
        assert.ok(!(e instanceof StageError), 'abort must not be wrapped in StageError');
        return true;
    });
});

test('already-aborted signal fails before the compiler is called', async () => {
    let called = false;
    const { compiler } = makeStub();
    const wrapped = {
        ...compiler,
        compile: async (...args: any[]) => {
            called = true;
            return (compiler as any).compile(...args);
        },
    };
    const ctx = makeCtx();
    ctx.controller.abort();
    await assert.rejects(compileStage(fakeInput({ compiler: wrapped }), ctx), (e: any) => {
        assert.strictEqual(e.name, 'AbortError');
        return true;
    });
    assert.strictEqual(called, false);
});

test('font resolution diagnostics are forwarded; missing local fonts logged as warning', async () => {
    const { compiler } = makeStub();
    const fontDiags = [
        { severity: 'warning', code: 'TYPST_LOCAL_FONTS_DENIED', message: 'permission denied' },
        { severity: 'info', code: 'TYPST_LOCAL_FONTS_RESOLVED', message: 'resolved 0' },
    ];
    const input = fakeInput({
        compiler,
        fonts: { fonts: [], diagnostics: fontDiags, fallbackChain: ['NewCMMath (bundled, math only)'], localFontsAvailable: false },
    });
    const ctx = makeCtx();
    const { diagnostics } = await compileStage(input, ctx);
    for (const d of fontDiags) {
        assert.ok(diagnostics.some((x: any) => x.code === d.code && x.message === d.message));
    }
    assert.ok(ctx.logs.some((l) => l.level === 'warn' && /no local fonts/i.test(l.message)));
});

test('available local fonts log the fallback chain at info', async () => {
    const { compiler } = makeStub();
    const input = fakeInput({
        compiler,
        fonts: {
            fonts: [],
            diagnostics: [],
            fallbackChain: ['Noto Sans CJK SC (local)', 'NewCMMath (bundled, math only)'],
            localFontsAvailable: true,
        },
    });
    const ctx = makeCtx();
    await compileStage(input, ctx);
    assert.ok(ctx.logs.some((l) => l.level === 'info' && /Noto Sans CJK SC/.test(l.message)));
});
