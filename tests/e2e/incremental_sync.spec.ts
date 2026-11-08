import { continueToScan, waitForAuthorization } from '../helpers/tourNavigation';
import { geminiListPage } from '../fixtures/providers/geminiListCapture.js';
import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, seedConversations, accountId } from './uiFixture';
import { readFile } from 'node:fs/promises';
import { listGen as geminiListGen } from '../fixtures/providers/gemini.js';

test.beforeEach(async ({ context }) => { await seedRegistryAccounts(context); });

async function sourcePage(context: import('@playwright/test').BrowserContext) {
    const page = await context.newPage();
    await page.route('https://gemini.google.com/**', route => route.fulfill({
        contentType: 'text/html',
        body: '<script>window.WIZ_global_data={qDCSke:"10000000001",SNlM0e:"test",cfb2h:"test"}</script>',
    }));
    await page.goto('https://gemini.google.com/app');
    return page;
}
const v2 = (page: import('@playwright/test').Page) => page.evaluate(async id => {
    const api = Reflect.get(globalThis, 'uiFixture');
    return {
        coverage: await api.getCoverage(id, 'recent'),
        indexes: await api.listIndexes(id),
        retainedRecord: await api.getExportRecord({ accountId: id, conversationId: 'retained' }),
        retained: await api.readConversation({ accountId: id, conversationId: 'retained' }),
    };
}, accountId);

test('diagnostic download includes the failed scan page and its native error envelope', async ({ context, extensionId }) => {
    await sourcePage(context);
    const responseText = geminiListGen('G_E2E_INCREMENTAL_ERROR_LIST_01');
    await context.route('**/batchexecute*', route => route.fulfill({
        contentType: 'application/json', body: responseText,
    }));
    const options = await openOptions(context, extensionId);
    await options.click('#btnSyncAll');
    await expect(options.locator('#scanStatus')).toContainText('Scan failed: invalid Gemini response');
    await expect(options.locator('#log')).toContainText('invalid_response');
    await expect(options.locator('body')).toHaveAttribute('data-scanning', 'false');
    await options.check('#devToggle');
    const downloaded = options.waitForEvent('download');
    await options.locator('#btnExportDiag').focus();
    await options.locator('#btnExportDiag').press('Enter');
    const download = await downloaded;
    const report = JSON.parse(await readFile((await download.path())!, 'utf8'));
    expect(report.scanRuns).toHaveLength(1);
    expect(report.scanRuns[0].result.reason).toContain('invalid_response');
    expect(report.scanRuns[0]).toMatchObject({ accountId, forceFull: false,
        result: { status: 'error', pagesFetched: 0, diagnostics: {
            providerId: 'gemini', streamId: 'recent', page: 1, requestCursor: null,
            failure: 'invalid_response', details: { topParsed: responseText },
        } } });
    expect((await v2(options)).coverage?.range ?? null).toBeNull();
});

