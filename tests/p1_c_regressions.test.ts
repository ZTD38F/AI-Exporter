import { bindTabAccounts } from './helpers/tabAccounts.js';
import { useIndexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { sourceDetail } from './helpers/l1SourceFixture.js';
useIndexStorage();
export {};
const test = require('node:test');
const assert = require('node:assert');

// P1-C 组「取消/超时/退避逻辑缺陷」回归测试（P1-031~035、P1-038~042）
// 运行：node -r ./tests/ts_register.js --test tests/p1_c_regressions.test.ts

const { handleHttp429, interruptibleSleep, parseRetryAfterMs } = require('../src/l1/client/gemini/api/retryPolicy.js');
const rpcClientMod = require('../src/l1/client/gemini/api/rpcClient.js');
const { GeminiAPIClient } = require('../src/l1/client/gemini/geminiClient.js');
const paginationMod = require('../src/l1/client/gemini/api/pagination.js');
// tabService.ts 以 `module.exports = TabService` 结尾覆盖了 esbuild 的具名导出，
// ts_register 的 CJS 转译下 `import { TabService }` 会拿到 undefined（生产 bundle
// 走 ESM 静态链接不受影响）。测试内给 require 缓存打补丁，仅用于测试。
const tabServiceMod: any = require('../src/runtime/capabilities/tabService.js');
if (tabServiceMod && !tabServiceMod.TabService) tabServiceMod.TabService = tabServiceMod;
const { attemptResource } = require('../src/shared/resources/resourceResult.js');
const { acquireSourceResource } = require('../src/l1/resources/sourceResources.js');
// The retired asset pipeline belongs to the unselected runtime cases below.

// P1-031: 429 退避 sleep 可中断

test('p1c - interruptibleSleep: 完整等待返回 false，被 abort 中断返回 true', async () => {
    const t0 = Date.now();
    const full = await interruptibleSleep(120);
    assert.strictEqual(full, false, 'uninterrupted sleep resolves false');
    assert.ok(Date.now() - t0 >= 100, 'full delay should elapse');

    const controller = new AbortController();
    const t1 = Date.now();
    const p = interruptibleSleep(5000, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const cut = await p;
    assert.strictEqual(cut, true, 'aborted sleep resolves true');
    assert.ok(Date.now() - t1 < 1000, `abort should cut the 5s sleep short (took ${Date.now() - t1}ms)`);
});

test('p1c - handleHttp429: 已 abort 的 signal 直接返回 aborted，不再睡满退避', async () => {
    const controller = new AbortController();
    controller.abort();
    const t0 = Date.now();
    const res = await handleHttp429({
        resp: { status: 429, headers: { get: () => null } },
        retryCount: 0,
        maxRetries: 3,
        signal: controller.signal,
        label: 'p1c-test'
    });
    assert.strictEqual(res.shouldRetry, false);
    assert.strictEqual(res.aborted, true);
    assert.ok(Date.now() - t0 < 500, `should return immediately (took ${Date.now() - t0}ms)`);
});

// P1-032 / P1-033: Retry-After 解析（整数秒钳制 30s；HTTP-date 支持）

test('p1c - parseRetryAfterMs: 整数秒钳制到 30s；HTTP-date 可解析；非法/过期返回 undefined', () => {
    // P1-032: Retry-After: 3600 不再导致 1 小时睡眠
    assert.strictEqual(parseRetryAfterMs('3600'), 30000, 'huge delta-seconds clamped to 30s');
    assert.strictEqual(parseRetryAfterMs('5'), 5000);
    assert.strictEqual(parseRetryAfterMs('0'), undefined, 'non-positive ignored');
    assert.strictEqual(parseRetryAfterMs('garbage'), undefined, 'unparseable ignored');
    assert.strictEqual(parseRetryAfterMs(null), undefined);

    // P1-033: HTTP-date 格式（RFC 7231）
    const future = new Date(Date.now() + 10000).toUTCString();
    const parsed = parseRetryAfterMs(future);
    assert.ok(typeof parsed === 'number' && parsed !== undefined, 'HTTP-date should parse');
    assert.ok(parsed! >= 9000 && parsed! <= 10000, `HTTP-date ~10s in future, got ${parsed}`);

    const farFuture = new Date(Date.now() + 3600 * 1000).toUTCString();
    assert.strictEqual(parseRetryAfterMs(farFuture), 30000, 'HTTP-date also clamped to 30s');

    const past = new Date(Date.now() - 60000).toUTCString();
    assert.strictEqual(parseRetryAfterMs(past), undefined, 'past date ignored');
});

test('p1c - handleHttp429: Retry-After 头被实际采用且不超过 30s 上限', async () => {
    const res = await handleHttp429({
        resp: { status: 429, headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '2' : null) } },
        retryCount: 0,
        maxRetries: 3,
        label: 'p1c-test'
    });
    assert.strictEqual(res.shouldRetry, true);
    assert.ok(res.delayMs !== undefined && res.delayMs >= 2000, `server hint honored, got ${res.delayMs}`);
    assert.ok(res.delayMs! <= 30000, `clamped to 30s cap, got ${res.delayMs}`);
});

