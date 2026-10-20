export {};
const test = require('node:test');
const assert = require('node:assert');

// P1-C 组「取消/超时/退避逻辑缺陷」回归测试（P1-031~035、P1-038~042）
// 运行：node -r ./tests/ts_register.js --test tests/p1_c_regressions.test.ts

const { handleHttp429, interruptibleSleep, parseRetryAfterMs } = require('../src/core/api/client/retryPolicy.js');
const rpcClientMod = require('../src/core/api/client/rpcClient.js');
const { GeminiAPIClient } = require('../src/core/api/geminiClient.js');
const paginationMod = require('../src/core/api/client/pagination.js');
// tabService.ts 以 `module.exports = TabService` 结尾覆盖了 esbuild 的具名导出，
// ts_register 的 CJS 转译下 `import { TabService }` 会拿到 undefined（生产 bundle
// 走 ESM 静态链接不受影响）。测试内给 require 缓存打补丁，仅用于测试。
const tabServiceMod: any = require('../src/core/utils/tabService.js');
if (tabServiceMod && !tabServiceMod.TabService) tabServiceMod.TabService = tabServiceMod;
const batchFetcherMod = require('../src/background/batchFetcher.js');
const abortMgr = require('../src/background/abortManager.js');
const { AssetPipeline } = require('../src/core/engine/assetPipeline.js');

// ---------------------------------------------------------------------------
// P1-031: 429 退避 sleep 可中断
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// P1-032 / P1-033: Retry-After 解析（整数秒钳制 30s；HTTP-date 支持）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// P1-039: 接收侧 retryAfterMs（header 不可读时由调用方显式传入）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// P1-034: rpcClient 调用方 signal 与内部 timeout 合并（不再二选一）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// P1-035: getConversationList 15s 超时 + 429 退避快速取消
// ---------------------------------------------------------------------------

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
        await assert.rejects(p, /取消/, 'aborted 429 backoff should throw a cancellation error');
        assert.ok(Date.now() - t0 < 1500, `cancel took effect fast (took ${Date.now() - t0}ms, backoff was 2-3s)`);
    } finally {
        (global as any).fetch = origFetch;
    }
});

// ---------------------------------------------------------------------------
// P1-040: 分页启动前已取消则直接退出（不再被 client.aborted = false 吞掉）
// ---------------------------------------------------------------------------

test('p1c - getAllConversations: 启动前已取消直接退出，不调用 getConversationList', async () => {
    let listCalls = 0;
    const mockClient = {
        aborted: true, // 用户在任务实际启动前一刻点了取消
        getConversationList: async () => { listCalls++; return { conversations: [], nextPageToken: null }; }
    };
    const res = await paginationMod.getAllConversations(mockClient as any, { maxPages: 5 });
    assert.strictEqual(res.conversations.length, 0);
    assert.strictEqual(listCalls, 0, 'must not issue any list request after pre-start cancel');
    assert.ok(String(res.diagnostics.stopReason).includes('终止'), `stopReason should indicate abort, got: ${res.diagnostics.stopReason}`);
});

// ---------------------------------------------------------------------------
// P1-038 / P1-039: background batchFetcher（chrome stub）
// ---------------------------------------------------------------------------

function installChromeStub(tabResponder: (msg: any) => any) {
    (global as any).__p1c_tabResponder = tabResponder;
    (global as any).chrome = {
        runtime: {
            sendMessage: async (_msg: any) => ({}),
            lastError: undefined
        },
        tabs: {
            query: async (_q: any) => [{ id: 7, url: 'https://gemini.google.com/app', active: true }],
            sendMessage: (_tabId: number, msg: any, cb: (r: any) => void) => {
                Promise.resolve()
                    .then(() => (global as any).__p1c_tabResponder(msg))
                    .then(
                        (r) => cb(r),
                        (e) => cb({ success: false, error: String((e as any)?.message || e) })
                    );
            }
        },
        storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } }
    };
}

