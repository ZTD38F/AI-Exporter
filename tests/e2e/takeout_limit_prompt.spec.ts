import { test, expect } from '@playwright/test';
import { mount, read } from '../helpers/uiPortHarness';
// Exercise actual workbench/Tour handlers; only Application scan/import ports are mocked.
// Source RPC integration remains covered by scan_flow.spec.ts.
test('Takeout suggestion uses the current history explanation and persists acknowledgement once',async({page})=>{
    await mount(page,'options',{scanCount:620,scanResult:{status:'partial_limit',reason:'provider_limit',pagesFetched:13,conversationsFetched:620}});await page.locator('#btnSyncAll').click();await expect(page.locator('.tour-popover')).toContainText('Supplement Your History with Google Takeout');await expect(page.locator('.tour-popover')).toContainText('Gemini may limit online history');
    await page.getByRole('button',{name:'Got it, don’t show again',exact:true}).click();await expect(page.locator('.tour-popover')).toHaveCount(0);expect(await read(page,'patches')).toContainEqual({takeoutPromptCompleted:true});
    await page.locator('#btnSyncAll').click();await expect(page.locator('body')).toHaveAttribute('data-busy','false');await expect(page.locator('.tour-popover')).toHaveCount(0);
});
test('suggestion Import action reaches the current File input and dismisses the overlay',async({page})=>{
    await mount(page,'options',{scanCount:650,scanResult:{status:'partial_limit',reason:'provider_limit',pagesFetched:13,conversationsFetched:650}});await page.locator('#btnSyncAll').click();await expect(page.locator('.tour-popover')).toBeVisible();
    const chooser=page.waitForEvent('filechooser');await page.locator('.tour-popover').getByRole('button',{name:'Import Takeout ZIP',exact:true}).click();expect((await chooser).isMultiple()).toBe(false);await expect(page.locator('.tour-popover')).toHaveCount(0);
});
test('Takeout suggestion requires a verified provider limit, not a local page budget or count threshold',async({page})=>{
    await mount(page,'options',{scanCount:150,scanResult:{status:'partial_limit',reason:'max_pages',pagesFetched:3,conversationsFetched:150}});
    await page.locator('#btnSyncAll').click();
    await expect(page.locator('.tour-popover')).toHaveCount(0);
    await page.evaluate(()=>{const h=Reflect.get(window,'harness');h.scanCount=151;h.scanResult={status:'partial_limit',reason:'max_pages',pagesFetched:4,conversationsFetched:151};});
    await page.locator('#btnSyncAll').click();
    await expect(page.locator('.tour-popover')).toHaveCount(0);
    await page.evaluate(()=>{const h=Reflect.get(window,'harness');h.scanResult={status:'partial_limit',reason:'provider_limit',pagesFetched:4,conversationsFetched:151};});
    await page.locator('#btnSyncAll').click();
    await expect(page.locator('.tour-popover')).toBeVisible();
    await page.getByRole('button',{name:'×',exact:true}).click();
    await expect(page.locator('.tour-popover')).toHaveCount(0);
});
test('a successful current File import suppresses later eligible prompts without transient Index import flags',async({page})=>{
    await mount(page,'options',{scanCount:620,scanResult:{status:'partial_limit',reason:'provider_limit',pagesFetched:13,conversationsFetched:620}});await page.locator('#takeoutFileInput').setInputFiles({name:'Takeout.zip',mimeType:'application/zip',buffer:Buffer.from('fixture')});await expect(page.locator('#status')).toHaveText('Imported 2 conversations (partial)');
    expect(await read(page,'patches')).toContainEqual({takeoutPromptCompleted:true});await page.locator('#btnSyncAll').click();await expect(page.locator('body')).toHaveAttribute('data-busy','false');await expect(page.locator('.tour-popover')).toHaveCount(0);expect(await read(page,'imports')).toHaveLength(1);
});