// P1-039: 接收侧 retryAfterMs（header 不可读时由调用方显式传入）

test('p1c - handleHttp429: 显式 retryAfterMs 参数在无 header 时生效', async () => {
    const res = await handleHttp429({
        resp: { status: 429 }, // 无 headers（如经 chrome.tabs.sendMessage 取回的响应）
        retryCount: 0,
        maxRetries: 3,
        retryAfterMs: 4000,
        label: 'p1c-test'
    });
    assert.strictEqual(res.shouldRetry, true);
    // backoff(0) ∈ [2000,3000)，max(., 4000) 恒为 4000
    assert.strictEqual(res.delayMs, 4000, `explicit hint honored, got ${res.delayMs}`);
});

// P1-034: rpcClient 调用方 signal 与内部 timeout 合并（不再二选一）

test('p1c - mergeAbortSignals: 空/单个/多个 signal 的合并语义', () => {
    assert.strictEqual(rpcClientMod.mergeAbortSignals([null, undefined]), undefined, 'no signals -> undefined');

    const c1 = new AbortController();
    assert.strictEqual(rpcClientMod.mergeAbortSignals([c1.signal, null]), c1.signal, 'single signal passes through');

    const ca = new AbortController();
    const cb = new AbortController();
    const merged = rpcClientMod.mergeAbortSignals([ca.signal, cb.signal]);
    assert.ok(merged instanceof AbortSignal, 'two signals merge into one');
    assert.strictEqual(merged.aborted, false);
    cb.abort();
    assert.strictEqual(merged.aborted, true, 'aborting either source aborts the merged signal');
});

