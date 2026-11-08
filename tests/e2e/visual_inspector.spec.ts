import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, seedConversations, accountId, exposeUIStorage } from './uiFixture';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Visual integration exercises the shipped Options UI, real L2 admission and
 * L3a IndexedDB. It does not re-create retired v1 storage or Tour controls.
 * Screenshots remain diagnostic; the assertions use geometry/hit testing.
 */
test.beforeEach(async ({ context }) => { await seedRegistryAccounts(context); });
const outputDir = path.resolve(__dirname, '../../tests/output/visual_audit');
const steps = [
    ['Authorize AI platforms', 'header h1'],
    ['Switch platforms and accounts', '#accountIdSelect'],
    ['Scan conversations', '#btnSyncAll'],
    ['Select conversations', '#list .item'],
    ['Choose a format', '#format'],
    ['Export selected conversations', '#btnExport'],
    ['Live Save', '#liveSaveControls'],
    ['Optional feedback', '#feedbackBox'],
] as const;
test.beforeAll(() => { fs.mkdirSync(outputDir, { recursive: true }); });

async function workbench(context: import('@playwright/test').BrowserContext, extensionId: string) {
    const page = await openOptions(context, extensionId);
    await page.setViewportSize({ width: 1280, height: 800 });
    return page;
}
async function refresh(page: import('@playwright/test').Page) {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}
async function index(page: import('@playwright/test').Page, id: string) {
    return page.evaluate(async ({ accountId, id }) =>
        Reflect.get(globalThis, 'uiFixture').getIndex({ accountId, conversationId: id }), { accountId, id });
}
async function ingestIndex(page: import('@playwright/test').Page, id: string,
    title: string, source: 'derived' | 'provider' | 'user', updatedAt: number) {
    await page.evaluate(async ({ accountId, id, title, source, updatedAt }) =>
        Reflect.get(globalThis, 'uiFixture').ingestIndexes(accountId, [
            { conversationId: id, fields: { title, titleSource: source, updatedAt } },
        ]), { accountId, id, title, source, updatedAt });
    await refresh(page);
}
async function screenshot(page: import('@playwright/test').Page, name: string) {
    const dest = path.join(outputDir, name);
    await page.screenshot({ path: dest });
    expect(fs.existsSync(dest)).toBe(true);
}
/** Gemini is authorized in the real fixture, so the tour never requests it again. */
async function connectTourGemini(page: import('@playwright/test').Page, finishAccounts = true) {
    // Geometry fixtures have stored accounts but no provider tab. Supply the
    // Content identity response that the connection lesson now verifies.
    await page.evaluate(accountId => {
        Object.defineProperty(chrome.tabs, 'query', { configurable: true, value: async () => [
            { id: 999, url: 'https://gemini.google.com/app/fixture' },
        ] });
        Object.defineProperty(chrome.tabs, 'sendMessage', { configurable: true,
            value: (_tabId: number, _message: unknown, callback: (reply: { ok: boolean; accountContext: { accountId: string; providerId: string } }) => void) => {
                callback({ ok: true, accountContext: { accountId, providerId: 'gemini' } });
            } });
    }, accountId);
    await expect(page.locator('.platform-permission-row[data-platform="gemini"]')).toBeHidden();
    await expect(page.locator('#tourNextBtn')).toBeEnabled();
    await page.locator('#tourNextBtn').click();
    await page.locator('#btnDetectAccount:enabled').click();
    await expect(page.locator('.tour-popover h2')).toHaveText('Switch platforms and accounts');
    if (finishAccounts) {
        await page.locator('#tourNextBtn').click();
        await expect(page.locator('.tour-popover h2')).toHaveText('Scan conversations');
    }
}

async function verifyPopoverGeometry(page: import('@playwright/test').Page, target: string, action: string) {
    // Restored Tour cards animate after footer/status relayout. Assert the
    // eventual geometry rather than sampling a button mid-transition offscreen.
    await expect.poll(async () => page.evaluate(({ target, action }) => {
        const popover = document.querySelector('.tour-popover') as HTMLElement | null;
        const anchor = document.querySelector(target) as HTMLElement | null;
        const button = [...(popover?.querySelectorAll('button') ?? [])].find(b => b.textContent?.trim() === action);
        if (!popover || !anchor || !button) return { present: false, clear: false, hittable: false };
        const p = popover.getBoundingClientRect(), a = anchor.getBoundingClientRect();
        const clear = p.right <= a.left || p.left >= a.right || p.bottom <= a.top || p.top >= a.bottom;
        const b = button.getBoundingClientRect(), hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        const hittable = hit === button || !!button.contains(hit);
        return { present: true, clear, hittable };
    }, { target, action })).toEqual({ present: true, clear: true, hittable: true });
}