test('trusted provider-limit window is persisted by L2/L3a and reused for v2 early stop without losing existing facts', async ({ context, extensionId }) => {
    const gemini = await sourcePage(context);
    let round = 0;
    const requests: string[][] = [[], [], []];
    // Active scan RPC is issued by the extension/provider, not the Gemini tab.
    // Observe requests in the BrowserContext (as the passing scan_flow E2E does).
    await context.route('**/batchexecute*', async route => {
        const args = JSON.parse(JSON.parse(new URLSearchParams(route.request().postData()!).get('f.req')!)[0][0][1]);
        const cursor = args[1];
        requests[round].push(cursor || 'head');
        const responseKey: Parameters<typeof geminiListGen>[0] =
            cursor === 'tC_limit' ? 'G_E2E_INCREMENTAL_WINDOW_LIMIT_01'
                : round === 0 ? cursor === null
                    ? 'G_E2E_INCREMENTAL_WINDOW_HEAD_01' : 'G_E2E_INCREMENTAL_WINDOW_MIDDLE_01'
                    : round === 1 ? 'G_E2E_INCREMENTAL_WINDOW_HEAD_02' : 'G_E2E_INCREMENTAL_WINDOW_HEAD_03';
        await route.fulfill({ contentType: 'application/json', body: geminiListGen(responseKey) });
    });
    const options = await openOptions(context, extensionId);
    await seedConversations(options, [{ id: 'retained', title: 'Retained', titleSource: 'user' }], {
        retained: { exportedAt: 100, format: 'markdown', status: 'ok' },
    });
    await options.click('#btnSyncAll');
    await expect(options.locator('body')).toHaveAttribute('data-scanning', 'false');
    await expect(options.locator('.tour-overlay-container')).toHaveCount(0);
    // Four committed source rows are below the v2 Takeout suggestion threshold (>150).
    expect(requests[0]).toEqual(['head', 'tC_middle', 'tC_limit']);
    await expect.poll(async () => (await v2(options)).coverage?.range?.head.time).toBe(1700000100000);

    for (round = 1; round <= 2; round++) {
        await options.click('#btnSyncAll');
        await expect.poll(async () => (await v2(options)).coverage?.range?.head.time).toBe(
            round === 1 ? 1700000120000 : 1700000130000);
        await expect(options.locator('body')).toHaveAttribute('data-scanning', 'false');
        const { coverage, indexes, retainedRecord, retained } = await v2(options);
        expect(requests[round], 'overlap with frozen history must avoid another provider page').toEqual(['head']);
        expect(coverage?.range?.tail.time).toBe(1700000070000);
        expect(Object.keys(coverage!)).toEqual(['range']);
        expect(JSON.stringify(coverage)).not.toContain('tC_');
        expect(indexes.some((row: { key: { conversationId: string } }) => row.key.conversationId === 'retained')).toBe(true);
        expect(retainedRecord?.status).toBe('ok');
        expect(retained?.detail.messages.length).toBeGreaterThan(0);
    }
});

test('passive non-head Gemini page adds v2 indexes but cannot fabricate trusted coverage', async ({ context, extensionId }) => {
    const gemini = await sourcePage(context);
    await gemini.route('**/batchexecute*', route => route.fulfill({
        contentType: 'application/json',
        body: geminiListPage(1).responseBody,
    }));
    const options = await openOptions(context, extensionId);
    await gemini.evaluate(async body => fetch('/_/BardChatUi/data/batchexecute', {
        method: 'POST', body: new URLSearchParams(body),
    }), geminiListPage(1).requestBody);
    await expect.poll(async () => (await v2(options)).indexes.length).toBe(20);
    // Passive Sniffer commits Index in the background; the Options read mirror
    // intentionally refreshes on focus, rather than subscribing to L2 writes.
    await options.bringToFront();
    await options.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(options.locator('[data-chat-id="0000000000000032"]')).toBeVisible();
    expect((await v2(options)).coverage).toEqual({ range: null });
});

test('a new complete disjoint recent scan replaces old v2 coverage and never requests pinned', async ({ context, extensionId }) => {
    const gemini = await sourcePage(context);
    let round = 0;
    const requests: string[][] = [[], []];
    // Active scan RPC is issued by the extension/provider, not the Gemini tab.
    // Observe requests in the BrowserContext (as the passing scan_flow E2E does).
    await context.route('**/batchexecute*', async route => {
        const args = JSON.parse(JSON.parse(new URLSearchParams(route.request().postData()!).get('f.req')!)[0][0][1]);
        expect(args[2][0]).toBe(0);
        const cursor = args[1];
        requests[round].push(cursor || 'head');
        const responseKey: Parameters<typeof geminiListGen>[0] =
            round === 0 ? 'G_E2E_INCREMENTAL_DISJOINT_HEAD_01'
                : cursor === null ? 'G_E2E_INCREMENTAL_DISJOINT_HEAD_02'
                    : 'G_E2E_INCREMENTAL_DISJOINT_TAIL_02';
        await route.fulfill({ contentType: 'application/json', body: geminiListGen(responseKey) });
    });
    const options = await openOptions(context, extensionId);
    await options.click('#btnSyncAll');
    await expect.poll(async () => (await v2(options)).coverage?.range?.tail.time).toBe(1700000070000);
    await expect(options.locator('body')).toHaveAttribute('data-scanning', 'false');
    round = 1;
    await options.click('#btnSyncAll');
    await expect.poll(async () => (await v2(options)).coverage?.range?.head.time).toBe(1700000150000);
    await expect(options.locator('body')).toHaveAttribute('data-scanning', 'false');
    const { coverage, indexes } = await v2(options);
    expect(coverage?.range?.tail.time).toBe(1700000120000);
    expect(requests[1]).toEqual(['head', 'tC_fresh']);
    expect(indexes).toHaveLength(6);
    await expect(options.locator('#list .item')).toHaveCount(6);
});