test('p1c - postBatchexecute: 有调用方 signal 时内部 timeout 仍生效；调用方 abort 也穿透', async () => {
    const origFetch = (global as any).fetch;
    try {
        // 永不 resolve 的 fetch，但遵循 signal（模拟真实 fetch 的 abort 行为）
        (global as any).fetch = (_url: string, _opts: any) => new Promise((_resolve, reject) => {
            const sig = _opts.signal as AbortSignal | undefined;
            assert.ok(sig instanceof AbortSignal, 'fetch must receive an AbortSignal');
            if (sig?.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
            sig?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });

        // 情形 A：调用方 signal 未 abort，内部 timeout(80ms) 必须能中断请求
        //（P1-034 修复前：signal || controller.signal 会丢弃 timeout，导致永久挂起）
        const caller = new AbortController();
        const t0 = Date.now();
        await assert.rejects(
            rpcClientMod.postBatchexecute({
                api: 'https://gemini.google.com/_/BardChatUi/data/batchexecute',
                rpcids: 'MaZiqc', fReq: '[]', cred: {},
                timeoutMs: 80, signal: caller.signal
            }),
            'internal timeout should abort the hanging request even with a caller signal present'
        );
        assert.ok(Date.now() - t0 < 5000, `timeout fired promptly (took ${Date.now() - t0}ms)`);

        // 情形 B：调用方 abort 穿透到 fetch
        const caller2 = new AbortController();
        const t1 = Date.now();
        const p = rpcClientMod.postBatchexecute({
            api: 'https://gemini.google.com/_/BardChatUi/data/batchexecute',
            rpcids: 'MaZiqc', fReq: '[]', cred: {},
            timeoutMs: 60000, signal: caller2.signal
        });
        setTimeout(() => caller2.abort(), 30);
        await assert.rejects(p, 'caller abort should propagate to fetch');
        assert.ok(Date.now() - t1 < 5000, `caller abort propagated promptly (took ${Date.now() - t1}ms)`);
    } finally {
        (global as any).fetch = origFetch;
    }
});

// P1-035: getConversationList 15s 超时 + 429 退避快速取消

test('p1c - getConversationList: 429 退避期间 abort 直接抛取消，不睡满退避', async () => {
    const origFetch = (global as any).fetch;
    const controller = new AbortController();
    try {
        (global as any).fetch = async (_url: string, _opts: any) => {
            assert.ok(_opts.signal instanceof AbortSignal, 'fetch should receive a signal');
            return {
                ok: false, status: 429, statusText: 'Too Many Requests',
                headers: { get: () => null },
                text: async () => ''
            };
        };
        const client = new GeminiAPIClient({ signal: controller.signal });
        const t0 = Date.now();
        const p = client.getConversationList(null, null, undefined, {});
        setTimeout(() => controller.abort(), 100);
        await assert.rejects(p, { name: 'AbortError' });
        assert.ok(Date.now() - t0 < 1500, `cancel took effect fast (took ${Date.now() - t0}ms, backoff was 2-3s)`);
    } finally {
        (global as any).fetch = origFetch;
    }
});

// P1-040: 分页启动前已取消则直接退出（不再被 client.aborted = false 吞掉）

test('p1c - listConversations: pre-start cancellation propagates AbortError without a request', async () => {
    const controller = new AbortController(); controller.abort();
    const provider = new GeminiProvider({ getConversationList: async () => { throw new Error('request after cancellation'); }, getConversationDetail: async () => sourceDetail() }, async () => 'u0');
    await assert.rejects(provider.listConversations({ accountId: ACCOUNT_UUID, streamId: 'recent', signal: controller.signal }), { name: 'AbortError' });
});

// Retired batchFetcher/assetPipeline scenarios now exercise the current owners.
test('p1c - HTTP 429 backoff is cancelled before a retry begins', async () => {
    const controller = new AbortController();
    const work = handleHttp429({ resp: { status: 429 }, retryCount: 0, maxRetries: 3, signal: controller.signal });
    controller.abort();
    assert.strictEqual((await work).aborted, true);
});
test('p1c - HTTP 429 honors explicit server hint across a response without readable headers', async () => {
    const result = await handleHttp429({ resp: { status: 429 }, retryCount: 0, maxRetries: 3, retryAfterMs: 1 });
    assert.strictEqual(result.shouldRetry, true);
    assert.ok(result.delayMs >= 2000 && result.delayMs <= 30000);
});

test('p1c - source download propagates cancellation before and during acquisition', async () => {
    const original = globalThis.fetch; let calls = 0;
    globalThis.fetch = async (_url: unknown, options?: RequestInit) => {
        calls++;
        return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options?.signal?.reason), { once: true }));
    };
    const asset = { id: 'image', kind: 'image', sourceUri: 'https://example.test/image' };
    try {
        const before = new AbortController(); before.abort();
        await assert.rejects(acquireSourceResource(asset, before.signal), { name: 'AbortError' });
        assert.strictEqual(calls, 0);
        const during = new AbortController(), work = acquireSourceResource(asset, during.signal);
        during.abort(); await assert.rejects(work, { name: 'AbortError' }); assert.strictEqual(calls, 1);
    } finally { globalThis.fetch = original; }
});
test('p1c - delivery failure remains a failure and never restarts acquisition', async () => {
    let acquisitions = 0;
    const result = await attemptResource('asset', async () => {
        acquisitions++;
        throw new Error('NotAllowedError: Directory permission revoked');
    });
    assert.strictEqual(result.ok, false); assert.match(result.reason, /NotAllowedError/);
    assert.strictEqual(acquisitions, 1);
});