for (const theme of ['dark', 'light']) {
 test(`the real eight-step v2 Tour has rounded cutouts without target collisions in ${theme} theme`, async ({ context, extensionId }) => {
    const page = await workbench(context, extensionId);
    await page.evaluate(async theme => Reflect.get(globalThis, 'uiFixture').updateSettings({ theme }), theme);
    await seedConversations(page, [
        { id: 'tour-a', title: 'Conversation selected for export', updatedAt: 200 },
        { id: 'tour-b', title: 'Another conversation', updatedAt: 100 },
    ]);
    await page.locator('#btnTourGuide').click();
    for (const [i, [title, target]] of steps.entries()) {
        await expect(page.locator('.tour-popover h2')).toHaveText(title);
        const action = i === 0 ? 'Authorize' : i === steps.length - 1 ? 'Start using' : 'Next';
        await verifyPopoverGeometry(page, target, action);
        if (i === steps.length - 1) await expect(page.locator('#tourSkipBtn')).toHaveCount(0);
        await screenshot(page, 'v2_tour_' + theme + '_step_' + (i + 1) + '.png');
        if (i === 0) {
            await expect(page.locator('#tourNextBtn')).toBeEnabled();
            await connectTourGemini(page, false);
        } else await page.getByRole('button', { name: action, exact: true }).click();
    }
    await expect(page.locator('.tour-overlay-container')).toHaveCount(0);
});

}

test('choosing PDF in the v2 Tour advances without querying local fonts', async ({ context, extensionId }) => {
    const page = await workbench(context, extensionId);
    await page.evaluate(() => {
        (window as any).__fontQueries = 0;
        (window as any).queryLocalFonts = async () => {
            (window as any).__fontQueries++;
            return [];
        };
    });
    await page.locator('#btnTourGuide').click();
    await connectTourGemini(page);
    for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.locator('.tour-popover h2')).toHaveText('Choose a format');
    await page.locator('#format').selectOption('pdf');
    await expect(page.locator('.tour-popover h2')).toHaveText('Export selected conversations');
    await expect(page.locator('#format')).toHaveValue('pdf');
    expect(await page.evaluate(() => (window as any).__fontQueries)).toBe(0);
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
});

test('manual Tour opens and closes without obsolete v1 tour-state persistence', async ({ context, extensionId }) => {
    const page = await workbench(context, extensionId);
    const original = await page.evaluate(async () => Reflect.get(globalThis, 'uiFixture').getSettings());
    await page.locator('#btnTourGuide').click();
    await expect(page.locator('.tour-popover h2')).toHaveText('Authorize AI platforms');
    await page.locator('#tourCloseBtn').click();
    await expect(page.locator('.tour-overlay-container')).toHaveCount(0);
    expect(await page.evaluate(async () => Reflect.get(globalThis, 'uiFixture').getSettings())).toEqual(original);
    await page.locator('#btnTourGuide').click();
    await expect(page.locator('.tour-popover')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.tour-popover')).toHaveCount(0);
});

test('Gemini-only upgrade shows the compatible 2.0 notice rather than unavailable platforms', async ({ context, extensionId }) => {
    const page = await workbench(context, extensionId);
    await page.evaluate(async () => Reflect.get(globalThis, 'uiFixture').updateSettings({ lastSeenFeatureVersion: '1.4.0' }));
    await page.reload(); await exposeUIStorage(page);
    await expect(page.locator('body')).toHaveAttribute('data-busy', 'false');
    await expect(page.locator('.tour-popover h2')).toHaveText('Gemini Exporter 2.0 is Here!');
    await expect.poll(async () => (await page.evaluate(async () =>
        Reflect.get(globalThis, 'uiFixture').getSettings())).lastSeenFeatureVersion).toBe('2.0.0');
    await page.locator('#tourUpgradeDismissBtn').click();
    await page.reload(); await exposeUIStorage(page);
    await expect(page.locator('.tour-popover')).toHaveCount(0);
    await page.locator('#btnTourGuide').click();
    await expect(page.locator('.tour-popover h2')).toHaveText('Authorize AI platforms');
    await page.locator('#tourCloseBtn').click();
});

test('Tour backdrop actually intercepts off-target clicks and does not click through to the workbench', async ({ context, extensionId }) => {
    const page = await workbench(context, extensionId);
    await page.locator('#btnTourGuide').click();
    const area = await page.evaluate(() => {
        const panels = [...document.querySelectorAll<HTMLElement>('.tour-backdrop')];
        for (const panel of panels) {
            const r = panel.getBoundingClientRect();
            if (r.width <= 50 || r.height <= 50) continue;
            // The initial connection step centers its card over a full-screen backdrop.
            // Sample the edges as well as the center so we click the exposed backdrop.
            for (const [px, py] of [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) {
                const x = r.left + r.width * px, y = r.top + r.height * py;
                const hit = document.elementFromPoint(x, y);
                if (hit === panel || panel.contains(hit)) return { x, y, visible: true };
            }
        }
        return { x: 0, y: 0, visible: false };
    });
    expect(area.visible).toBe(true);
    await screenshot(page, 'v2_tour_backdrop.png');
    await page.mouse.click(area.x, area.y);
    await expect(page.locator('.tour-popover')).toHaveCount(1);
    await page.locator('#tourCloseBtn').click();
    await expect(page.locator('.tour-popover')).toHaveCount(0);
    await expect(page.locator('#btnTourGuide')).toBeVisible();
    expect(await page.evaluate(async () =>
        Object.keys(await Reflect.get(globalThis, 'uiFixture').listExportRecords('10000000-0000-4000-8000-000000000001')).length)).toBe(0);
});

test('real v2 workbench action controls are visible without clipped button text', async ({ context, extensionId }) => {
    const page = await workbench(context, extensionId);
    for (const id of ['btnSelectAll', 'btnExport', 'btnSyncAll']) await expect(page.locator('#' + id)).toBeVisible();
    const overflow = await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('button')]
        .filter(button => button.getClientRects().length && button.clientWidth > 0 && button.scrollWidth > button.clientWidth + 2)
        .map(button => ({ id: button.id, text: button.textContent?.trim(), width: button.clientWidth, scroll: button.scrollWidth })));
    expect(overflow).toEqual([]);
    await screenshot(page, 'v2_workbench_layout.png');
});

