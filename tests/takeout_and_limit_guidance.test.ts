import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { importTakeout } from '../src/l1/imports/takeout/importTakeout.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { getDetail, listIndexes } from '../src/l3a/storageService.js';
import { sourceList, sourceDetail, takeoutArchive, activityHtml } from './helpers/l1SourceFixture.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { parseList } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { mount, read } from './helpers/uiPortHarness.js';

test('Takeout generic filenames cannot transfer bytes to another conversation',async()=>{
    const env=indexStorage(),resources=createSourceResourceContext();
    const html=activityHtml('<p>Response B</p><img src="image_01.png"/>','chat_B_123456')+activityHtml('<p>No image</p>','chat_A_123456');
    const bytes=Uint8Array.of(137,80,78,71,13,10,26,10);
    try{
        await importTakeout(takeoutArchive(html,{'Takeout/Gemini/image_01.png':{async:async()=>bytes,_data:{uncompressedSize:bytes.length}}}),ACCOUNT_UUID,undefined,resources);
        const key={accountId:ACCOUNT_UUID,conversationId:'chat_B_123456'},detail=await getDetail(key);assert.ok(detail);assert.equal(detail.assets.length,1);
        assert.deepEqual((await resources.acquire(key,detail.assets[0])).bytes,bytes);
        const other={...key,conversationId:'chat_A_123456'};assert.equal((await getDetail(other))?.assets.length,0);
        await assert.rejects(resources.acquire(other,detail.assets[0]),/No supported source locator/);
        await assert.rejects(resources.acquire(other,{id:'',kind:'image',sourceUri:'image.png'}),/No supported source locator/);
    }finally{resources.release();env.restore();}
});
test('releasing task resources drops readers while leaving admitted Domain intact',async()=>{
    const env=indexStorage(),resources=createSourceResourceContext();let reads=0;
    try{
        const id='chat_slot_123';await importTakeout(takeoutArchive(activityHtml('<img src="image.png"/>',id),{'Takeout/Gemini/image.png':{async:async()=>{reads++;return Uint8Array.of(1,2,3);},_data:{uncompressedSize:3}}}),ACCOUNT_UUID,undefined,resources);
        const key={accountId:ACCOUNT_UUID,conversationId:id},detail=await getDetail(key);assert.ok(detail);assert.equal(detail.assets.length,1);
        await resources.acquire(key,detail.assets[0]);const before=reads;resources.release();
        await assert.rejects(resources.acquire(key,detail.assets[0]),/released/);assert.equal(reads,before);assert.deepEqual(await getDetail(key),detail);
    }finally{resources.release();env.restore();}
});
test('550 source rows ending naturally never imply a provider limit',async()=>{
    const env=indexStorage();let page=0;
    try{const provider=new GeminiProvider({getConversationList:async()=>{page++;return sourceList(`G_SOURCE_550_PAGE_${page}`);},getConversationDetail:async()=>sourceDetail()},async()=> 'u0');
        assert.equal(await provider.listConversations({accountId:ACCOUNT_UUID,streamId:'recent'}),'source_end');assert.equal((await listIndexes(ACCOUNT_UUID)).length,550);
    }finally{env.restore();}
});
test('only request-bound structured 1096 is a provider limit; ambiguous thrown text is an error',async()=>{
    const env=indexStorage();let page=0;
    const terminal=parseList(geminiListGen('G_TAKEOUT_LIMIT_01'));
    try{assert.equal(terminal.failure,'hit_google_limit');
        const provider=new GeminiProvider({getConversationList:async()=>++page<3?sourceList(`G_SOURCE_LIMIT_BOUND_PAGE_${page}`):terminal,getConversationDetail:async()=>sourceDetail()},async()=> 'u0');
        assert.equal(await provider.listConversations({accountId:ACCOUNT_UUID,streamId:'recent'}),'provider_limit');assert.equal((await listIndexes(ACCOUNT_UUID)).length,2);
        const ambiguous=new GeminiProvider({getConversationList:async()=>{throw Error('1096 BardErrorInfo');},getConversationDetail:async()=>sourceDetail()},async()=> 'u0');
        await assert.rejects(ambiguous.listConversations({accountId:ACCOUNT_UUID,streamId:'recent'}),/1096/);
    }finally{env.restore();}
});
test('scan UI reports source end, provider limit and local budget as distinct reasons',async()=>{
    const {chromium}=await import('@playwright/test');const browser=await chromium.launch({chromiumSandbox: true, headless:true});
    try{for(const [reason,label] of [['complete','Sync complete'],['provider_limit','Source online access limit'],['max_pages','Local page budget reached']]){
        const page=await browser.newPage();await mount(page,'options',{scanResult:{status:reason==='complete'?'complete':'partial_limit',reason,pagesFetched:11,conversationsFetched:550},settings:{takeoutPromptCompleted:true}});
        await page.locator('#btnSyncAll').click();await page.waitForFunction(()=>document.body.dataset.busy!=='true');
        const text=await page.locator('#scanStatus').textContent();assert.ok(text?.includes(label));if(reason==='complete')assert.doesNotMatch(text??'',/11 \/ 550/);else assert.ok(text?.includes('550'));await page.close();
    }}finally{await browser.close();}
});
test('Options blocks a concurrent import and releases its busy state after completion',async()=>{
    const {chromium}=await import('@playwright/test');const browser=await chromium.launch({chromiumSandbox: true, headless:true});
    try{const page=await browser.newPage();await mount(page,'options',{holdImport:true});
        const file={name:'test.zip',mimeType:'application/zip',buffer:Buffer.from('fixture')};
        await page.locator('#takeoutFileInput').setInputFiles(file);await page.waitForFunction(()=>typeof Reflect.get(window,'harness').finishImport==='function');
        assert.equal(await page.locator('#btnImportTakeout').isDisabled(),true);
        await page.locator('#takeoutFileInput').setInputFiles(file);assert.equal((await read(page,'imports')).length,1);
        await page.evaluate(()=>Reflect.get(window,'harness').finishImport());await page.waitForFunction(()=>document.body.dataset.busy!=='true');
        assert.equal(await page.locator('#btnImportTakeout').isEnabled(),true);
    }finally{await browser.close();}
});
