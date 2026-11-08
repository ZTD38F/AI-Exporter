import { parseGeminiRequest } from '../../src/l1/parsers/gemini/rpc/request.js';
import { geminiListPages, GEMINI_LIST_CAPTURE } from '../fixtures/providers/geminiListCapture.js';
import { test, expect, seedRegistryAccounts } from './fixtures';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { resolve } from 'node:path';
import { readGeminiAuditInput, auditGeminiEvidence } from '../helpers/geminiDualParse';
import { openOptions } from './uiFixture';
import { geminiRpcPacket, GEMINI_DETAIL_CAPTURE } from '../fixtures/providers/geminiRpcCapture.js';

const root = resolve(__dirname, '../..');
const accountId = '10000000-0000-4000-8000-000000000001';
const probe = execFileSync('python3', ['-c', 'from scripts.framework.v2_probe import probe_bundle; print(probe_bundle())'], { cwd: root, maxBuffer: 12 * 1024 * 1024 }).toString();
const scanObserver = execFileSync('python3', ['-c', 'from scripts.framework.actions import SCAN_OBSERVER; print(SCAN_OBSERVER)'], { cwd: root }).toString();
const capture = execFileSync('python3', ['-c', 'from scripts.framework.gemini_dual_parse import INSTALL_CAPTURE; print(INSTALL_CAPTURE)'], { cwd: root }).toString();
const fixture = buildSync({ stdin: { resolveDir: root, loader: 'ts', contents: `
    import * as storage from './src/l3a/storageService.ts';
    import { ingestDetail } from './src/l2/ingestion.ts';
    Object.assign(globalThis,{probeFixture:{...storage,ingestDetail}});
` }, bundle: true, write: false, format: 'iife', conditions: ['worker', 'browser'] }).outputFiles[0].text;

async function workbench(context: import('@playwright/test').BrowserContext, extensionId: string) {
    await seedRegistryAccounts(context);
    // Use the same ready, tour-free Options contract as all v2 browser suites.
    // The previous fixture injected its probe before Settings/Tour initialization
    // had finished, making Export clicks silently race the overlay.
    const page = await openOptions(context, extensionId);
    await page.evaluate(probe); await page.evaluate(fixture);
    return page;
}
async function source(context: import('@playwright/test').BrowserContext) {
    const page = await context.newPage();
    await page.route('https://gemini.google.com/**', route => route.fulfill({contentType:'text/html',body:`<!doctype html><script>window.WIZ_global_data={qDCSke:'10000000001',SNlM0e:'token',cfb2h:'build'};</script><main>Fixture</main>`}));
    await page.goto('https://gemini.google.com/app/probe');
    await expect(page.locator('#geminiExportBadge')).toBeVisible();
    return page;
}

/** Runtime must have a genuine account-bound Content tab before Scan/Export. */
async function expectVerifiedSource(page: import('@playwright/test').Page) {
    await expect.poll(async () => page.evaluate(async id => {
        const tabs = await chrome.tabs.query({url:'https://gemini.google.com/*'});
        for (const tab of tabs) {
            if (tab.id === undefined) continue;
            try {
                const result = await chrome.tabs.sendMessage(tab.id, {action:'getAccountContext'});
                if (result?.ok && result.accountContext?.accountId === id) return result.accountContext.slot;
            } catch { /* Source Content may still be attaching. */ }
        }
        return null;
    }, accountId)).toMatch(/^u\d+$/);
}

