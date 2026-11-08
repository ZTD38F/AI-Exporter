import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mount, A, B } from './helpers/uiPortHarness.js';

test('Options refreshes accepted current-account Index facts on focus without legacy syncUpdate IPC', async () => {
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true }); try {
        const page = await browser.newPage(); await mount(page, 'options'); await page.locator('#list .item').waitFor();
        await page.evaluate(({ A, B }) => { const h = Reflect.get(window, 'harness');
            h.indexes.push({ key: { accountId: A, conversationId: 'fresh' }, title: 'Accepted current account', updatedAt: 10 },
                { key: { accountId: B, conversationId: 'foreign' }, title: 'Other account', updatedAt: 20 });
            window.dispatchEvent(new Event('focus'));
        }, { A, B });
        await page.locator('[data-chat-id=fresh]').waitFor(); assert.equal(await page.locator('[data-chat-id=foreign]').count(), 0);
        assert.equal(await page.locator('#list .item').count(), 2);
    } finally { await browser.close(); }
});
