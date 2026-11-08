import { waitForAuthorization, continueToScan } from './helpers/tourNavigation';
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { resolveAccountTab, sendTabMessage } from '../src/runtime/capabilities/tabService.js';
import { v2ExportHost, exportRequest, exportKey, seedExportConversation } from './helpers/v2ExportHost.js';
import { runExport } from '../src/application/export/runExport.js';
import { getExportRecord, putExportRecord, putAccount } from '../src/l3a/storageService.js';
import { patchStoredSettings, getStoredSettings, SETTINGS_KEY } from '../src/l3a/settingsStore.js';
import { mount } from './helpers/uiPortHarness.js';
// v2 has no BatchWorker, slot abort epoch or persistent session. The owning
// runtime transport and independent unified Export tasks retain these guarantees.
for (const reply of [{}, {randomField:123,status:'unknown'}]) test('P1-3: malformed Tab envelope settles and cannot select an execution target '+JSON.stringify(reply), async t => {
    const env=indexStorage();t.after(()=>env.restore());
    await putAccount({id:ACCOUNT_UUID,providerId:'gemini',providerAccountId:'10000000001'});
    Object.assign(chrome,{tabs:{query:async()=>[{id:1}],sendMessage:(_id:unknown,_msg:unknown,cb:(v:unknown)=>void)=>cb(reply)}});
    await assert.rejects(resolveAccountTab(ACCOUNT_UUID),/No open Provider Tab/);
});
test('P1-3: synchronous transport throw rejects promptly',async t=>{
    const env=indexStorage();t.after(()=>env.restore());
    Object.assign(chrome,{tabs:{sendMessage:()=>{throw Error('Extension context invalidated synchronously');}}});
    await assert.rejects(sendTabMessage(1,{},50),/invalidated synchronously/);
});
test('P1-4: cancelling one export does not poison an independent retry',async t=>{
    const h=v2ExportHost(t);await seedExportConversation('retry');const old=new AbortController();old.abort();
    const cancelled=await runExport(exportRequest(['retry']),{signal:old.signal});
    assert.equal(cancelled.aborted,true);assert.equal(await getExportRecord(exportKey('retry')),null);
    assert.equal((await runExport(exportRequest(['retry']))).exported,1);assert.equal(h.clicks(),1);assert.equal(old.signal.aborted,true);
});
test('P1-4: starting another task cannot revive an aborted batch or deliver remaining keys',async t=>{
    const h=v2ExportHost(t);for(const id of ['first','second','fresh'])await seedExportConversation(id);
    const old=new AbortController();let fresh:Promise<unknown>|undefined;
    const result=await runExport(exportRequest(['first','second']),{signal:old.signal,onProgress:()=>{old.abort();fresh??=runExport(exportRequest(['fresh']));}});
    await fresh;assert.equal(result.aborted,true);assert.equal(result.exported,0);assert.equal(h.clicks(),1);
    assert.equal(await getExportRecord(exportKey('second')),null);assert.equal((await getExportRecord(exportKey('fresh')))?.status,'ok');
});
test('P1-7: current persistent settings and record failures propagate without overwriting prior facts',async()=>{
    const env=indexStorage();const key=exportKey('failed');
    try{
        const record={exportedAt:100,format:'markdown' as const,status:'ok' as const};await putExportRecord(key,record);
        env.fail(SETTINGS_KEY);await assert.rejects(patchStoredSettings({language:'en'}),/write failed/);assert.deepEqual(await getStoredSettings(),{});
        env.fail('exportRecords');await assert.rejects(putExportRecord(key,{...record,exportedAt:200}),/write failed/);
        assert.deepEqual(await getExportRecord(key),record);
    }finally{env.restore();}
});
test('D7: existing website authorization permits the tour even when Tabs or login checks are unavailable',async()=>{
    const {chromium}=await import('@playwright/test');const browser=await chromium.launch({chromiumSandbox: true, headless:true});
    try{for(const state of ['error','missing','connected']){
        const page=await browser.newPage();await mount(page,'options');await page.locator('#list .item').waitFor();
        await page.evaluate(state=>{
            const tabs=Reflect.get(window,'chrome').tabs;
            if(state==='error')tabs.query=async()=>{throw Error('Tabs communication failed');};
            if(state==='missing')Reflect.deleteProperty(Reflect.get(window,'chrome'),'tabs');
            return Reflect.get(window,'testUi').tour.startTour();
        },state);
        await waitForAuthorization(page);
        await page.waitForFunction(()=>document.querySelector('#tourNextBtn')?.matches(':enabled'));
        assert.equal(await page.locator('.platform-permission-row[data-platform="gemini"]').isVisible(),false);
        await continueToScan(page);
        assert.equal(await page.locator('.tour-popover h2').textContent(),'Scan conversations');
        await page.close();
    }}finally{await browser.close();}
});
