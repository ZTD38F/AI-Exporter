import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDetail, sourceMessage } from './helpers/l1SourceFixture.js';
import { getConversationDetail } from '../src/l1/client/gemini/api/pagination.js';
import { mount, read } from './helpers/uiPortHarness.js';
import { v2LiveSaveHost, seedLiveDetail, liveKey } from './helpers/v2LiveSaveHost.js';
import { runLiveSave } from '../src/runtime/background/liveSaveHandler.js';
import { getDetail } from '../src/l3a/storageService.js';
for(const loop of [false,true]) test('D3: Detail pagination reports '+(loop?'cursor loop':'2000-page safety truncation'),async()=>{
    let calls=0;const id=loop?'chat_loop':'chat_long';
    const result=await getConversationDetail({fetchConversationPage:async()=>sourceDetail({id,messages:[sourceMessage('m'+ ++calls)],nextPageToken:loop?'repeat':'page'+calls})},id);
    assert.equal(calls,loop?2:2000);assert.equal(result.evidence?.truncation,loop?'token_loop':'max_turns_page_limit_2000');
    assert.equal(result.conversation.detail.quality.status,'partial');assert.equal(result.conversation.detail.messages.length,calls);
});
// Failure is a transient task outcome, never a persisted failed ExportRecord.
test('D5: failed tasks show retry UI and no fabricated success badge',async()=>{
    const {chromium}=await import('@playwright/test');const browser=await chromium.launch({chromiumSandbox: true, headless:true});
    try{const page=await browser.newPage();await mount(page,'options',{failExport:true});
        await page.locator('#btnSelectAll').click();await page.locator('#btnExport').click();await page.waitForFunction(()=>document.body.dataset.busy!=='true');
        assert.equal(await page.locator('#btnRetryFailed').isVisible(),true);
        assert.deepEqual(await read(page,'records'),{});assert.doesNotMatch(await page.locator('#list').textContent()??'',/Exported|Partial export/);
    }finally{await browser.close();}
});
test('D6: colliding authored image names retain exact bytes, separate paths and immutable Domain',async t=>{
    const h=v2LiveSaveHost(t),key=liveKey('collision123');
    const assets=[{id:'one',kind:'image' as const,name:'diagram.png',sourceUri:'https://example.test/first'},
        {id:'two',kind:'image' as const,name:'diagram.jpeg',sourceUri:'https://example.test/second'}];
    const bytes=[Buffer.from('BYTES_IMAGE_1'),Buffer.from('BYTES_IMAGE_2')];
    await seedLiveDetail(key.conversationId,assets);assets.forEach((a,i)=>h.source(a.sourceUri,bytes[i]));
    const before=await getDetail(key);assert.equal((await runLiveSave(key))?.exported,1);
    const files=[...h.files].filter(([path])=>path.startsWith('assets/'));
    assert.equal(files.length,2);assert.notEqual(files[0][0],files[1][0]);
    for(const b of bytes)assert.ok(files.some(([,v])=>v instanceof Uint8Array&&Buffer.from(v).equals(b)));
    const md=[...h.files.values()].find((v):v is string=>typeof v==='string');assert.ok(md);
    files.forEach(([path])=>assert.ok(md.includes(path)));assert.deepEqual(await getDetail(key),before);
});
