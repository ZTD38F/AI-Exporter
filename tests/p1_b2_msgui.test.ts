import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { accountRuntime, ACCOUNT_UUID, ACCOUNT_OBSERVATION } from './helpers/accountRuntime.js';
import { resolveCurrentAccount } from '../src/runtime/content/accountContext.js';
import { init } from '../src/runtime/content/messageRouter.js';
import { runCleanups } from '../src/runtime/content/cleanupRegistry.js';
import { AssetFetcher } from '../src/runtime/capabilities/assetFetcher.js';
import { liveCoordinatorHost } from './helpers/liveCoordinatorHost.js';
import { executeLiveSave } from '../src/runtime/content/liveSaveCoordinator.js';
import { mount, read } from './helpers/uiPortHarness.js';
const source = (p: string) => fs.readFileSync(path.join(process.cwd(), 'src', p), 'utf8');
async function router(t: import('node:test').TestContext) {
    const runtime = accountRuntime();
    await resolveCurrentAccount(ACCOUNT_OBSERVATION, 'u0');
    type Listener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];
    const listeners = new Set<Listener>();
    Object.assign(chrome.runtime, { id: 'own', onMessage: {
        addListener: (fn: Listener) => listeners.add(fn), removeListener: (fn: Listener) => listeners.delete(fn),
    } });
    init(); t.after(() => { runCleanups(); runtime.restore(); });
    return { listeners, request: () => new Promise<Record<string, unknown>>(resolve => {
        [...listeners][0]({ action: 'getFileBlob', accountId: ACCOUNT_UUID, url: 'https://lh3.googleusercontent.com/a' },
            { id: 'own' } as chrome.runtime.MessageSender, value => resolve(value as Record<string, unknown>));
    }) };
}
test('P1-020: missing resource replies terminate with failure; valid reply survives', async t => {
    const host = await router(t);
    for (const payload of [undefined, { success: true, dataBase64: 'AQID', size: 3 }]) {
        t.mock.method(AssetFetcher, 'handleGetFileBlob', async (_message: unknown, reply: (v: unknown) => void) => {
            if (payload !== undefined) reply(payload);
        });
        const result = await host.request();
        assert.equal(result.success, payload && payload.success || false);
        if (!payload) assert.match(String(result.error), /no result|Invalid resource/);
        t.mock.restoreAll();
    }
});
test('P1-021: a thrown export releases UI state and permits the next attempt', async () => {
    const { chromium } = await import('@playwright/test'); const browser = await chromium.launch({chromiumSandbox: true, headless:true});
    try {
        const page = await browser.newPage(); await mount(page, 'options', {throwExport:true});
        await page.locator('#btnSelectAll').click(); await page.locator('#btnExport').click();
        await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Operation failed. Please retry; details are available in the logs or diagnostic report.');
        assert.equal(await page.locator('#btnExport').isEnabled(), true);
        await page.evaluate(() => { Reflect.get(window, 'harness').throwExport = false; });
        await page.locator('#btnExport').click(); await page.waitForFunction(() => document.body.dataset.busy !== 'true');
        assert.equal((await read(page, 'exports')).length, 2);
    } finally { await browser.close(); }
});
// v2 has no navigation-triggered active fetch/LRU. A newly admitted Detail can
// request another export immediately; the coordinator does not debounce facts.
test('P1-024: consecutive committed Detail changes are not dropped by a timing cache', async t => {
    const h = await liveCoordinatorHost(t);
    await executeLiveSave(h.key); await executeLiveSave(h.key);
    assert.equal(h.sent.length, 2);
});
test('P1-025: runtime listener cleanup permits clean reinitialization', async t => {
    const h = await router(t); assert.equal(h.listeners.size, 1);
    runCleanups(); assert.equal(h.listeners.size, 0);
    init(); assert.equal(h.listeners.size, 1);
    runCleanups(); assert.equal(h.listeners.size, 0);
});
test('P1-028: sniffed response reader remains capped (static)', () => {
    const src = source('l1/sniffer/gemini/hookCredentials.ts');
    assert.ok(src.includes('readCappedText')); assert.ok(src.includes('selected.captureLimit'));
});
test('P1-030: resource IPC rejects oversized replies before delivering bytes', async t => {
    const h = await router(t);
    t.mock.method(AssetFetcher, 'handleGetFileBlob', async (_message: unknown, reply: (v: unknown) => void) => {
        reply({success:true,size:51*1024*1024,dataBase64:'AQID'});
    });
    const result = await h.request(); assert.equal(result.success, false);
    assert.match(String(result.error), /IPC size limit/); assert.equal('dataBase64' in result, false);
});

test('P1-018: repeated acquisition callbacks produce exactly one terminal response', async t => {
    const h = await router(t); let calls = 0;
    t.mock.method(AssetFetcher, 'handleGetFileBlob', async (_m: unknown, reply: (v: unknown) => void) => {
        reply({success:true,size:1,dataBase64:'AQ=='}); reply({success:true,size:1,dataBase64:'Ag=='});
    });
    const done = new Promise<void>(resolve => [...h.listeners][0](
        {action:'getFileBlob',accountId:ACCOUNT_UUID,url:'https://lh3.googleusercontent.com/a'},
        {id:'own'} as chrome.runtime.MessageSender, () => {calls++;resolve();}));
    await done; await Promise.resolve(); assert.equal(calls, 1);
});
