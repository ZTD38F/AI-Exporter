import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, seedConversations } from './uiFixture';
test.beforeEach(async({context,extensionId})=>{void extensionId;await seedRegistryAccounts(context);});
test('workbench list preserves explicit selection across row clicks, search and language changes',async({context,extensionId})=>{
    const page=await openOptions(context,extensionId);
    await seedConversations(page,[{id:'chat_001',title:'量子计算的基本原理'},{id:'chat_002',title:'AI 架构与设计模式'},{id:'chat_003',title:'Python 性能优化指南'}],{chat_001:{exportedAt:200,format:'markdown',status:'ok',chatTime:100}});
    await expect(page.locator('#list input:checked')).toHaveCount(0);
    await page.locator('#btnSelectAll').click();await expect(page.locator('#list input:checked')).toHaveCount(3);await expect(page.locator('#selectedStat')).toHaveText('3 of 3 selected');
    await page.locator('#btnSelectAll').click();await expect(page.locator('#list input:checked')).toHaveCount(0);
    const row=page.locator('[data-chat-id="chat_002"]');await row.locator('.chat-title').click();await expect(row.locator('input')).toBeChecked();
    await expect(page.locator('#btnSelectAll')).toHaveJSProperty('indeterminate',true);
    await row.locator('.chat-title').click();await expect(row.locator('input')).not.toBeChecked();
    await expect(page.locator('#btnSelectAll')).toHaveJSProperty('indeterminate',false);
    await page.locator('#chatSearchInput').fill('量子');await expect(page.locator('#list .item')).toHaveCount(1);await page.locator('#btnSelectAll').click();await expect(page.locator('#selectedStat')).toHaveText('1 of 3 selected');
    await page.locator('#chatSearchInput').fill('');await expect(page.locator('#list .item')).toHaveCount(3);
    for(const language of ['zh','en']) {await page.locator('#langToggle').setChecked(language==='en');await expect(page.locator('#btnSelectAll')).toHaveAttribute('aria-label',language==='zh'?'全选当前可见会话':'Select all visible conversations');await expect(page.locator('[data-chat-id="chat_001"] input')).toBeChecked();}
    await expect(page.locator('#feedbackBox')).toHaveAttribute('href','https://tally.so/r/Y56ZBB?source=extension');await expect(page.locator('#feedbackBox')).toHaveAttribute('target','_blank');await expect(page.locator('#feedbackBox')).toContainText('Send Feedback');
    await expect(page.locator('#btnSelectUpdated,#btnSelectUnexported,#btnFeedback')).toHaveCount(0);
});
test('list badges distinguish success, later activity, incomplete exports and missing records',async({context,extensionId})=>{
    const page=await openOptions(context,extensionId);
    await seedConversations(page,[{id:'fresh'},{id:'exported'},{id:'updated',updatedAt:300},{id:'partial'},{id:'partial_updated',updatedAt:300},{id:'no-record'},{id:'empty'}],{
        exported:{exportedAt:200,format:'markdown',status:'ok',chatTime:100},
        updated:{exportedAt:200,format:'html',status:'ok',chatTime:100},
        partial:{exportedAt:200,format:'markdown',status:'partial',chatTime:100},
        partial_updated:{exportedAt:200,format:'json',status:'partial',chatTime:100}
    });
    for(const id of ['fresh','no-record','empty']) {
        await expect(page.locator(`[data-chat-id="${id}"] .status-tag`)).toHaveCount(0);
        await expect(page.locator(`[data-chat-id="${id}"] .meta`)).not.toContainText('No export record');
    }
    await expect(page.locator('[data-chat-id="exported"] .status-exported')).toContainText(/^Export successful \(.+\)$/);
    await expect(page.locator('[data-chat-id="updated"] .status-updated')).toHaveText('Updated');
    await expect(page.locator('[data-chat-id="partial"] .status-partial')).toHaveText('Incomplete export');
    await expect(page.locator('[data-chat-id="partial_updated"] .status-partial')).toHaveText('Incomplete export');
    await expect(page.locator('[data-chat-id="updated"] .meta')).toContainText('Last export · html');
    await expect(page.locator('[data-chat-id="updated"] .meta')).not.toContainText('Updated');
    await expect(page.locator('#list input:checked')).toHaveCount(0);
    await expect(page.locator('.status-exported')).toHaveCount(1);
    await expect(page.locator('.status-updated')).toHaveCount(1);
    await expect(page.locator('.status-partial')).toHaveCount(2);
    await page.locator('[data-chat-id="partial"] input').check();
    await page.locator('#langToggle').uncheck();
    await expect(page.locator('[data-chat-id="partial"] input')).toBeChecked();
    await expect(page.locator('[data-chat-id="partial"] .status-partial')).toHaveText('导出不完整');
    await expect(page.locator('[data-chat-id="updated"] .status-updated')).toHaveText('有更新');
    await expect(page.locator('[data-chat-id="exported"] .status-exported')).toContainText(/^导出成功（.+）$/);
    await page.reload();
    await expect(page.locator('#list .item')).toHaveCount(7);
    await expect(page.locator('#list input:checked')).toHaveCount(0);
});

