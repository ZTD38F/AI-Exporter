/**
 * tests/compile-network-gate.test.ts
 * Tier 1 self-tests for the §16 P0 zero-external-request harness
 * (tests/helpers/compileNetworkGate.ts).
 *
 * 证明两件事:
 *  1. harness 真的能抓到发请求的 compiler (故意作恶的 fake -> 计数 1, 门禁断言如预期失败);
 *  2. 干净的 StubPdfCompiler 能通过 (计数 0, 门禁断言通过, 全局精确恢复)。
 *
 * 真编译器 (Phase D sandbox) 尚未落地 —— harness 先行, 接线时一行接入:
 *   const gated = await withNetworkGate(() => sandboxCompiler.compile(payload));
 *   assertZeroExternalRequests(gated, 'typst-sandbox-compile');
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const {
    withNetworkGate,
    assertZeroExternalRequests,
    NetworkGateBlockedError,
} = require('./helpers/compileNetworkGate.js');

// ------------------------------------------------------------------ fixtures

/** 干净的桩编译器: 纯计算, 不触碰任何网络 API。 */
async function StubPdfCompiler(payload: any): Promise<Uint8Array> {
    const json = JSON.stringify(payload);
    let hash = 0;
    for (let i = 0; i < json.length; i++) hash = (hash * 31 + json.charCodeAt(i)) | 0;
    return new Uint8Array([0x25, 0x50, 0x44, 0x46, hash & 0xff]); // "%PDF" + checksum
}

/** 故意作恶的 fake 编译器: 试图从 CDN 拉字体 (P0 红线场景: jsdelivr)。 */
async function PhoningHomeCompiler(payload: any): Promise<Uint8Array> {
    try {
        await fetch('https://cdn.jsdelivr.net/npm/typst-fonts@1.0.0/NotoSansCJKsc.otf');
    } catch {
        /* 编译器吞掉网络错误继续跑 —— 门禁看的是计数, 不是异常 */
    }
    return StubPdfCompiler(payload);
}

/** 最小 fake XHR (Node 默认没有 XMLHttpRequest, 自测时临时安装)。 */
class FakeXMLHttpRequest {
    open(_method: string, _url: string): void { /* no-op */ }
    send(): void { /* no-op */ }
}

// ------------------------------------------------------------------ self-tests

test('gate passes a clean StubPdfCompiler with zero violations', async () => {
    const payload = { schemaVersion: 1, messages: [] };
    const gated = await withNetworkGate(() => StubPdfCompiler(payload));
    assert.strictEqual(gated.externalRequestCount, 0);
    assert.deepStrictEqual(gated.violations, []);
    assertZeroExternalRequests(gated, 'stub-compiler'); // 不抛 = 通过
    assert.ok(gated.result instanceof Uint8Array, 'compiler result must pass through untouched');
    assert.strictEqual(gated.result[0], 0x25);
});

test('gate catches a compiler that phones home via fetch (assertion fails as expected)', async () => {
    const gated = await withNetworkGate(() => PhoningHomeCompiler({ schemaVersion: 1 }));
    assert.strictEqual(gated.externalRequestCount, 1, 'exactly one external request must be counted');
    assert.strictEqual(gated.violations.length, 1);
    assert.strictEqual(gated.violations[0].kind, 'fetch');
    assert.ok(gated.violations[0].url.includes('cdn.jsdelivr.net'), 'violation must record the URL');

    // 门禁断言如预期失败, 且失败信息包含 URL 供排查。
    assert.throws(
        () => assertZeroExternalRequests(gated, 'phoning-home-compiler'),
        (err: any) => {
            assert.ok(err.message.includes('P0 release gate FAILED'));
            assert.ok(err.message.includes('cdn.jsdelivr.net'));
            return true;
        },
        'assertZeroExternalRequests must throw on 1 external request',
    );
});

test('gate intercepts XMLHttpRequest when present', async () => {
    const g = globalThis as any;
    const origXHR = g.XMLHttpRequest;
    g.XMLHttpRequest = FakeXMLHttpRequest;
    try {
        const gated = await withNetworkGate(() => {
            const xhr = new XMLHttpRequest();
            try {
                xhr.open('GET', 'https://fonts.googleapis.com/css?family=Noto');
                xhr.send();
            } catch (e) {
                assert.ok(e instanceof NetworkGateBlockedError, 'XHR attempt must be blocked like offline');
            }
            return 'done';
        });
        assert.strictEqual(gated.result, 'done');
        assert.strictEqual(gated.externalRequestCount, 1);
        assert.strictEqual(gated.violations[0].kind, 'xhr');
        assert.ok(gated.violations[0].url.includes('fonts.googleapis.com'));
        assert.throws(() => assertZeroExternalRequests(gated, 'xhr-compiler'));
        // 门禁恢复的是我们安装的 FakeXHR, 不是门禁替身。
        assert.strictEqual(g.XMLHttpRequest, FakeXMLHttpRequest);
    } finally {
        if (typeof origXHR === 'undefined') delete g.XMLHttpRequest;
        else g.XMLHttpRequest = origXHR;
    }
});

test('data: and blob: URLs are not counted as external requests', async () => {
    const gated = await withNetworkGate(async () => {
        try {
            await fetch('data:font/woff2;base64,AAAA');
        } catch { /* swallowed */ }
        return 42;
    });
    assert.strictEqual(gated.violations.length, 1, 'attempt is still recorded for debugging');
    assert.strictEqual(gated.externalRequestCount, 0, 'data: URL must not count as external');
    assertZeroExternalRequests(gated, 'data-url-compiler');
    assert.strictEqual(gated.result, 42);
});

test('gate restores globalThis.fetch exactly after the run', async () => {
    const before = globalThis.fetch;
    await withNetworkGate(() => StubPdfCompiler({}));
    assert.strictEqual(globalThis.fetch, before, 'fetch must be restored to the original');
});

test('business exceptions from the compiler propagate untouched', async () => {
    const boom = new Error('compile failed: bad payload');
    await assert.rejects(
        withNetworkGate(() => { throw boom; }),
        (err: any) => err === boom,
        'gate must not swallow compiler errors',
    );
    assert.strictEqual(typeof globalThis.fetch, 'function', 'globals restored even on throw');
});
