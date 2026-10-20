/**
 * P0 回归测试 —— 2026-09-15 代码审查发现的 P0 缺陷（P0-3 ChatGPT provider
 * 尚未接入，暂不覆盖；P0-1 经执行验证为误报已撤回，其用例保留为通过性回归测试）。
 *
 * P0-2/4/5/6/7 这组测试是 red-by-design：在当前代码下应当 FAIL（复现缺陷），
 * 修复落地后应当全部 PASS。不要在修复前把本文件放入 tests/ 跑全量，
 * 否则 `npm run test:unit`（run_tests.py 要求每个 test 文件 returncode 为 0）会变红。
 *
 * 运行：node -r tests/ts_register.js --test tests/p0_regressions.test.ts
 *
 * @retire-when: P0-2/4/5/6/7 fixes land and this suite goes green — then fold
 *   surviving cases into the permanent suites and delete the red-by-design husks
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const StorageService = require('../src/core/storage/storageService.js');
const CredManager = require('../src/core/api/client/credentialManager.js').default;
const BatchWorker = require('../src/core/engine/export/batchWorker.js');
const ChatFormatter = require('../src/core/engine/chatFormatter.js');

function readSrc(rel: string): string {
    return fs.readFileSync(path.join(__dirname, rel), 'utf8');
}

// ---------------------------------------------------------------- P0-1（已撤回：误报）
// 2026-09-15 勘误：原报告称保存链一次失败后永久中毒，实际推演 + 本测试证实
// `.catch(reject)` 让链条每次调用后自愈。本用例保留为通过性回归测试，
// 锁定"单次失败后链条恢复"的正确行为。
test('P0-1: export-record save chain recovers after a single failed batch (no poisoning)', async () => {
    const store: Record<string, any> = {};
    let failNextSet = false;
    const prevChrome = (global as any).chrome;
    (global as any).chrome = {
        storage: {
            local: {
                get: async (keys: any) => {
                    if (keys == null) return { ...store };
                    const arr = Array.isArray(keys) ? keys : [keys];
                    const r: Record<string, any> = {};
                    for (const k of arr) if (k in store) r[k] = store[k];
                    return r;
                },
                set: async (obj: any) => {
                    if (failNextSet) {
                        failNextSet = false;
                        throw new Error('simulated-quota-failure');
                    }
                    Object.assign(store, obj);
                },
            },
        },
    };
    try {
        // 第一次保存失败（模拟配额超限）：应当 reject
        failNextSet = true;
        await assert.rejects(
            StorageService.saveExportRecord('u0', 'c_p0_1_probe_a', { probe: 1 }),
            /simulated-quota-failure/
        );

        // 存储已恢复：第二次保存必须成功。
        // （原报告误称此处会以陈旧错误 reject 即"链中毒"；实际 .catch(reject)
        //  已将链重置为 resolved，见 P0-1 勘误。）
        let secondErr: any = null;
        try {
            await StorageService.saveExportRecord('u0', 'c_p0_1_probe_b', { probe: 1 });
        } catch (e) {
            secondErr = e;
        }
        assert.strictEqual(
            secondErr, null,
            `save chain poisoned: second save rejected with stale error: ${secondErr && secondErr.message}`
        );
        const got: any = await (global as any).chrome.storage.local.get(['exportedIds']);
        // P1-045 (2026-09-15): export records are now stored under a single canonical
        // key normId(id); readers look up all historical alias forms, so the record
        // saved here as 'c_p0_1_probe_b' persists under 'p0_1_probe_b'.
        assert.ok(
            got.exportedIds && got.exportedIds['p0_1_probe_b'],
            'second export record must be persisted after storage recovered'
        );
    } finally {
        (global as any).chrome = prevChrome;
    }
});

// ---------------------------------------------------------------- P0-2
test('P0-2: resolveCred backfill must not drop other accounts from the credential map', async () => {
    const sessionStore: Record<string, any> = {};
    const prevChrome = (global as any).chrome;
    const prevDocument = (global as any).document;
    const prevHook = (globalThis as any).__gemExporterExtractAt;
    (global as any).chrome = {
        storage: {
            session: {
                get: async (keys: string[]) => {
                    const r: Record<string, any> = {};
                    for (const k of keys) if (k in sessionStore) r[k] = sessionStore[k];
                    return r;
                },
                set: async (obj: any) => { Object.assign(sessionStore, obj); },
                remove: async (keys: string[]) => { for (const k of keys) delete sessionStore[k]; },
            },
        },
    };
    // 伪造"页面能抓到 at"的信号（node 下没有真实页面）
    (global as any).document = { documentElement: { innerHTML: '' }, querySelectorAll: () => [] };
    (globalThis as any).__gemExporterExtractAt = () => 'PAGE_AT_FRESH';
    try {
        // map 里已有两个账号：首条目是缺 at 的半成品，第二条是好的
        await (global as any).chrome.storage.session.set({
            gemini_credentials_map: {
                bad: { sid: 'bad', at: '', bl: 'BL_X', accountSlot: 'u0', lastUsed: 1 },
                good: { sid: 'good', at: 'AT_GOOD', bl: 'BL_X', accountSlot: 'u1', lastUsed: 2 },
            },
        });
        await CredManager.resolveCred();
        const after: Record<string, any> = sessionStore.gemini_credentials_map || {};
        assert.deepStrictEqual(
            Object.keys(after).sort(), ['bad', 'good'],
            `credential map was overwritten during backfill, keys now: ${JSON.stringify(Object.keys(after))}`
        );
        assert.strictEqual(after.good.at, 'AT_GOOD', 'the other account credential must be preserved');
    } finally {
        (global as any).chrome = prevChrome;
        if (prevDocument === undefined) delete (global as any).document;
        else (global as any).document = prevDocument;
        if (prevHook === undefined) delete (globalThis as any).__gemExporterExtractAt;
        else (globalThis as any).__gemExporterExtractAt = prevHook;
    }
});

// ---------------------------------------------------------------- P0-4
test('P0-4: doc title-fallback regex must match a real markdown H1 heading', () => {
    const { DOC_TITLE_FALLBACK_RE } = require('../src/core/api/parser/parseDetail.js');
    assert.ok(DOC_TITLE_FALLBACK_RE instanceof RegExp, 'DOC_TITLE_FALLBACK_RE must be exported as RegExp');
    assert.strictEqual(
        DOC_TITLE_FALLBACK_RE.test('# 真实标题'), true,
        'title-fallback regex does not match a real H1 heading'
    );
    assert.strictEqual(DOC_TITLE_FALLBACK_RE.test('# Title with words'), true);
    assert.strictEqual(DOC_TITLE_FALLBACK_RE.test('No heading here'), false);
});

// ---------------------------------------------------------------- P0-5
test('P0-5: popup log() must not be a no-op (errors must surface)', () => {
    const src = readSrc('../src/ui/popup/popup.ts');
    // log 是模块内部函数，node 下无法行为测试；用源码断言守住回归。
    // 修复前: const log = (_msg: string): void => {}; —— 所有导出失败被静默吞掉。
    const isNoop = /const log\s*=\s*\([^)]*\)\s*:\s*void\s*=>\s*\{\s*\};/.test(src);
    assert.strictEqual(
        isNoop, false,
        'popup.ts defines log as a no-op: every export failure is silently swallowed'
    );
    // 修复后的 log 必须真的把信息送到用户可见的地方（popup 的 #log 面板 / console）
    assert.ok(
        /getElementById\(['"]log['"]\)/.test(src) && /console\.(log|error|warn)/.test(src),
        'popup log() should surface messages to the #log panel and the console'
    );
});

// ---------------------------------------------------------------- P0-6
test('P0-6: takeout image attach must tolerate model messages without content', async () => {
    const takeoutEngine = {
        getTakeoutMediaForChat: () => [{ isGenerated: true, filename: 'imagen_1.png' }],
    };
    const chat: any = {
        id: 'c_p0_6', title: 'T',
        messages: [{ role: 'user', content: 'hi' }, { role: 'model' }], // model 消息没有 content 字段
    };
    // 带 bug 时这里 reject: TypeError: Cannot read properties of undefined (reading 'includes')
    const res: any = await BatchWorker.resolveChat(chat, { id: 'c_p0_6' }, null, takeoutEngine, 'u0');
    const modelMsg = res.chat.messages.find((msg: any) => msg.role === 'model');
    assert.ok(modelMsg.images && modelMsg.images.length === 1, 'generated image should be attached');
    assert.ok(
        typeof modelMsg.content === 'string' && modelMsg.content.includes('imagen_1.png'),
        'image markdown should be appended to the model message'
    );
});

// ---------------------------------------------------------------- P0-7
test('P0-7: Canonical Markdown must not throw on invalid date values', async () => {
    let threw: any = null;
    let md = '';
    try {
        md = (await ChatFormatter.formatMarkdownCanonical(
            { id: 'c_p0_7', title: 'T', createdAt: 'not-a-date', messages: [] }, {}
        )).content;
    } catch (e) {
        threw = e;
    }
    // 带 bug 时: RangeError: Invalid time value（new Date('not-a-date').toISOString()）
    assert.strictEqual(threw, null, `Canonical Markdown threw on invalid date: ${threw && threw.message}`);
    assert.ok(md.includes('id: "c_p0_7"'), 'output should still contain the conversation id');
});