for (const permission of ['throws', 'pending'] as const) test(`saved conversations render after reload when folder permission ${permission}`, async ({context, extensionId}) => {
    const page = await openOptions(context, extensionId);
    await seedConversations(page, [{id:'reload-survivor', title:'Persisted conversation'}]);
    await page.evaluate(async () => {
        await Reflect.get(globalThis, 'uiFixture').setDirectoryHandle(await navigator.storage.getDirectory());
    });
    await page.addInitScript(permission => {
        Object.defineProperty(FileSystemHandle.prototype, 'queryPermission', { configurable: true,
            value: () => permission === 'throws'
                ? Promise.reject(new DOMException('Saved folder is unavailable', 'NotAllowedError'))
                : new Promise(() => {}) });
    }, permission);
    await page.reload();
    await expect(page.locator('[data-chat-id="reload-survivor"]')).toBeVisible();
    await expect(page.locator('#selectedStat')).toContainText('0 of 1');
    await page.locator('#btnSelectAll').click();
    await expect(page.locator('#btnExport')).toBeEnabled();
    if (permission === 'throws') await expect(page.locator('#status')).toContainText('Folder permission could not be restored');
});

test('a workbench opened without an account refreshes when the first account is admitted', async ({context, extensionId}) => {
    const seed = await openOptions(context, extensionId);
    await seed.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const r = indexedDB.open('gemini_exporter_v2'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
        });
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('accounts', 'readwrite'); tx.objectStore('accounts').clear();
            tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        });
        db.close();
    });
    const waiting = await openOptions(context, extensionId);
    await expect(waiting.locator('#accountIdSelect option')).toHaveCount(0);
    await seed.evaluate(async () => {
        const api = Reflect.get(globalThis, 'uiFixture');
        const accountId = '10000000-0000-4000-8000-000000000001';
        await api.putAccount({id:accountId, providerId:'gemini', providerAccountId:'10000000001'});
        await api.putIndexes([{key:{accountId,conversationId:'first-admission'},title:'First admitted chat',titleSource:'provider',updatedAt:123}]);
    });
    const worker = context.serviceWorkers()[0];
    await worker.evaluate(() => chrome.runtime.sendMessage({action:'domainChanged',accountId:'10000000-0000-4000-8000-000000000001'}));
    await expect(waiting.locator('[data-chat-id="first-admission"]')).toBeVisible();
});