test('Tier 2 v2 read probe sees actual account-scoped data; Scan reset clears local Domain and ExportRecords', async ({ context, extensionId }) => {
    const page = await workbench(context, extensionId);
    await page.evaluate(async accountId => {
        const api = Reflect.get(globalThis,'probeFixture');
        const key = {accountId,conversationId:'probe'};
        await api.ingestDetail(accountId,'probe',{savedAt:100,quality:{status:'complete'},assets:[],messages:[
            {role:'user',content:[{type:'paragraph',children:[{type:'text',text:'Question'}]}]},
            {role:'assistant',content:[{type:'paragraph',children:[{type:'text',text:'Answer'}]}]},
        ]},{title:'Probe title',titleSource:'provider',updatedAt:100});
        await api.putExportRecord(key,{exportedAt:200,chatTime:100,status:'ok',format:'markdown'});
        await api.updateCoverageAtomically(accountId,'recent',()=>({next:{range:{head:{id:'probe',time:100},tail:{id:'probe',time:100}}},result:undefined}));
    },accountId);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#list .item[data-chat-id="probe"]')).toHaveCount(1);
    const before = await page.evaluate(() => Reflect.get(globalThis,'__tier2V2').snapshot());
    await page.evaluate(() => Reflect.get(globalThis,'__tier2V2').clearScanRecords());
    const after = await page.evaluate(() => Reflect.get(globalThis,'__tier2V2').snapshot());
    expect(after.coverage).toBeNull(); expect(after.rows).toEqual([]);
    expect(Object.keys(before.records)).toEqual(['probe']); expect(after.records).toEqual({});
    const [conversation] = await page.evaluate(() => Reflect.get(globalThis,'__tier2V2').conversations(['probe']));
    expect(conversation.domain).toBeNull();
    await page.locator('#accountIdSelect').selectOption('10000000-0000-4000-8000-000000000002');
    expect((await page.evaluate(() => Reflect.get(globalThis,'__tier2V2').snapshot())).rows).toEqual([]);
});

test('Tier 2 scan observer sees real UI → Application → Recent RPC completion and persisted Coverage', async ({ context, extensionId }) => {
    const page = await workbench(context,extensionId); await source(context);
    await expectVerifiedSource(page);
    const pages = geminiListPages();
    let next = 0;
    await page.route('**/batchexecute*', async route => {
        const packet = pages[next++];
        expect(packet, 'scan must not request past the captured terminal').toBeDefined();
        expect(parseGeminiRequest(route.request().postData()).list?.requestCursor)
            .toBe(parseGeminiRequest(packet.requestBody).list?.requestCursor);
        await route.fulfill({contentType:'application/json',body:packet.responseBody});
    });
    expect(await page.evaluate(scanObserver)).toEqual({clicked:true});
    await expect.poll(() => page.evaluate(() => Reflect.get(window,'__tier2ScanEvidence').finished)).toBe(true);
    const evidence = await page.evaluate(() => Reflect.get(window,'__tier2ScanEvidence'));
    expect(evidence.error).toBeUndefined(); expect(evidence.response).toEqual({status:'complete',pagesFetched:GEMINI_LIST_CAPTURE.pageCount,conversationsFetched:GEMINI_LIST_CAPTURE.totalRows});
    const state = await page.evaluate(() => Reflect.get(globalThis,'__tier2V2').snapshot());
    expect(state.coverage.range.head.id).toBe(GEMINI_LIST_CAPTURE.first.id);
    expect(next).toBe(GEMINI_LIST_CAPTURE.pageCount);
});

