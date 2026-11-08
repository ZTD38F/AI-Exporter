import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, seedConversations, accountId } from './uiFixture';
import { readFile } from 'node:fs/promises';
import { A, mount, read } from '../helpers/uiPortHarness';
test('old interrupted sessions stay inert after reload and language changes; source titles remain untouched',async({context,extensionId})=>{
    await seedRegistryAccounts(context);const page=await openOptions(context,extensionId);await seedConversations(page,[{id:'one',title:'Takeout Prompt 临时问题',titleSource:'derived'},{id:'two'}]);
    await page.evaluate(()=>chrome.storage.local.set({gemini_last_export_session:{status:'interrupted',total:2,current:1,lastChatId:'one',lastChatTitle:'Must not overwrite source title'}}));
    await page.reload();await expect(page.locator('#list .item')).toHaveCount(2);await expect(page.locator('#exportSessionBanner,#btnResumeExport,#btnDismissExportBanner')).toHaveCount(0);await expect(page.locator('#list input:checked')).toHaveCount(0);
    await page.locator('#langToggle').uncheck();
    await expect(page.locator('html')).toHaveAttribute('lang','zh-CN');
    await expect(page.locator('[data-chat-id="one"]')).toContainText('Takeout Prompt 临时问题');
    await expect(page.locator('#btnExport')).toBeDisabled();
    await page.locator('#langToggle').check();
    await expect(page.locator('html')).toHaveAttribute('lang','en');
    await expect(page.locator('[data-chat-id="one"]')).toContainText('Takeout Prompt 临时问题');
    // Direct IDB inspection is through current Storage, with no v1 globals or aliases.
    const {exposeUIStorage}=await import('./uiFixture');await exposeUIStorage(page);
    const index=await page.evaluate(id=>Reflect.get(globalThis,'uiFixture').getIndex({accountId:id,conversationId:'one'}),accountId);expect(index.title).toBe('Takeout Prompt 临时问题');expect(index.titleSource).toBe('derived');
});
test('active export locks scan, settings and selection through cancellation and releases only when the task returns',async({page})=>{
    // Delay only the Application port; all workbench handlers and rendering execute.
    await mount(page,'options',{holdExport:true});await page.locator('#btnSelectAll').click();await page.locator('#btnExport').click();
    for(const id of ['btnSyncAll','btnExport','format','accountIdSelect','skipExported','includeAssets','liveSaveDiskToggle','btnSetDir','btnTourGuide'])await expect(page.locator(`#${id}`)).toBeDisabled();await expect(page.locator('#list input')).toBeDisabled();await expect(page.locator('#exportSessionBanner')).toHaveCount(0);
    await expect(page.locator('input[name="delivery"]:enabled')).toHaveCount(0);
    await expect(page.locator('#exportOptionsLock')).toBeVisible();
    const beforeSettings = await read(page,'settings');
    const beforePatches = await read(page,'patches');
    await page.evaluate(() => {
        for (const [id,value] of [['format','pdf'],['skipExported',false],['includeAssets',false]]) {
            const input = document.getElementById(String(id)) as HTMLInputElement;
            if (typeof value === 'boolean') input.checked = value; else input.value = value;
            input.dispatchEvent(new Event('change',{bubbles:true}));
        }
        const radio = document.querySelector<HTMLInputElement>('input[value="folderWriter"]')!;
        radio.checked = true; radio.dispatchEvent(new Event('change',{bubbles:true}));
    });
    expect(await read(page,'settings')).toEqual(beforeSettings);
    expect(await read(page,'patches')).toEqual(beforePatches);
    await expect(page.locator('#format')).toHaveValue(beforeSettings.defaultFormat);
    await expect(page.locator('#includeAssets')).toBeChecked({ checked: beforeSettings.includeAssets });
    await expect(page.locator('input[value="browserDownload"]')).toBeChecked();
    const request = (await read(page, 'exports'))[0];
    const progress = await page.locator('#status').textContent();
    const originalLog = await page.locator('#log').textContent();
    await expect(page.locator('#devToggle')).toBeEnabled();
    await page.locator('#devToggle').check();
    await expect(page.locator('body')).toHaveClass(/dev-mode/);
    await expect.poll(async () => (await read(page, 'settings')).developerMode).toBe(true);
    await expect(page.locator('#langToggle')).toBeEnabled();
    await page.locator('#langToggle').uncheck();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect.poll(async () => (await read(page, 'settings')).language).toBe('zh');
    await expect(page.locator('body')).toHaveAttribute('data-busy', 'true');
    await expect(page.locator('#status')).toHaveText('已准备 1 条会话 · 已交付正文 0 条 · 已下载 0 个附件');
    await expect(page.locator('#log')).toHaveText(originalLog!);
    await expect(page.locator('#format')).toBeDisabled();
    expect(await read(page, 'exports')).toEqual([request]);
    await page.locator('#devToggle').uncheck();
    await expect(page.locator('body')).not.toHaveClass(/dev-mode/);
    await expect(page.locator('#langToggle')).toBeEnabled();
    await page.locator('#langToggle').check();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#status')).toHaveText(progress!);
    await expect(page.locator('#log')).toHaveText(originalLog!);
    await page.locator('#list span').click({force:true});await expect(page.locator('#list input')).toBeChecked();await page.locator('#btnCancel').click();await expect(page.locator('#btnSyncAll')).toBeDisabled();
    await expect(page.locator('#exportOptionsLock')).toBeVisible();
    await expect(page.locator('#includeAssets')).toBeDisabled();
    await page.evaluate(()=>Reflect.get(window,'harness').finishExport());await expect(page.locator('#btnSyncAll')).toBeEnabled();await expect(page.locator('#list input')).toBeEnabled();await expect(page.locator('#status')).toContainText('Cancelled');expect((await read(page,'exports')).length).toBe(1);
    await expect(page.locator('#exportOptionsLock')).toBeHidden();
    await expect(page.locator('#format')).toBeEnabled();
    await expect(page.locator('#includeAssets')).toBeEnabled();
    await expect(page.locator('#btnTourGuide')).toBeEnabled();
});