test('tutorial advances on committed rows while scan continues to the next provider page', async ({ context, extensionId }) => {
    await sourcePage(context);
    const requests: string[] = [];
    let releaseNextPage: (() => void) | undefined;
    const nextPage = new Promise<void>(resolve => { releaseNextPage = resolve; });
    await context.route('**/batchexecute*', async route => {
        const args = JSON.parse(JSON.parse(new URLSearchParams(route.request().postData()!).get('f.req')!)[0][0][1]);
        const cursor = args[1]; requests.push(cursor || 'head');
        if (cursor) await nextPage;
        const key = cursor === 'tC_limit' ? 'G_E2E_INCREMENTAL_WINDOW_LIMIT_01'
            : cursor ? 'G_E2E_INCREMENTAL_WINDOW_MIDDLE_01' : 'G_E2E_INCREMENTAL_WINDOW_HEAD_01';
        await route.fulfill({ contentType: 'application/json', body: geminiListGen(key) });
    });
    const options = await openOptions(context, extensionId);
    await options.locator('#btnTourGuide').click();
    await waitForAuthorization(options); await continueToScan(options);
    await options.locator('#btnSyncAll').click();
    try {
        await expect(options.locator('.tour-popover h2')).toHaveText('Select conversations');
        await expect(options.locator('body')).toHaveAttribute('data-busy', 'true');
        await expect(options.locator('#btnSyncAll')).toBeVisible();
        const saved = await v2(options);
        expect(saved.indexes.length).toBeGreaterThan(0);
        expect(saved.coverage?.range ?? null).toBeNull();
        await expect(options.locator('#list .item')).toHaveCount(saved.indexes.length);
        await options.locator('#list .item input').first().check();
        await expect(options.locator('.tour-popover h2')).toHaveText('Choose a format');
        await expect(options.locator('#btnExport')).toBeEnabled();
        await options.keyboard.press('Escape');
        // Cache a complete source snapshot; the export still uses real Application, storage and delivery.
        await options.evaluate(async accountId => {
            await Reflect.get(globalThis,'uiFixture').ingestDetail(accountId,'chat100',{
                savedAt:Date.now(),quality:{status:'complete'},assets:[],messages:[
                    {role:'user',content:[{type:'paragraph',children:[{type:'text',text:'Question during sync'}]}]},
                    {role:'assistant',content:[{type:'paragraph',children:[{type:'text',text:'Answer during sync'}]}]},
                ],
            });
        },accountId);
        await options.locator('#format').selectOption('json');
        const downloaded=options.waitForEvent('download');
        await options.locator('#btnExport').click();
        const file=await downloaded;
        const contents=await readFile((await file.path())!,'utf8');
        expect(contents).toContain('Answer during sync');
        expect(JSON.parse(contents).conversation.index.key.conversationId).toBe('chat100');
        await expect(options.locator('body')).toHaveAttribute('data-scanning','true');
        await expect(options.locator('#btnSyncAll')).toHaveText('Stop sync');
        await expect(options.locator('#status')).toContainText('Successfully downloaded');
    } finally { releaseNextPage?.(); }
    await expect(options.locator('body')).toHaveAttribute('data-busy', 'false');
    expect(requests).toEqual(['head', 'tC_middle', 'tC_limit']);
    await expect(options.locator('#list input:checked')).toHaveCount(1);
});