test('Tier 2 raw fetch probe captures the actual export RPC without consuming its response', async ({ context, extensionId }) => {
    test.setTimeout(60000);
    // Validate the captured seven-turn response before any browser UI wait.
    const nativeEnvelope = (pages: { requestCursor: null; text: string }[]) => JSON.stringify({
        schemaVersion: 1, source: 'raw_rpc_pages', conversationId: GEMINI_DETAIL_CAPTURE.conversationId, pages,
    });
    const audit = readGeminiAuditInput(nativeEnvelope([{requestCursor:null,text:geminiRpcPacket('detail').responseBody}]), 'native_envelope');
    expect(auditGeminiEvidence(audit.evidence).sourceMessages).toHaveLength(GEMINI_DETAIL_CAPTURE.messages);

    const page = await workbench(context,extensionId);
    await source(context);
    // The v2 Provider rejects an unverified tab, even when the URL looks right.
    await expectVerifiedSource(page);

    await page.evaluate(async ({accountId, id}) => Reflect.get(globalThis,'probeFixture').putIndexes([{
        key:{accountId,conversationId:id},title:'Probe title',titleSource:'provider',updatedAt:1700000000000,
    }]),{accountId, id:GEMINI_DETAIL_CAPTURE.conversationId});
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#list .item')).toHaveCount(1);
    const detailRequests: string[] = [];
    await page.route('**/batchexecute*', route => {
        const body = new URLSearchParams(route.request().postData() ?? '').get('f.req');
        try {
            const calls = JSON.parse(body ?? '')[0] as [string, string][];
            for (const call of calls) if (call[0] === 'hNvQHb') {
                const args = JSON.parse(call[1]);
                detailRequests.push(String(args[0]));
            }
        } catch { detailRequests.push('unrecognized request'); }
        return route.fulfill({contentType:'application/json',body:geminiRpcPacket('detail').responseBody});
    });
    await page.locator('#btnSelectAll').click();
    await expect(page.locator('#btnExport')).toBeEnabled();
    await page.evaluate(capture);
    const downloadEvent = page.waitForEvent('download', {timeout:20000});
    await page.locator('#btnExport').click();
    let downloaded: Awaited<typeof downloadEvent>;
    try {
        downloaded = await downloadEvent;
    } catch (error) {
        // CI must distinguish source routing, Detail decoding, and Delivery
        // instead of reporting only an opaque 30-second download timeout.
        const diagnostics = await page.evaluate(async () => {
            const state = Reflect.get(window,'__geminiDualCapture');
            if (state) await Promise.allSettled(state.pending);
            return {
                status: document.querySelector('#status')?.textContent,
                busy: document.body.dataset.busy,
                replies: Object.keys(state?.replies ?? {}),
                captureErrors: state?.errors ?? [],
            };
        });
        throw new Error('Tier 2 v2 Markdown download failed: ' +
            JSON.stringify({detailRequests, ...diagnostics, cause:String(error)}));
    }
    expect(downloaded.suggestedFilename()).toMatch(/\.md$/);
    expect(detailRequests).toContain('c_' + GEMINI_DETAIL_CAPTURE.conversationId);
    const pages = await page.evaluate(async () => {
        const state = Reflect.get(window,'__geminiDualCapture'); await Promise.all(state.pending);
        return state.replies['0000000000000001'];
    });
    expect(pages).toEqual([{requestCursor:null,text:geminiRpcPacket('detail').responseBody}]);
    const read = readGeminiAuditInput(nativeEnvelope(pages), 'native_envelope');
    expect(auditGeminiEvidence(read.evidence).sourceMessages).toHaveLength(GEMINI_DETAIL_CAPTURE.messages);
    await expect.poll(async () => page.evaluate(async ({accountId,id}) =>
        Reflect.get(globalThis,'probeFixture').getExportRecord({accountId,conversationId:id}),{accountId,id:GEMINI_DETAIL_CAPTURE.conversationId}))
        .toMatchObject({format:'markdown',status:'ok'});
    const [stored] = await page.evaluate(() => Reflect.get(globalThis,'__tier2V2').conversations(['0000000000000001']));
    expect(stored.ok).toBe(true);
    expect(stored.domain.detail.messages).toHaveLength(GEMINI_DETAIL_CAPTURE.messages);
});

