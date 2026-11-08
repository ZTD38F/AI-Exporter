const { historicalFixture } = require('./helpers/nativeFixture.js');
/**
 * Historical P0 regression contracts, all expected to pass under the normal
 * unit-test gate. P0-3 is deferred until the ChatGPT provider ships.
 * P0-5 is an explicitly limited source guard for popup-local logging;
 * the other cases exercise real storage/parser/formatter behavior.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const StorageService = require('../src/l3a/storageService.js');
const CredManager = require('../src/l1/client/gemini/api/credentialManager.js').default;
import { composeFixture } from './helpers/documentFixture.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { indexStorage } from './helpers/indexStorage.js';
import type { ConsoleMessage } from '@playwright/test';

function readSrc(rel: string): string {
    return fs.readFileSync(path.join(__dirname, rel), 'utf8');
}

// 2026-09-15 勘误：原报告称保存链一次失败后永久中毒，实际推演 + 本测试证实
// `.catch(reject)` 让链条每次调用后自愈。本用例保留为通过性回归测试，
// 锁定"单次失败后链条恢复"的正确行为。
test('P0-1: export-record writes recover after one storage failure', async () => {
    const env = indexStorage();
    const key = { accountId: '10000000-0000-4000-8000-000000000001', conversationId: 'recovered' };
    const record = { exportedAt: 100, format: 'markdown', status: 'ok' };
    try {
        env.fail('exportRecords');
        await assert.rejects(StorageService.putExportRecord(key, record), /write failed/);
        env.fail();
        await StorageService.putExportRecord(key, record);
        assert.deepStrictEqual(await StorageService.getExportRecord(key), record);
    } finally { env.restore(); }
});

test('P0-2: resolveCred backfill must not drop other accounts from the credential map', async () => {
    const sessionStore: Record<string, any> = {};
    const prevChrome = (global as any).chrome;
    const prevDocument = (global as any).document;
    const prevLocation = (global as any).location;
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
    (global as any).location = { pathname: '/app' };
    (globalThis as any).__gemExporterExtractAt = () => 'PAGE_AT_FRESH';
    try {
        // map 里已有两个账号：首条目是缺 at 的半成品，第二条是好的
        await (global as any).chrome.storage.session.set({
            gemini_credentials_map: {
                bad: { sid: 'bad', at: '', bl: 'BL_X', accountSlot: 'default', lastUsed: 1 },
                good: { sid: 'good', at: 'AT_GOOD', bl: 'BL_X', accountSlot: 'u1', lastUsed: 2 },
            },
        });
        const resolved = await CredManager.resolveCred();
        const after: Record<string, any> = sessionStore.gemini_credentials_map || {};
        assert.deepStrictEqual(
            Object.keys(after).sort(), ['bad', 'good'],
            `credential map was overwritten during backfill, keys now: ${JSON.stringify(Object.keys(after))}`
        );
        assert.strictEqual(after.good.at, 'AT_GOOD', 'the other account credential must be preserved');
        assert.strictEqual(after.bad.at, 'PAGE_AT_FRESH', 'this fixture must actually exercise AT backfill');
        assert.strictEqual(resolved.at, 'PAGE_AT_FRESH', 'resolved credentials should use the new page token');
    } finally {
        (global as any).chrome = prevChrome;
        if (prevDocument === undefined) delete (global as any).document;
        else (global as any).document = prevDocument;
        if (prevLocation === undefined) delete (global as any).location;
        else (global as any).location = prevLocation;
        if (prevHook === undefined) delete (globalThis as any).__gemExporterExtractAt;
        else (globalThis as any).__gemExporterExtractAt = prevHook;
    }
});

test('P0-4: doc title-fallback regex must match a real markdown H1 heading', () => {
    const { DOC_TITLE_FALLBACK_RE } = require('../src/l1/parsers/gemini/rpc/detailDecoder.js');
    assert.ok(DOC_TITLE_FALLBACK_RE instanceof RegExp, 'DOC_TITLE_FALLBACK_RE must be exported as RegExp');
    assert.strictEqual(
        DOC_TITLE_FALLBACK_RE.test('# 真实标题'), true,
        'title-fallback regex does not match a real H1 heading'
    );
    assert.strictEqual(DOC_TITLE_FALLBACK_RE.test('# Title with words'), true);
    assert.strictEqual(DOC_TITLE_FALLBACK_RE.test('No heading here'), false);
});

test('P0-5: popup displays export errors to the user', async () => {
    const { chromium } = require('playwright');
    const { mount } = require('./helpers/uiPortHarness.js');
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true });
    try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('console', (message: ConsoleMessage) => { if (message.type() === 'error') errors.push(message.text()); });
        await mount(page, 'popup', { throwExport: true });
        await page.locator('#btnCurrent').click();
        await page.waitForFunction(() => document.body.textContent?.includes('Operation failed. Please retry'));
        assert.ok(errors.some(message => message.includes('Injected export failure')));
    } finally { await browser.close(); }
});

// Runtime export no longer supplements images using detached Takeout evidence.
// Native Takeout/RPC ownership tests cover source-derived generated assets.

test('P0-7: Canonical Markdown must not throw on invalid date values', async () => {
    let threw: any = null;
    let md = '';
    try {
        const parsed = historicalFixture({ id: 'c_p0_7', title: 'T', createdAt: 'not-a-date', messages: [] });
        const { document, resources } = await composeFixture(parsed.conversation);
        md = renderDocumentMarkdown(document, resources);
    } catch (e) {
        threw = e;
    }
    // 带 bug 时: RangeError: Invalid time value（new Date('not-a-date').toISOString()）
    assert.strictEqual(threw, null, `Canonical Markdown threw on invalid date: ${threw && threw.message}`);
    assert.ok(md.includes('id: "p0_7"'), 'output should still contain the conversation id');
});