test('specific attachment failures retain details beneath one concise badge', async ({context, extensionId}, testInfo) => {
    const page = await openOptions(context, extensionId);
    const expired = {resourceId:'missing',name:'photo.png',code:'RESOURCE_LOCATOR_UNAVAILABLE',httpStatus:404,sourceUrl:'https://example.test/photo'};
    const download = {resourceId:'retry',name:'retry.png',code:'RESOURCE_DOWNLOAD_FAILED',httpStatus:503};
    const restricted = {resourceId:'private',name:'private.png',code:'RESOURCE_ACCESS_RESTRICTED',httpStatus:403};
    await seedConversations(page, [{id:'expired-only'}, {id:'mixed'}, {id:'restricted'}, {id:'text-incomplete'}, {id:'legacy-partial'}], {
        'expired-only':{exportedAt:200,format:'markdown',status:'partial',chatTime:100,attachmentIssues:[expired]},
        mixed:{exportedAt:200,format:'html',status:'partial',chatTime:100,attachmentIssues:[expired,download]},
        restricted:{exportedAt:200,format:'json',status:'partial',chatTime:100,attachmentIssues:[restricted]},
        'text-incomplete':{exportedAt:200,format:'html',status:'partial',chatTime:100,otherContentMissing:true,attachmentIssues:[expired]},
        'legacy-partial':{exportedAt:200,format:'pdf',status:'partial',chatTime:100},
    });
    const row = page.locator('[data-chat-id="expired-only"]');
    await expect(page.locator('.status-unavailable,.attachment-issues')).toHaveCount(0);
    await expect(page.locator('[data-chat-id="text-incomplete"] .status-partial')).toHaveText('Incomplete export');
    await page.locator('#devToggle').check();
    await expect(row.locator('.status-unavailable')).toHaveText('Some source attachments unavailable');
    await expect(row.locator('.status-partial')).toHaveCount(0);
    await page.locator('#btnThemeToggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(row.locator('.status-unavailable')).toHaveCSS('color', 'rgb(225, 189, 133)');
    await row.locator('summary').click();
    await expect(row.locator('input')).not.toBeChecked();
    await expect(row.locator('details')).toContainText('photo.png: Source attachment unavailable');
    await expect(row.locator('details')).toContainText('HTTP 404');
    await expect(row.locator('details a')).toHaveAttribute('href', 'https://example.test/photo');
    await expect(page.locator('[data-chat-id="mixed"] .status-unavailable')).toHaveText('Some attachments failed');
    await expect(page.locator('[data-chat-id="restricted"] .status-unavailable')).toHaveText('Some attachments failed');
    await expect(page.locator('[data-chat-id="text-incomplete"] .status-partial')).toHaveText('Incomplete export');
    await expect(page.locator('[data-chat-id="legacy-partial"] .status-partial')).toHaveText('Incomplete export');
    await page.locator('#langToggle').uncheck();
    await row.locator('summary').click();
    await expect(row.locator('details')).toContainText('来源附件无法获取');
    await expect(page.locator('[data-chat-id="mixed"] .status-unavailable')).toHaveText('部分附件获取失败');
    await expect(page.locator('[data-chat-id="text-incomplete"] .status-partial')).toHaveText('导出不完整');
    await page.screenshot({path:testInfo.outputPath('attachment-expiry.png'),fullPage:true});
    await page.reload();
    await expect(row.locator('.status-unavailable')).toHaveText('部分来源附件无法获取');
    await page.locator('#devToggle').uncheck();
    await expect(page.locator('.status-unavailable,.attachment-issues')).toHaveCount(0);
    await expect(page.locator('[data-chat-id="text-incomplete"] .status-partial')).toHaveText('导出不完整');
});


test('conversation row padding and gaps toggle selection without double-toggling controls', async ({context, extensionId}) => {
    const page = await openOptions(context, extensionId);
    await seedConversations(page, [{id:'click-target', title:'Click target'}]);
    const row = page.locator('[data-chat-id="click-target"]');
    const checkbox = row.locator('input');
    // The row advertises a pointer over its padding, outside the inner body.
    await row.click({position:{x:2,y:2}});
    await expect(checkbox).toBeChecked();
    await expect(page.locator('#selectedStat')).toHaveText('1 of 1 selected');
    await expect(page.locator('#btnExport')).toBeEnabled();
    await row.click({position:{x:2,y:2}});
    await expect(checkbox).not.toBeChecked();
    const gap = await row.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const input = element.querySelector('input');
        if (!input) throw new Error('Missing row checkbox');
        return {x:input.getBoundingClientRect().right - bounds.left + 2,y:10};
    });
    await row.click({position:gap});
    await expect(checkbox).toBeChecked();
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();
    await checkbox.press('Space');
    await expect(checkbox).toBeChecked();
    await row.locator('.chat-title').click();
    await expect(checkbox).not.toBeChecked();
    const popup = page.waitForEvent('popup');
    await row.locator('.open-link').click();
    await (await popup).close();
    await expect(checkbox).not.toBeChecked();
});