test('Tier 2 Scan observer preserves provider and local page limit reasons and rejects changed accounts', async ({ context }) => {
    const page = await context.newPage();
    for (const kind of ['idle','provider_limit','max_pages','changed','resolved','complete']) {
        await page.setContent('<body data-scanning="false"><select id="accountIdSelect"><option value="account">Account</option><option value="other">Other</option></select><button id="btnSyncAll">Scan</button><p id="scanStatus"></p></body>');
        await page.evaluate(kind => {
            document.getElementById('btnSyncAll')!.onclick = () => {
                if (kind === 'idle') return;
                document.body.dataset.scanning = 'true';
                if (kind === 'changed') {
                    document.getElementById('scanStatus')!.textContent = 'Committed 1 pages, 2 source entries';
                    queueMicrotask(() => {
                        (document.getElementById('accountIdSelect') as HTMLSelectElement).value = 'other';
                        document.getElementById('scanStatus')!.textContent = 'Reached the end of this Recent source · 1 / 2';
                        document.body.dataset.scanning = 'false';
                    });
                    return;
                }
                if (kind === 'resolved') (document.getElementById('accountIdSelect') as HTMLSelectElement).value = 'other';
                document.getElementById('scanStatus')!.textContent = 'Committed 1 pages, 2 source entries';
                queueMicrotask(() => {
                    document.getElementById('scanStatus')!.textContent = kind === 'provider_limit' ? 'Source online access limit · 1 / 2'
                        : kind === 'max_pages' ? 'Local page budget reached · 1 / 2'
                        : 'Sync complete · 1 new conversations · 1 conversations updated';
                    document.body.dataset.scanning = 'false';
                });
            };
        },kind);
        await page.evaluate(scanObserver);
        const evidence = await page.evaluate(() => Reflect.get(window,'__tier2ScanEvidence'));
        if (kind === 'idle') expect(evidence.finished).toBe(false);
        else if (kind === 'changed') expect(evidence.error).toMatch(/account changed/);
        else {
            expect(evidence.response.status).toBe(kind === 'provider_limit' || kind === 'max_pages' ? kind : 'complete');
            expect(evidence.response).toMatchObject({ pagesFetched: 1, conversationsFetched: 2 });
        }
    }
});

test('Tier 2 Takeout probe reads source-bound archive bytes and actual UI-imported v2 Domain', async ({ context, extensionId }) => {
    const page = await workbench(context,extensionId);
    const encoded = await page.evaluate(async () => {
        const Zip = Reflect.get(globalThis,'JSZip'); const zip = new Zip();
        zip.file('Takeout/Gemini/MyActivity.html', '<div class="outer-cell"><a href="https://gemini.google.com/app/c_archive_contract">Conversation</a><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted Draw<br>2026-09-02T12:00:00Z<br><p>Answer <img src="photo.png"></p></div>1 generated image</div>');
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        zip.file('Takeout/Gemini/photo.png',canvas.toDataURL('image/png').split(',')[1],{base64:true});
        return zip.generateAsync({type:'base64'});
    });
    const source = await page.evaluate(async encoded => Reflect.get(globalThis,'__tier2V2').inspectTakeout(encoded,['Takeout/Gemini/photo.png']),encoded);
    expect(source.ids.length).toBeGreaterThan(0);
    expect(Object.values(source.resources).flat().length).toBeGreaterThan(0);
    await page.locator('#takeoutFileInput').setInputFiles({name:'source-fixture.zip',mimeType:'application/zip',buffer:Buffer.from(encoded,'base64')});
    await expect(page.locator('#status')).toContainText(/Imported .*\((ok|partial)\)/);
    await expect(page.locator('body')).toHaveAttribute('data-busy','false');
    const persisted = await page.evaluate(ids => Reflect.get(globalThis,'__tier2V2').conversations(ids),source.ids);
    for (const record of persisted) {
        expect(record.ok).toBe(true); expect(record.domain.index.key.accountId).toBe(accountId);
        expect(record.domain.detail.messages.length).toBeGreaterThan(0);
    }
});


