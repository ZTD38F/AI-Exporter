import { test, expect, seedRegistryAccounts } from './fixtures';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Download } from '@playwright/test';
import { openOptions, seedConversations, openPopup, storedSettings } from './uiFixture';
test.beforeEach(async({context,extensionId})=>{void extensionId;await seedRegistryAccounts(context);});
test('Popup renders current bilingual labels and five format controls with durable v2 Settings',async({context,extensionId})=>{
    const options=await openOptions(context,extensionId);await seedConversations(options,[{id:'a',title:'Current title'}]);const page=await openPopup(context,extensionId);
    await expect(page.locator('#currentChatTitle')).toHaveText('Current title');await expect(page.locator('[data-format]')).toHaveCount(5);
    await expect(page.locator('#btnCurrent')).toHaveText('📥 Export Current Conversation');await expect(page.locator('#btnOptions')).toBeVisible();
    await options.locator('#langToggle').uncheck();await expect(page.locator('#btnCurrent')).toHaveText('📥 导出当前对话');
    await options.locator('#langToggle').check();await expect(page.locator('#btnCurrent')).toHaveText('📥 Export Current Conversation');
    await page.locator('[data-format="json"]').click();await expect(page.locator('[data-format="json"]')).toHaveAttribute('aria-pressed','true');await expect.poll(async()=> (await storedSettings(page)).defaultFormat).toBe('json');
    for(const enabled of [true,false]) {await options.locator('#devToggle').setChecked(enabled);await expect(page.locator('[data-format]')).toHaveCount(5);await expect(page.locator('[data-format="json_raw"],[data-format="json_openai"]')).toHaveCount(0);}
    await expect(page.locator('#chatSlotBadge,#historyTotalSynced,#btnCopyMarkdown,#btnScreenshot,#previewModal')).toHaveCount(0);
});
test('Popup and Options synchronize format in both directions and consume the same language setting',async({context,extensionId})=>{
    const options=await openOptions(context,extensionId);const popup=await openPopup(context,extensionId);
    await popup.locator('[data-format="json"]').click();await expect(options.locator('#format')).toHaveValue('json');
    await options.locator('#format').selectOption('html');await expect(popup.locator('[data-format="html"]')).toHaveAttribute('aria-pressed','true');
    await options.locator('#langToggle').uncheck();await expect(popup.locator('#btnCurrent')).toHaveText('📥 导出当前对话');
    await popup.reload();await expect(popup.locator('[data-format="html"]')).toHaveAttribute('aria-pressed','true');await expect(popup.locator('#btnCurrent')).toHaveText('📥 导出当前对话');
});
test('Popup DOCX export downloads a Word archive locally', async ({ context, extensionId }) => {
    const options = await openOptions(context, extensionId);
    await seedConversations(options, [{ id: 'a', body: 'A Word export in Chromium' }]);
    const popup = await openPopup(context, extensionId);
    await popup.locator('[data-format="docx"]').click();
    const pending = popup.waitForEvent('download');
    await popup.locator('#btnCurrent').click();
    const file = await pending;
    expect(file.suggestedFilename()).toMatch(/\.docx$/);
    const bytes = await readFile((await file.path())!);
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await expect(popup.locator('#status')).toHaveText('Download initiated');
});

test('Popup rejects malformed current context without download and allows retry after a transport failure',async({context,extensionId})=>{
    const options=await openOptions(context,extensionId);await seedConversations(options,[{id:'a'}]);const popup=await openPopup(context,extensionId);await expect(popup.locator('#btnCurrent')).toBeEnabled();
    await popup.evaluate(()=>{Object.defineProperty(chrome.tabs,'sendMessage',{configurable:true,value:()=>{throw new Error('Injected context failure');}});});
    let downloads=0;popup.on('download',()=>{downloads++;});await popup.locator('#btnCurrent').click();await expect(popup.locator('#status')).toHaveText('Operation failed. Please retry; details are available in the logs or diagnostic report.');await expect(popup.locator('#btnCurrent')).toBeEnabled();expect(downloads).toBe(0);
    await popup.reload();const pending=popup.waitForEvent('download');await popup.locator('#btnCurrent').click();const file=await pending;expect(await readFile((await file.path())!,'utf8')).toContain('Answer a');
    await popup.evaluate(()=>{Object.defineProperty(chrome.tabs,'sendMessage',{configurable:true,value:(_id:number,_m:unknown,cb:(v:unknown)=>void)=>cb({ok:'true'})});});
    await popup.locator('#btnCurrent').click();await expect(popup.locator('#status')).toHaveText('No trusted current conversation');await expect(popup.locator('#btnCurrent')).toBeDisabled();expect(downloads).toBe(1);
});
for(const format of ['html','markdown','json'] as const)test(`Popup ${format} physical export delivers one package with its corrected body and failure report`,async({context,extensionId})=>{
    const options=await openOptions(context,extensionId);await seedConversations(options,[{id:'a',body:'Body survives',missingAsset:true}]);
    await options.evaluate(async()=>Reflect.get(globalThis,'uiFixture').updateSettings({includeAssets:true}));
    const popup=await openPopup(context,extensionId);await popup.locator(`[data-format="${format}"]`).click();
    const downloads: Download[]=[];popup.on('download',file=>downloads.push(file));await popup.locator('#btnCurrent').click();
    await expect.poll(()=>downloads.length).toBe(1);await expect(popup.locator('#btnCurrent')).toBeEnabled();
    const file=downloads[0];
    const JSZip=require(path.resolve(__dirname,'../../lib/jszip.min.js'));const zip=await JSZip.loadAsync(await readFile((await file.path())!));
    const documentPath=Object.keys(zip.files).find(name=>name.endsWith(format==='markdown'?'.md':'.'+format));expect(documentPath).toBeTruthy();
    const corrected=await zip.file(documentPath).async('string');expect(corrected).toContain('Body survives');
    const report=Object.keys(zip.files).find(name=>name.endsWith('/report.json'));expect(report).toBeTruthy();expect(JSON.parse(await zip.file(report).async('string')).failures).toHaveLength(1);
    if(format==='json'){
        const archive=JSON.parse(corrected);expect(archive.transport).toBeUndefined();expect(archive.resources).toEqual({});expect(archive.version).toBe(1);expect(archive.conversation.detail.assets[0].id).toBe('image');
    }else{expect(corrected).toMatch(/unavailable|gem-missing-asset|Attachment failed: Unknown error/);}
    await expect(popup.locator('#btnCurrent')).toBeEnabled();
    await expect(popup.locator('#status')).toContainText('Successfully downloaded: 1');
    await expect(popup.locator('#status')).not.toContainText('Attachment');
    await options.locator('#devToggle').check();
    await expect(popup.locator('#status')).toContainText('Attachment failures with unknown cause: 1');
    await expect(popup.locator('#status')).not.toContainText('Conversation export failed:');
    await options.locator('#devToggle').uncheck();
    await expect(popup.locator('#status')).not.toContainText('Attachment');
});
