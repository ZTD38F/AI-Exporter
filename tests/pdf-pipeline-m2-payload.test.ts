/**
 * tests/pdf-pipeline-m2-payload.test.ts
 * Tier 1 focused test for the Typst payload stage (M2).
 *
 * Locks the stage behavior with fake inputs:
 * - degraded math (unsupported LaTeX) keeps its raw latex in the payload
 *   AND produces a warning diagnostic — never silent;
 * - convertible math carries the Typst body with no diagnostic;
 * - the stage consumes the bundle messages in source order;
 * - asset paths are read from the resource pathMap (no re-resolution);
 * - an aborted signal throws AbortError.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { payloadStage } = require('../src/core/export/pdf/pipeline/payloadStage.js');

function para(text: string): any {
    return { type: 'paragraph', children: [{ type: 'text', text }] };
}

function mathBlock(source: string): any {
    return { type: 'math', source };
}

function message(id: string, role: string, blocks: any[]): any {
    return { id, role, blocks };
}

function bundleWith(messages: any[], assets: any[] = []): any {
    return {
        conversation: {
            key: { providerId: 'gemini', accountId: 't', conversationId: 'c1' },
            title: 'T',
            messages,
        },
        assets,
        citations: [],
    };
}

function makeCtx() {
    const controller = new AbortController();
    return {
        controller,
        signal: controller.signal,
        reportProgress: (_s: string, _c: number, _t: number) => {},
        log: (_m: string, _l?: string) => {},
    };
}

test('degraded math is diagnosed, never silent', async () => {
    const m1 = message('m1', 'user', [para('hello')]);
    const m2 = message('m2', 'assistant', [mathBlock('\\notarealcommand{x}{y}')]);
    const bundle = bundleWith([m1, m2]);
    const { output, diagnostics } = await payloadStage(
        { bundle, pathMap: new Map(), locale: 'en' },
        makeCtx(),
    );
    // diagnostic channel carries the failure
    const failed = diagnostics.filter((d: any) => d.code === 'TYPST_MATH_CONVERT_FAILED');
    assert.strictEqual(failed.length, 1, `expected one convert-failed diagnostic, got: ${JSON.stringify(diagnostics)}`);
    assert.strictEqual(failed[0].severity, 'warning');
    assert.ok(failed[0].message.length > 0);
    // and the payload keeps the raw latex (visible, not dropped)
    const mathNodes = output.payload.messages[1].blocks.filter((b: any) => b.type === 'math');
    assert.strictEqual(mathNodes.length, 1);
    assert.strictEqual(mathNodes[0].latex, '\\notarealcommand{x}{y}');
    assert.strictEqual(mathNodes[0].typst, undefined);
    assert.strictEqual(output.payload.messageCount, 2);
});

test('convertible math carries the Typst body with no diagnostic', async () => {
    const m1 = message('m1', 'user', [mathBlock('\\frac{a}{b}')]);
    const bundle = bundleWith([m1]);
    const { output, diagnostics } = await payloadStage(
        { bundle, pathMap: new Map(), locale: 'en' },
        makeCtx(),
    );
    const mathNodes = output.payload.messages[0].blocks.filter((b: any) => b.type === 'math');
    assert.strictEqual(mathNodes.length, 1);
    assert.strictEqual(mathNodes[0].typst, 'frac(a ,b )');
    assert.deepStrictEqual(diagnostics, []);
});

test('consumes bundle messages in source order', async () => {
    const m1 = message('m1', 'user', [para('q')]);
    const m2 = message('m2', 'assistant', [para('a2')]);
    const m3 = message('m3', 'assistant', [para('a3')]);
    const bundle = bundleWith([m1, m2, m3]);
    const { output } = await payloadStage(
        { bundle, pathMap: new Map(), locale: 'en' },
        makeCtx(),
    );
    assert.strictEqual(output.payload.messageCount, 3);
    assert.deepStrictEqual(output.payload.messages.map((m: any) => m.id), ['m1', 'm2', 'm3']);
});

test('asset paths come from the resource pathMap without re-resolution', async () => {
    const m1 = message('m1', 'user', [{ type: 'image', assetId: 'img1', alt: 'pic' }]);
    const bundle = bundleWith([m1], [
        { id: 'img1', kind: 'image', status: 'available', mimeType: 'image/png', name: 'x.png' },
    ]);
    const pathMap = new Map([['img1', 'assets/sha256/ab/x.png']]);
    const { output, diagnostics } = await payloadStage(
        { bundle, pathMap, locale: 'en' },
        makeCtx(),
    );
    const images = output.payload.messages[0].blocks.filter((b: any) => b.type === 'image');
    assert.strictEqual(images.length, 1);
    assert.strictEqual(images[0].asset, 'assets/sha256/ab/x.png');
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_IMAGE_MISSING'));
});

test('aborted signal throws AbortError', async () => {
    const m1 = message('m1', 'user', [para('hello')]);
    const bundle = bundleWith([m1]);
    const ctx = makeCtx();
    ctx.controller.abort();
    await assert.rejects(
        payloadStage({ bundle, pathMap: new Map(), locale: 'en' }, ctx),
        (e: any) => e instanceof DOMException && e.name === 'AbortError',
    );
});

test('MiTeX initialization failure emits single warning and preserves raw LaTeX fallback without aborting', async () => {
    const { simulateMitexInitFailureForTesting } = require('../src/core/export/typst/mathConverter.js');
    simulateMitexInitFailureForTesting(() => new Error('Simulated WebAssembly compile failure'));

    try {
        const m1 = message('m1', 'user', [para('question')]);
        const m2 = message('m2', 'assistant', [
            mathBlock('\\int_0^1 x dx'),
            mathBlock('\\frac{a}{b}'),
        ]);
        const bundle = bundleWith([m1, m2]);
        const { output, diagnostics } = await payloadStage(
            { bundle, pathMap: new Map(), locale: 'en' },
            makeCtx(),
        );

        // Stage must not abort and produces payload
        assert.ok(output.payload, 'Payload must be produced');
        assert.strictEqual(output.payload.messageCount, 2);

        // Emits exactly ONE init failure warning diagnostic (no duplicate error per formula)
        const initWarnings = diagnostics.filter((d: any) => d.code === 'TYPST_MATH_INIT_FAILED');
        assert.strictEqual(initWarnings.length, 1, `Expected exactly 1 init warning, got: ${JSON.stringify(diagnostics)}`);
        assert.strictEqual(initWarnings[0].severity, 'warning');
        assert.ok(initWarnings[0].message.includes('Simulated WebAssembly compile failure'));

        // No formula-level conversion failure errors emitted
        const convertFailures = diagnostics.filter((d: any) => d.code === 'TYPST_MATH_CONVERT_FAILED');
        assert.strictEqual(convertFailures.length, 0, 'Must not emit duplicate conversion failures per formula');

        // Both math nodes keep raw LaTeX and typst is undefined
        const mathNodes = output.payload.messages[1].blocks.filter((b: any) => b.type === 'math');
        assert.strictEqual(mathNodes.length, 2);
        assert.strictEqual(mathNodes[0].latex, '\\int_0^1 x dx');
        assert.strictEqual(mathNodes[0].typst, undefined);
        assert.strictEqual(mathNodes[1].latex, '\\frac{a}{b}');
        assert.strictEqual(mathNodes[1].typst, undefined);
    } finally {
        simulateMitexInitFailureForTesting(null);
    }
});