test('Tier 2 individual selection updates controlled rows and export eligibility', async ({ context, extensionId }) => {
    const page = await workbench(context, extensionId);
    await page.evaluate(async accountId => {
        for (const id of ['probe', 'other']) await Reflect.get(globalThis, 'probeFixture').ingestDetail(accountId, id, {
            savedAt: 100, quality: { status: 'complete' }, assets: [], messages: [
                { role: 'user', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Question' }] }] },
                { role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Answer' }] }] },
            ],
        }, { title: 'Selection probe', titleSource: 'provider', updatedAt: 100 });
        window.dispatchEvent(new Event('focus'));
    }, accountId);
    const row = page.locator('#list .item[data-chat-id="probe"]');
    await expect(row).toHaveCount(1);
    const select = (checked: boolean) => execFileSync('python3', ['-c', [
        'from scripts.framework.actions import CDPActions',
        'class Capture:',
        '    def eval(self, script, **kwargs):',
        '        print(script)',
        '        return True',
        `CDPActions.select_workbench_item(Capture(), "probe", ${checked ? 'True' : 'False'})`,
    ].join('\n')], { cwd: root }).toString();
    await expect(page.locator('#btnExport')).toBeDisabled();
    expect(await page.evaluate(select(true))).toBe(true);
    await expect(row).toHaveAttribute('data-selected', 'true');
    await expect(page.locator('#btnExport')).toBeEnabled();
    // Repeating the desired state must not toggle it off.
    expect(await page.evaluate(select(true))).toBe(true);
    await page.locator('#langToggle').click();
    await expect(row.locator('input')).toBeChecked();
    expect(await page.evaluate(select(false))).toBe(true);
    await expect(row).toHaveAttribute('data-selected', 'false');
    await expect(page.locator('#btnExport')).toBeDisabled();
    expect(await page.evaluate(select(false))).toBe(true);
    await page.locator('#skipExported').uncheck();
    await expect(page.locator('body')).toHaveAttribute('data-busy', 'false');
    await page.locator('#btnSelectAll').click();
    const bulk = execFileSync('python3', ['-c', [
        'from unittest.mock import patch, MagicMock',
        'from scripts.framework.cases.export import select_format_targets',
        'class Capture:',
        '    def eval(self, script, **kwargs):',
        '        print(script)',
        '        return {"matched": ["probe"]}',
        'ctx = MagicMock(chat_records=[{"chat_id": "probe"}])',
        'with patch("scripts.framework.cases.export.DESIGNATED_HISTORICAL_CHATS", []), patch("scripts.framework.actions.CDPActions.wait_for_export_idle", return_value=True), patch("scripts.framework.actions.CDPActions.configure_export_controls", return_value={"ok": True}):',
        '    select_format_targets(Capture(), ctx, "markdown")',
    ].join('\n')], { cwd: root }).toString();
    expect(await page.evaluate(bulk)).toMatchObject({ matched: ['probe'], missing: [] });
    await page.locator('#langToggle').click();
    await expect(row).toHaveAttribute('data-selected', 'true');
    await expect(page.locator('#list .item[data-chat-id="other"]')).toHaveAttribute('data-selected', 'false');
    await expect(page.locator('#btnExport')).toBeEnabled();
});

test('Tier 2 export controls leave folder delivery through the real radio handler and await persisted Settings', async ({ context, extensionId }) => {
    const page = await workbench(context, extensionId);
    await page.locator('input[name="delivery"][value="folderWriter"]').check();
    await expect(page.locator('body')).toHaveAttribute('data-busy', 'false');
    const configure = execFileSync('python3', ['-c', [
        'from scripts.framework.actions import CDPActions',
        'class Capture:',
        '    def eval(self, script, **kwargs):',
        '        if "expectedFormat" in script: print(script)',
        '        return True',
        'CDPActions.configure_export_controls(Capture(), "pdf", False, include_assets=True)',
    ].join('\n')], { cwd: root }).toString();
    expect(await page.evaluate(configure)).toMatchObject({ ok: true, format: 'pdf', skipExported: false });
    await expect(page.locator('input[name="delivery"][value="browserDownload"]')).toBeChecked();
    expect(await page.evaluate(() => Reflect.get(globalThis, '__tier2V2').getSettings()))
        .toMatchObject({ defaultFormat: 'pdf', exportDelivery: 'browserDownload', skipExported: false, includeAssets: true });
});