for (const target of ['.chat-title', 'input']) test(`a background refresh between mouse down and up preserves a click on ${target}`, async ({context, extensionId}) => {
    const page = await openOptions(context, extensionId);
    await seedConversations(page, [{id:'pressed',title:'Pressed conversation'}, {id:'background',title:'Background conversation'}]);
    const row = page.locator('[data-chat-id="pressed"]');
    await row.locator(target).hover();
    await page.mouse.down();
    await page.evaluate(async () => {
        const api = Reflect.get(globalThis, 'uiFixture');
        const accountId = '10000000-0000-4000-8000-000000000001';
        const indexes = await api.listIndexes(accountId);
        await api.putIndexes(indexes.map((index: {key:{conversationId:string};title:string}) =>
            index.key.conversationId === 'background' ? {...index,title:'Background refreshed'} : index));
    });
    await context.serviceWorkers()[0].evaluate(() => chrome.runtime.sendMessage({action:'domainChanged',accountId:'10000000-0000-4000-8000-000000000001'}));
    await expect(page.locator('[data-chat-id="background"] .chat-title')).toHaveText('Background refreshed');
    await page.mouse.up();
    await expect(row.locator('input')).toBeChecked();
});

test('focus and unrelated storage changes avoid unchanged paints; notification bursts read once', async ({context, extensionId}) => {
    const page = await openOptions(context, extensionId);
    await seedConversations(page, [{id:'refresh-count',title:'Initial title'}]);
    await page.evaluate(() => {
        const metrics = {paints:0,accountReads:0,indexReads:0};
        Reflect.set(globalThis, 'refreshMetrics', metrics);
        const replace = Element.prototype.replaceChildren;
        Element.prototype.replaceChildren = function(...nodes) {
            if (this.id === 'accountIdSelect') metrics.paints++;
            return replace.apply(this, nodes);
        };
        const getAll = IDBObjectStore.prototype.getAll;
        IDBObjectStore.prototype.getAll = function(...args) {
            if (this.transaction.mode === 'readonly') {
                if (this.name === 'accounts') metrics.accountReads++;
                if (this.name === 'indexes') metrics.indexReads++;
            }
            return getAll.apply(this, args);
        };
    });
    const metrics = () => page.evaluate(() => ({...Reflect.get(globalThis, 'refreshMetrics')}));
    await page.evaluate(async () => {
        await chrome.storage.local.set({unrelated_refresh_probe:'changed'});
        await Reflect.get(globalThis, 'uiFixture').updateSettings({badgePosition:{left:10,top:20}});
        window.dispatchEvent(new Event('focus'));
    });
    await expect.poll(async () => (await metrics()).accountReads).toBeGreaterThan(0);
    await page.waitForTimeout(100);
    expect(await metrics()).toEqual({paints:0,accountReads:1,indexReads:1});

    await context.serviceWorkers()[0].evaluate(async () => {
        await Promise.all(Array.from({length:20}, () => chrome.runtime.sendMessage({action:'domainChanged',accountId:'10000000-0000-4000-8000-000000000002'})));
    });
    await expect.poll(async () => (await metrics()).accountReads).toBe(2);
    await page.waitForTimeout(100);
    expect(await metrics()).toEqual({paints:0,accountReads:2,indexReads:1});

    await page.evaluate(async () => {
        const api = Reflect.get(globalThis, 'uiFixture');
        const accountId = '10000000-0000-4000-8000-000000000001';
        await api.putIndexes([{key:{accountId,conversationId:'refresh-count'},title:'Updated title',titleSource:'provider',updatedAt:100}]);
        Object.assign(Reflect.get(globalThis, 'refreshMetrics'), {paints:0,accountReads:0,indexReads:0});
        window.dispatchEvent(new Event('focus'));
    });
    await expect(page.locator('[data-chat-id="refresh-count"] .chat-title')).toHaveText('Updated title');
    expect(await metrics()).toEqual({paints:1,accountReads:1,indexReads:1});
    await page.locator('#btnThemeToggle').click();
    await expect(page.locator('#btnThemeToggle')).toBeEnabled();
    // Theme's optimistic paint and unlock paint are enough; its own storage echo adds none.
    expect((await metrics()).paints).toBe(3);
});
