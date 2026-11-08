import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { sendTabMessage, sendToGeminiTab, sendToAITab, resolveAccountTab, type AccountTab } from '../src/runtime/capabilities/tabService.js';
import { startSync } from '../src/ui/options/controllers/syncController.js';
import type { ScanResult } from '../src/application/sync/scanController.js';
import { indexStorage } from './helpers/indexStorage.js';
import { putAccount } from '../src/l3a/storageService.js';
import { mount, read } from './helpers/uiPortHarness.js';
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true> = T;
export type Contracts = [
    Assert<Equal<Awaited<ReturnType<typeof sendTabMessage>>,unknown>>,
    Assert<Equal<Awaited<ReturnType<typeof sendToGeminiTab>>,unknown>>,
    Assert<Equal<Awaited<ReturnType<typeof sendToAITab>>,unknown>>,
    Assert<Equal<Parameters<typeof sendToGeminiTab>[0],unknown>>,
    Assert<Equal<Awaited<ReturnType<typeof startSync>>,ScanResult>>,
    Assert<Equal<Awaited<ReturnType<typeof resolveAccountTab>>,AccountTab>>,
    Assert<Equal<Awaited<ReturnType<typeof resolveAccountTab>>['id'],number>>
];
function replaceGlobal(key:string,value:unknown) {
    const previous=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{configurable:true,value});
    return ()=>{if(previous)Object.defineProperty(globalThis,key,previous);else Reflect.deleteProperty(globalThis,key);};
}
test('live tab transport returns opaque replies and handles missing or failed responses', async () => {
    const reply = { arbitrary: ['not a known response'] };
    const stub = {
        runtime: { lastError: undefined as { message?: string } | undefined },
        tabs: {
            sendMessage(_tabId: number, _message: unknown, cb: (value: unknown) => void) { cb(reply); },
        },
    };
    const restore = replaceGlobal('chrome', stub);
    try {
        assert.strictEqual(await sendTabMessage(7, { action: 'ping' }, 100), reply);
        stub.tabs.sendMessage = (_tabId: number, _message: unknown, cb: (value: unknown) => void) => cb(undefined);
        await assert.rejects(sendTabMessage(7, { action: 'ping' }, 100), /no response/);
        stub.runtime.lastError = { message: 'Receiving end does not exist' };
        await assert.rejects(sendTabMessage(7, { action: 'ping' }, 100), /Receiving end does not exist/);
        stub.runtime.lastError = undefined;
        stub.tabs.sendMessage = () => { throw new Error('Port closed synchronously'); };
        await assert.rejects(sendTabMessage(7, { action: 'ping' }, 100), /Port closed synchronously/);
    } finally {
        restore();
    }
});
test('current Popup consumer rejects malformed context and legacy rich fetch envelopes before exporting',async()=>{
    const browser=await chromium.launch({chromiumSandbox: true, headless:true});try{
        for(const contextReply of [null,[],{}, {ok:'true'}, {ok:true}, {ok:true,accountContext:{accountId:123}},
            {ok:true,accountContext:{accountId:'10000000-0000-4000-8000-000000000001',providerId:'other'},conversationId:'a'},
            {success:true,data:{conversation:{detail:{messages:[]}}}}]) {
            const page=await browser.newPage();await mount(page,'popup',{contextReply});
            await page.waitForFunction(()=>document.getElementById('status')?.textContent==='Open a supported conversation first');
            assert.equal(await page.locator('#btnCurrent').isDisabled(),true);assert.deepEqual(await read(page,'exports'),[]);await page.close();
        }
    }finally{await browser.close();}
});
test('Scan consumer uses typed local results and preserves committed diagnostics without runtime callback envelopes',async()=>{
    const accountId='10000000-0000-4000-8000-000000000001';
    for(const status of ['complete','up_to_date','partial_limit','aborted','error'] as const){
        const result:ScanResult={status,pagesFetched:2,conversationsFetched:3,reason:'remaining pages unavailable'};
        const seen:unknown[]=[]; const signal=new AbortController().signal;
        const actual=await startSync(accountId,{signal,onTarget:async id=>{seen.push(id);},onProgress:p=>seen.push(p)},{
            resolveScanTarget:async()=>accountId,scanAll:async(request,options)=>{
                assert.deepEqual(request,{accountId});assert.strictEqual(options?.signal,signal);
                options?.onProgress?.({pagesFetched:2,conversationsFetched:3});return result;
            }
        });assert.strictEqual(actual,result);assert.deepEqual(seen,[accountId,{pagesFetched:2,conversationsFetched:3}]);
    }
});
test('account resolution requires a verified provider binding, never a ping-only acknowledgement',async()=>{
    const env=indexStorage();const accountId='10000000-0000-4000-8000-000000000001';
    try {
        await putAccount({id:accountId,providerId:'gemini',providerAccountId:'10000000001'});
        for(const reply of [{ok:'true'},{ok:1},[],null,{ok:true,version:'test'}, {ok:true,accountContext:{accountId,providerId:'gemini'}}]) {
            Object.defineProperty(chrome,'tabs',{configurable:true,value:{query:async()=>[{id:1,active:true,url:'https://gemini.google.com/app'}],sendMessage(_id:number,_m:unknown,cb:(v:unknown)=>void){cb(reply);}}});
            const valid = reply !== null && typeof reply === 'object' && !Array.isArray(reply) && 'accountContext' in reply;
            if (valid) assert.equal((await resolveAccountTab(accountId)).id,1);
            else await assert.rejects(resolveAccountTab(accountId), /No open Provider Tab matches this Account/);
        }
    }finally{env.restore();}
});
test('Scan UI preserves saved counts for partial limits, cancellation and errors without announcing completion',async()=>{
    const browser=await chromium.launch({chromiumSandbox: true, headless:true});try{
        for(const status of ['partial_limit','aborted','error']){
            const page=await browser.newPage();await mount(page,'options',{scanCount:3,scanResult:{status,pagesFetched:2,conversationsFetched:3,reason:'remaining pages unavailable'}});
            await page.locator('#btnSyncAll').click();await page.waitForFunction(()=>document.body.dataset.busy!=='true');
            const text=await page.locator('#scanStatus').textContent()??'';
            assert.doesNotMatch(text,/Full sync completed|全量拉取完成/);assert.match(text,/3/);
            assert.equal(await page.locator('#btnSyncAll').isEnabled(),true);await page.close();
        }
    }finally{await browser.close();}
});
