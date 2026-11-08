import { test, expect, seedRegistryAccounts } from './fixtures';
import { readFile } from 'node:fs/promises';
import { openOptions, seedConversations, openPopup, storedSettings, uiProbeBundle, accountId } from './uiFixture';
test.beforeEach(async({context,extensionId})=>{void extensionId;await seedRegistryAccounts(context);});
test('directory authorization is explicit; enabled intention and the real stored capability restore after reload',async({context,extensionId})=>{
    const page=await openOptions(context,extensionId);await page.evaluate(()=>{
        Reflect.set(window,'pickerCalls',0);Reflect.set(window,'showDirectoryPicker',async()=>{Reflect.set(window,'pickerCalls',Reflect.get(window,'pickerCalls')+1);return navigator.storage.getDirectory();});
    });
    await expect(page.locator('#btnSetDir')).toBeDisabled();await expect(page.locator('#liveSaveDiskToggle')).toBeDisabled();
    await page.locator('input[name="delivery"][value="folderWriter"]').check();
    await expect(page.locator('#btnSetDir')).toBeEnabled();await expect(page.locator('#liveSaveDiskToggle')).toBeDisabled();
    await page.locator('#btnSetDir').click();await expect(page.locator('#btnSetDir')).toBeEnabled();
    await expect(page.locator('#liveSaveDiskToggle')).toBeEnabled();await page.locator('#liveSaveDiskToggle').check();
    await expect(page.locator('#liveSaveStatus')).toHaveText('Live Save active');
    expect(await page.evaluate(()=>Reflect.get(window,'pickerCalls'))).toBe(1);await expect.poll(async()=>(await storedSettings(page)).enabledDisk).toBe(true);
    await expect.poll(async()=>(await storedSettings(page)).exportDelivery).toBe('folderWriter');
    expect(await page.evaluate(async()=>!!await Reflect.get(globalThis,'uiFixture').getDirectoryHandle())).toBe(true);
    await page.reload();await expect(page.locator('#liveSaveDiskToggle')).toBeChecked();await expect(page.locator('#liveSaveStatus')).toHaveText('Live Save active');
});
test('page postMessage cannot invoke disk writing or forge Live Save feedback',async({context,extensionId})=>{
    const page=await openOptions(context,extensionId);await seedConversations(page,[{id:'live'}]);await page.evaluate(async()=>{const api=Reflect.get(globalThis,'uiFixture');await api.setDirectoryHandle(await navigator.storage.getDirectory());await api.updateSettings({enabledDisk:true});});
    const source=await context.newPage();await source.route('https://gemini.google.com/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><script>window.WIZ_global_data={qDCSke:'10000000001',SNlM0e:'token',cfb2h:'build'}</script><main>Offline fixture</main>`}));await source.goto('https://gemini.google.com/app/live');await expect(source.locator('#geminiExportBadge')).toBeVisible();
    await source.evaluate(()=>{window.postMessage({type:'GEMINI_LIVE_SAVE_TRIGGER',payload:{cid:'live',reason:'turn_complete',mockMode:true}},location.origin);window.postMessage({action:'runLiveSave',key:{accountId:'fake',conversationId:'live'}},location.origin);});
    // Wait across several event-loop turns for the window-message listener to execute.
    await source.evaluate(()=>new Promise(resolve=>setTimeout(resolve,200)));
    await expect(source.locator('#geminiExportBadge')).not.toHaveClass(/live-saved/);expect(await page.evaluate(id=>Reflect.get(globalThis,'uiFixture').listExportRecords(id),accountId)).toEqual({});
    expect(await page.evaluate(async()=>{const root=await navigator.storage.getDirectory();const names=[];for await(const name of Reflect.get(root,'keys').call(root))names.push(name);return names;})).toEqual([]);
});
test('Background Live Save and manual folder delivery use the same planned filename and physical content',async({context,extensionId})=>{
    const page=await openOptions(context,extensionId);await seedConversations(page,[{id:'0123456789abcdef',title:'Quantum Computing',body:'Shared physical body'}]);
    await page.evaluate(async()=>{const api=Reflect.get(globalThis,'uiFixture');await api.setDirectoryHandle(await navigator.storage.getDirectory());await api.updateSettings({enabledDisk:true,defaultFormat:'markdown',skipExported:false,exportDelivery:'folderWriter'});});
    const worker=context.serviceWorkers()[0];await worker.evaluate(await uiProbeBundle());const result=await worker.evaluate(id=>Reflect.get(globalThis,'uiFixture').runLiveSave({accountId:id,conversationId:'0123456789abcdef'}),accountId);expect(result.exported).toBe(1);
    const files=await page.evaluate(async()=>{const root=await navigator.storage.getDirectory();const files:{name:string,text:string}[]=[];for await(const [name,handle]of Reflect.get(root,'entries').call(root))if(handle.kind==='file')files.push({name,text:await(await(handle as FileSystemFileHandle).getFile()).text()});return files;});expect(files).toHaveLength(1);expect(files[0].text).toContain('Shared physical body');expect(files[0].name).toMatch(/abcdef.*\.md$/);
    // Switching to browser delivery pauses Live Save, but manual download remains available.
    await page.locator('input[name="delivery"][value="browserDownload"]').check();
    await expect(page.locator('#liveSaveDiskToggle')).toBeDisabled();
    await expect.poll(async()=>(await storedSettings(page)).exportDelivery).toBe('browserDownload');
    await page.locator('#btnSelectAll').click();const pending=page.waitForEvent('download');await page.locator('#btnExport').click();const download=await pending;expect(download.suggestedFilename()).toBe(files[0].name);expect(await readFile((await download.path())!,'utf8')).toBe(files[0].text);
});
test('non-Markdown formats pause effective saving across Options, Popup and reload while preserving enabledDisk',async({context,extensionId})=>{
    const page=await openOptions(context,extensionId);
    await page.evaluate(()=>{Reflect.set(window,'showDirectoryPicker',async()=>navigator.storage.getDirectory());});
    await page.locator('input[name="delivery"][value="folderWriter"]').check();
    await page.locator('#btnSetDir').click();await expect(page.locator('#liveSaveDiskToggle')).toBeEnabled();
    await page.locator('#liveSaveDiskToggle').check();await expect(page.locator('body')).toHaveAttribute('data-busy','false');
    for(const format of ['pdf','html','json']){await page.locator('#format').selectOption(format);await expect(page.locator('#liveSaveDiskToggle')).toBeDisabled();await expect(page.locator('#liveSaveDiskToggle')).toBeChecked();expect((await storedSettings(page)).enabledDisk).toBe(true);}
    await page.reload();await expect(page.locator('#liveSaveDiskToggle')).toBeDisabled();await expect(page.locator('#liveSaveDiskToggle')).toBeChecked();const popup=await openPopup(context,extensionId);await popup.locator('[data-format="markdown"]').click();await expect(page.locator('#format')).toHaveValue('markdown');await expect(page.locator('#liveSaveDiskToggle')).toBeEnabled();await expect(page.locator('#liveSaveDiskToggle')).toBeChecked();
    await popup.locator('[data-format="html"]').click();await expect(page.locator('#format')).toHaveValue('html');await expect(page.locator('#liveSaveDiskToggle')).toBeDisabled();await expect(page.locator('#liveSaveDiskToggle')).toBeChecked();
});

test('title promotion updates the same physical Live Save document across separate tasks', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
    const id = '0123456789abcdef';
    await seedConversations(page, [{ id, title: 'Conversation with Gemini', titleSource: 'derived', body: 'Initial body' }]);
    await page.evaluate(async () => {
        const api = Reflect.get(globalThis, 'uiFixture');
        await api.setDirectoryHandle(await navigator.storage.getDirectory());
        await api.updateSettings({ enabledDisk: true, defaultFormat: 'markdown', skipExported: false, exportDelivery: 'folderWriter' });
    });
    const worker = context.serviceWorkers()[0];
    await worker.evaluate(await uiProbeBundle());
    const save = () => worker.evaluate(({ accountId, id }) => Reflect.get(globalThis, 'uiFixture').runLiveSave({ accountId, conversationId: id }), { accountId, id });
    expect((await save()).exported).toBe(1);
    await seedConversations(page, [{ id, title: 'Authoritative truss title', titleSource: 'provider', body: 'Updated complete body' }]);
    expect((await save()).exported).toBe(1);
    const files = await page.evaluate(async () => {
        const directory = await navigator.storage.getDirectory();
        const files: { name: string; text: string }[] = [];
        for await (const [name, handle] of Reflect.get(directory, 'entries').call(directory)) {
            if (handle.kind === 'file') files.push({ name, text: await (await (handle as FileSystemFileHandle).getFile()).text() });
        }
        return files;
    });
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('Conversation with Gemini_abcdef.md');
    expect(files[0].text).toContain('Authoritative truss title');
    expect(files[0].text).toContain('Updated complete body');
    expect(files[0].text).not.toContain('Initial body');
});