test('v2 L2 Index advancement reorders visible conversations and promoted row remains physically clickable', async ({ context, extensionId }) => {
    const page = await workbench(context, extensionId);
    const now = Date.now();
    await seedConversations(page, [
        { id: 'top_active_999', title: '首位活跃新对话', updatedAt: now - 5000 },
        { id: 'historical_old_111', title: '待追加对话的老会话', updatedAt: now - 80000 },
        { id: 'historical_old_222', title: '末尾静止老会话', updatedAt: now - 180000 },
    ]);
    await expect(page.locator('#list .item').nth(0)).toContainText('首位活跃新对话');
    await ingestIndex(page, 'historical_old_111', '待追加对话的老会话', 'provider', now + 50000);
    await expect(page.locator('#list .item').nth(0)).toContainText('待追加对话的老会话');
    await expect(page.locator('#list .item').nth(1)).toContainText('首位活跃新对话');
    expect((await index(page, 'historical_old_111'))?.updatedAt).toBe(now + 50000);
    const first = page.locator('#list .item').first();
    const rect = await first.boundingBox();
    expect(rect).not.toBeNull();
    const hit = await page.evaluate(({ x, y }) => {
        const firstRow = document.querySelector('#list .item');
        const top = document.elementFromPoint(x, y);
        return !!firstRow && !!top && (firstRow === top || firstRow.contains(top));
    }, { x: rect!.x + rect!.width / 2, y: rect!.y + rect!.height / 2 });
    expect(hit).toBe(true);
    await screenshot(page, 'v2_chat_promoted.png');
});

test('confirmed v2 deletion removes only the selected row and keeps remaining layout contiguous', async ({ context, extensionId }) => {
    const page = await workbench(context, extensionId);
    await seedConversations(page, [
        { id: 'del_eph_9999', title: 'Delete target', updatedAt: 300 },
        { id: 'keep_chat_111', title: '留存会话 1', updatedAt: 200 },
        { id: 'keep_chat_222', title: '留存会话 2', updatedAt: 100 },
    ], { del_eph_9999: { format: 'markdown', status: 'ok', exportedAt: 400 } });
    await expect(page.locator('#list .item')).toHaveCount(3);
    await page.evaluate(async accountId => Reflect.get(globalThis, 'uiFixture').ingestDeletedConversation(accountId, 'del_eph_9999'), accountId);
    await refresh(page);
    await expect(page.locator('#list .item')).toHaveCount(2);
    await expect(page.locator('[data-chat-id="del_eph_9999"], .cloud-status, #archiveNotice')).toHaveCount(0);
    expect(await page.evaluate(async accountId => Reflect.get(globalThis, 'uiFixture').getExportRecord({
        accountId, conversationId: 'del_eph_9999',
    }), accountId)).toBeNull();
    await expect(page.locator('[data-chat-id="keep_chat_111"]')).toBeVisible();
    const gap = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#list .item')];
        if (rows.length !== 2) return NaN;
        const top = rows[0].getBoundingClientRect(), next = rows[1].getBoundingClientRect();
        return next.top - top.bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(16);
    await screenshot(page, 'v2_deleted_chat_pruned.png');
});

test('v2 provider title upgrades a derived offline title in the real workbench without a legacy title history', async ({ context, extensionId }) => {
    const page = await workbench(context, extensionId);
    const id = '1bd028d5c5b0c0e2';
    await seedConversations(page, [{ id, title: '火星宇航员猫咪（离线提问前缀）', titleSource: 'derived', updatedAt: 1680000000000 }]);
    await expect(page.locator('[data-chat-id="' + id + '"]')).toContainText('火星宇航员猫咪（离线提问前缀）');
    await ingestIndex(page, id, '火星宇航员猫咪（AI 生成图片 Imagen）', 'provider', 1700000000000);
    await expect(page.locator('[data-chat-id="' + id + '"]')).toContainText('火星宇航员猫咪（AI 生成图片 Imagen）');
    const stored = await index(page, id);
    expect(stored?.titleSource).toBe('provider');
    expect(stored).not.toHaveProperty('titles');
    await screenshot(page, 'v2_offline_title_upgraded.png');
});