test('p1c - fetchBatch: 429 退避睡眠可被取消中断（不再睡满整个 backoff）', async () => {
    installChromeStub(() => ({ success: false, error: '429 Too Many Requests' }));
    let portRes: any = null;
    try {
        const t0 = Date.now();
        const p = batchFetcherMod.fetchBatch(
            [{ id: 'c_1', title: 't1' }], 'md', false,
            (r: any) => { portRes = r; }, 0, 1, 'u0'
        );
        setTimeout(() => { abortMgr.setSlotAborted('u0', true); }, 300);
        await p;
        const elapsed = Date.now() - t0;
        // 修复前：裸 sleep 2-3s（首轮）且循环继续，最长可达 ~56s；修复后 300ms 左右即退出
        assert.ok(elapsed < 1500, `cancel during 429 backoff should be fast (took ${elapsed}ms)`);
        // P1-019 统一语义：取消绝不能报 success:true（与 B组 batchFetcher 合并）
        assert.ok(portRes && portRes.success === false, 'aborted batch must not report success');
        assert.strictEqual(portRes.aborted, true, 'abort flag must be propagated');
        assert.strictEqual((portRes.results || []).length, 0, 'no bogus error entries after cancel');
    } finally {
        abortMgr.clearAllAborts();
    }
});

test('p1c - fetchBatch: 在途 tab 消息期间取消也生效（不等 25s tab 超时）', async () => {
    // tab 600ms 后才回包；200ms 时取消 → 应在 ~200ms 退出，而不是等 tab 超时
    installChromeStub(() => new Promise((res) => setTimeout(() => res({ success: true, data: {} }), 600)));
    let portRes: any = null;
    try {
        const t0 = Date.now();
        const p = batchFetcherMod.fetchBatch(
            [{ id: 'c_2', title: 't2' }], 'md', false,
            (r: any) => { portRes = r; }, 0, 1, 'u0'
        );
        setTimeout(() => { abortMgr.setSlotAborted('u0', true); }, 200);
        await p;
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 2000, `cancel during in-flight tab message should be fast (took ${elapsed}ms)`);
        // P1-019 统一语义：取消报 success:false + aborted:true
        assert.ok(portRes && portRes.success === false, 'aborted batch must not report success');
        assert.strictEqual(portRes.aborted, true, 'abort flag must be propagated');
    } finally {
        abortMgr.clearAllAborts();
    }
});

test('p1c - fetchBatch: 接收侧 retryAfterMs 生效（content 侧透传的 server hint）', async () => {
    let calls = 0;
    installChromeStub(() => {
        calls++;
        if (calls === 1) {
            // header 无法跨 sendMessage，content 侧把解析出的 hint 放在 retryAfterMs
            return { success: false, error: '429 Too Many Requests', retryAfterMs: 4000 };
        }
        return { success: true, data: { ok: 1 } };
    });
    let portRes: any = null;
    try {
        const t0 = Date.now();
        await batchFetcherMod.fetchBatch(
            [{ id: 'c_3', title: 't3' }], 'md', false,
            (r: any) => { portRes = r; }, 0, 1, 'u0'
        );
        const elapsed = Date.now() - t0;
        // 无 hint 时首轮 backoff ∈ [2000,3000)；hint=4000 被采用 → delay 恒为 4000
        assert.ok(elapsed >= 3500, `receiver retryAfterMs should be honored (took ${elapsed}ms)`);
        assert.ok(elapsed < 12000, `but still bounded (took ${elapsed}ms)`);
        assert.strictEqual(calls, 2, 'should retry once then succeed');
        assert.strictEqual((portRes.results || []).length, 1);
    } finally {
        abortMgr.clearAllAborts();
    }
});

// ---------------------------------------------------------------------------
// P1-041 / P1-042: assetPipeline 附件下载可取消 + 有界重试
// ---------------------------------------------------------------------------