test('downloaded diagnostics include historic partial outcomes and captured export causes', async ({page}) => {
    const record = { exportedAt: 1, format: 'markdown', status: 'partial', chatTime: 5,
        otherContentMissing: true, attachmentIssues: [{ resourceId: 'image-1', name: 'image.png',
            sourceUrl: 'https://example.test/expired', code: 'RESOURCE_SOURCE_EXPIRED', httpStatus: 403 }] };
    await mount(page, 'options', { holdExport: true, partial: true, records: { [A]: { a: record } } });
    await page.locator('#devToggle').check();
    await page.locator('#btnSelectAll').click();
    await page.locator('#btnExport').click();
    await page.evaluate(({record}) => {
        const h = Reflect.get(window, 'harness');
        const key = h.exports[0].keys[0];
        h.exportOptions.onDiagnostic({ key, stage: 'source_refresh', code: 'SOURCE_REFRESH_FAILED', message: 'RPC unavailable' });
        h.exportOptions.onDiagnostic({ key, stage: 'source_parse', code: 'GEMINI_DETAIL_PAGES',
            message: 'Source Detail pagination evidence', details: { pageCount: 2, versionChanged: true,
                pages: [{ page: 1, sourceVersion: 100 }, { page: 2, sourceVersion: 200 }] } });
        h.exportOptions.onItemUpdate({ key, status: 'exported', record });
        h.finishExport();
    }, {record});
    await expect(page.locator('body')).toHaveAttribute('data-busy', 'false');
    const downloaded = page.waitForEvent('download');
    await page.locator('#btnExportDiag').focus();
    await page.locator('#btnExportDiag').press('Enter');
    const file = await downloaded;
    const diag = JSON.parse(await readFile((await file.path())!, 'utf8'));
    expect(diag.schemaVersion).toBe(2);
    expect(diag.diagnosticRevision).toBe(2);
    expect(typeof diag.environment.online).toBe('boolean');
    expect(diag.extensionVersion).toBe('1.8.1');
    expect(diag.currentExportIssues[0].record.attachmentIssues[0].httpStatus).toBe(403);
    expect(diag.currentExportIssues[0].reasonAvailability).toContain('Stored outcome only');
    const run = diag.exportRuns[0];
    expect(run.request.keys).toEqual([{accountId: A, conversationId: 'a'}]);
    expect(run.request.format).toBe('markdown');
    expect(run.finishedAt).toBeGreaterThanOrEqual(run.startedAt);
    expect(run.result.partial).toBe(1);
    expect(run.items[0].record).toEqual(record);
    expect(run.items[0].title).toBe('<img src=x onerror=alert(1)>');
    expect(run.diagnostics[1]).toMatchObject({ stage: 'source_parse', code: 'GEMINI_DETAIL_PAGES',
        details: { pageCount: 2, versionChanged: true,
            pages: [{ page: 1, sourceVersion: 100 }, { page: 2, sourceVersion: 200 }] } });
    expect(run.diagnostics[0]).toMatchObject({ code: 'SOURCE_REFRESH_FAILED', message: 'RPC unavailable',
        key: { accountId: A, conversationId: 'a' } });
});
