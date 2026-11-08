import { test, expect, seedRegistryAccounts } from './fixtures';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { accountId, openOptions, seedConversations, storedSettings } from './uiFixture';
test.beforeEach(async({context,extensionId})=>{void extensionId;await seedRegistryAccounts(context);});
test('batch export delivers both physical bodies and refreshes recent ExportRecords',async({context,extensionId})=>{
    const page=await openOptions(context,extensionId);await seedConversations(page,[{id:'one'},{id:'two'}]);await page.locator('#btnSelectAll').click();
    const pending=page.waitForEvent('download');await page.locator('#btnExport').click();const file=await pending;expect(file.suggestedFilename()).toMatch(/\.zip$/);
    const JSZip=require(path.resolve(__dirname,'../../lib/jszip.min.js'));const zip=await JSZip.loadAsync(await readFile((await file.path())!));const files=Object.keys(zip.files).filter(x=>x.endsWith('.md'));expect(files).toHaveLength(2);
    const bodies=await Promise.all(files.map(x=>zip.file(x).async('string')));expect(bodies.join('\n')).toContain('Answer one');expect(bodies.join('\n')).toContain('Answer two');
    await expect(page.locator('#status')).toContainText('Successfully downloaded: 2');await expect(page.locator('#list small')).toHaveText([/Last export/,/Last export/]);
    const records=await page.evaluate(id=>Reflect.get(globalThis,'uiFixture').listExportRecords(id),accountId);expect(Object.keys(records).sort()).toEqual(['one','two']);expect(records.one.status).toBe('ok');
});
test('unchanged exports skip through Application without producing an empty ZIP',async({context,extensionId})=>{
    const page=await openOptions(context,extensionId);await seedConversations(page,[{id:'unchanged'}],{unchanged:{exportedAt:200,chatTime:100,format:'markdown',status:'ok'}});
    await page.locator('#btnSelectAll').click();let downloads=0;page.on('download',()=>{downloads++;});await page.locator('#btnExport').click();await expect(page.locator('#status')).toContainText('Skipped: 1');await expect(page.locator('body')).toHaveAttribute('data-busy','false');expect(downloads).toBe(0);
});
test('clearing export records preserves bodies and skip preference, then explicit selection can export again',async({context,extensionId})=>{
    const page=await openOptions(context,extensionId);await seedConversations(page,[{id:'one'}],{one:{exportedAt:200,chatTime:100,format:'markdown',status:'ok'}});
    await expect(page.locator('#btnClearExported')).toBeHidden();
    await page.locator('#devToggle').check();
    await page.locator('#btnMoreActions').click();
    await expect(page.locator('#btnClearExported')).toBeVisible();
    const before=await storedSettings(page);await page.locator('#btnClearExported').click();await page.locator('#btnCleanupConfirm').click();await expect(page.locator('#status')).toHaveText('Records cleared');
    expect(await page.evaluate(id=>Reflect.get(globalThis,'uiFixture').listExportRecords(id),accountId)).toEqual({});expect((await storedSettings(page)).skipExported).toBe(before.skipExported);
    expect(await page.evaluate(id=>Reflect.get(globalThis,'uiFixture').readConversation({accountId:id,conversationId:'one'}),accountId)).toBeTruthy();
    await page.locator('#btnSelectAll').click();const pending=page.waitForEvent('download');await page.locator('#btnExport').click();expect(await readFile((await(await pending).path())!,'utf8')).toContain('Answer one');
});

test('large unchanged exports do not rebuild the conversation list for each skipped item', async ({context,extensionId}) => {
    test.setTimeout(120000);
    const page = await openOptions(context,extensionId);
    const rows = Array.from({length:1343},(_,i)=>({id:`skip-${i}`}));
    await seedConversations(page,rows,Object.fromEntries(rows.map(row=>[row.id,
        {exportedAt:200,chatTime:100,format:'markdown' as const,status:'ok' as const}])));
    await page.locator('#btnSelectAll').click();
    await page.evaluate(() => {
        const metrics = {listRebuilds:0,storageOpens:0};
        Reflect.set(window,'skipMetrics',metrics);
        const list = document.getElementById('list');
        const replace = Element.prototype.replaceChildren;
        Element.prototype.replaceChildren = function(...nodes) {
            if(this === list) metrics.listRebuilds++;
            return replace.apply(this,nodes);
        };
        const open = indexedDB.open;
        indexedDB.open = function(...args) {
            metrics.storageOpens++;
            return open.apply(this,args);
        };
    });
    let downloads = 0;
    page.on('download',()=>{downloads++;});
    await page.locator('#btnExport').click();
    await expect(page.locator('#directWriteModal')).toBeVisible();
    const started = Date.now();
    await page.locator('#btnModalContinueZip').click();
    await expect(page.locator('#status')).toContainText('Skipped: 1343',{timeout:90000});
    await expect(page.locator('body')).toHaveAttribute('data-busy','false');
    const metrics = await page.evaluate(()=>Reflect.get(window,'skipMetrics'));
    console.log('Unchanged export performance:',{durationMs:Date.now()-started,...metrics});
    expect(downloads).toBe(0);
    // A few task-start/task-end renders are allowed; per-item list replacement is not.
    expect(metrics.listRebuilds).toBeLessThanOrEqual(6);
    await expect(page.locator('#list input:checked')).toHaveCount(1343);
});


test('export progress keeps one cumulative three-counter message through source and attachment events', async ({context,extensionId}) => {
    const page = await openOptions(context, extensionId);
    await seedConversations(page, [{id:'one'}, {id:'two'}]);
    await page.locator('#devToggle').check();
    await expect(page.locator('#devToggle')).toBeEnabled();
    await page.locator('#includeAssets').check();
    await expect(page.locator('#includeAssets')).toBeEnabled();
    await page.evaluate(async accountId => {
        const api = Reflect.get(globalThis, 'uiFixture');
        for (const id of ['one', 'two']) await api.ingestDetail(accountId, id, {
            savedAt: 100, quality: {status:'complete'},
            assets: [{id:'file',kind:'file',name:'report.md',document:{contentMarkdown:`Report ${id}`}}],
            messages: [{role:'user',content:[{type:'paragraph',children:[{type:'text',text:`Question ${id}`}]}]},
                {role:'assistant',content:[{type:'file',assetId:'file'}]}],
        }, {title:id,titleSource:'provider',updatedAt:100});
        const messages: string[] = [];
        Reflect.set(window, 'exportProgressMessages', messages);
        const progress = document.getElementById('progText');
        if (!progress) throw new Error('Missing export progress element');
        new MutationObserver(() => {
            if (progress?.textContent) messages.push(progress.textContent);
        }).observe(progress, {childList:true,subtree:true,characterData:true});
    }, accountId);
    await page.locator('#btnSelectAll').click();
    const download = page.waitForEvent('download');
    await page.locator('#btnExport').click();
    await download;
    await expect(page.locator('body')).toHaveAttribute('data-busy','false');
    const messages: string[] = await page.evaluate(() => Reflect.get(window, 'exportProgressMessages'));
    expect(messages.length).toBeGreaterThan(2);
    const counts = messages.map(message => {
        const match = /^Prepared (\d+) conversations · delivered (\d+) documents · downloaded (\d+) attachments$/.exec(message);
        if (!match) throw new Error(`Unexpected export progress: ${message}`);
        return match.slice(1).map(Number);
    });
    for (let i=1;i<counts.length;i++) for (let metric=0;metric<3;metric++)
        expect(counts[i][metric]).toBeGreaterThanOrEqual(counts[i-1][metric]);
    expect(counts.at(-1)).toEqual([2,2,2]);
});