test('p1c - processAsset: 瞬时失败重试后成功（默认最多 3 次重试）', async () => {
    const files: Array<[string, any]> = [];
    let calls = 0;
    const pipe = new AssetPipeline({
        useZip: true,
        writer: { writeFile: async (name: string, data: any) => { files.push([name, data]); return name; } },
        fetchAssetDelegate: async () => {
            calls++;
            if (calls < 3) return { success: false, error: 'timeout' };
            return { success: true, dataBase64: 'aGk=' };
        }
    });
    const res = await pipe.processAsset(
        { url: 'https://example.com/a.png', localName: 'a.png' },
        { id: 'c_1', title: 'chat' },
        { isImage: true }
    );
    assert.strictEqual(res.saved, true, 'should succeed after transient failures');
    assert.strictEqual(calls, 3, 'initial attempt + 2 retries');
    assert.strictEqual(files.length, 1);
    assert.strictEqual(res.failReason, '');
});

test('p1c - processAsset: abort 中断下载（调用前已取消 / 退避期间取消）', async () => {
    // 情形 A：调用前已取消 → delegate 一次也不调
    let callsA = 0;
    const cA = new AbortController();
    cA.abort();
    const pipeA = new AssetPipeline({
        useZip: true,
        writer: { writeFile: async () => 'a.png' },
        fetchAssetDelegate: async () => { callsA++; return { success: false, error: 'x' }; }
    });
    const resA = await pipeA.processAsset({ url: 'https://example.com/a.png' }, { id: 'c_1' }, { signal: cA.signal, maxRetries: 3 });
    assert.strictEqual(resA.saved, false);
    assert.strictEqual(resA.failReason, 'aborted');
    assert.strictEqual(callsA, 0, 'no download attempt after pre-abort');

    // 情形 B：退避期间取消 → 停止重试，不再打满 3 次
    let callsB = 0;
    const cB = new AbortController();
    const pipeB = new AssetPipeline({
        useZip: true,
        writer: { writeFile: async () => 'b.png' },
        fetchAssetDelegate: async () => { callsB++; return { success: false, error: 'timeout' }; }
    });
    const pB = pipeB.processAsset({ url: 'https://example.com/b.png' }, { id: 'c_2' }, { signal: cB.signal, maxRetries: 3 });
    setTimeout(() => cB.abort(), 300); // 首轮 backoff 约 1000-1500ms，300ms 时中断
    const resB = await pB;
    assert.strictEqual(resB.saved, false);
    assert.strictEqual(resB.failReason, 'aborted');
    assert.strictEqual(callsB, 1, `should stop retrying after abort (calls: ${callsB})`);
});

test('p1c - processAsset: 本地写入异常立即终止，不盲目重试网络拉取', async () => {
    let fetchCalls = 0;
    const pipe = new AssetPipeline({
        useZip: true,
        writer: {
            writeFile: async () => {
                throw new Error('NotAllowedError: Directory permission revoked');
            }
        },
        fetchAssetDelegate: async () => {
            fetchCalls++;
            return { success: true, dataBase64: 'aGk=' };
        }
    });
    const res = await pipe.processAsset(
        { url: 'https://example.com/asset.png', localName: 'asset.png' },
        { id: 'c_write_err', title: 'chat' },
        { isImage: true, maxRetries: 3 }
    );
    assert.strictEqual(res.saved, false);
    assert.ok(res.failReason.includes('NotAllowedError'));
    assert.strictEqual(fetchCalls, 1, 'must not re-fetch from network if local write fails');
});

const fs = require('node:fs');
const path = require('node:path');
function readTs(rel: string): string {
    return fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
}
test('P1-039: batchFetcher honors server retryAfterMs hint', () => {
    const src = readTs('background/batchFetcher.ts');
    assert.ok(src.includes('(res as any)?.retryAfterMs'), 'backoff must read res.retryAfterMs');
    assert.ok(src.includes('30000'), 'retryAfterMs must be clamped');
});
