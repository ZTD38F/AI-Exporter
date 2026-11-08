import { geminiListPage } from '../fixtures/providers/geminiListCapture.js';
/** Deterministic counterexamples from the 2026-10-21 Luna rerun.
 * These checks reproduce the original failures on the pre-fix revision.
 */
import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, seedConversations, accountId } from './uiFixture';
import { extractPdfText } from '../helpers/pdfTextExtract';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import type { BrowserContext } from '@playwright/test';

async function attachLoggedInGemini(context: BrowserContext) {
    await context.route('https://gemini.google.com/**', route => route.fulfill({
        contentType: 'text/html', body: `<!doctype html><script>
            window.WIZ_global_data = { qDCSke: '10000000001', SNlM0e: 'fixture_token',
                cfb2h: 'boq_assistant-bard-web-server_20260802.09_p1' };
            </script><button aria-label="Google Account: Fixture (fixture@example.test)">Fixture</button>`,
    }));
    await context.route('**/batchexecute*', route => route.fulfill({
        contentType: 'application/json', body: geminiListPage(22).responseBody,
    }));
    const gemini = await context.newPage();
    await gemini.goto('https://gemini.google.com/app');
    await expect(gemini.locator('#geminiExportBadge')).toBeVisible();
    return gemini;
}
test.beforeEach(async ({ context, extensionId }) => {
    void extensionId;
    await seedRegistryAccounts(context);
});

test('PDF retains bilingual text when Local Font Access is denied', async ({ context, extensionId }, info) => {
    test.setTimeout(120000);
    const page = await openOptions(context, extensionId);
    const chinese = '驻波边界条件与频谱分析';
    await seedConversations(page, [{ id: 'bilingual', title: 'Bilingual font regression',
        question: 'Explain the boundary conditions in English and Chinese.',
        body: `English: fixed endpoints. 中文：${chinese}。` }]);
    await page.evaluate(() => {
        Reflect.set(window, 'queryLocalFonts', async () => {
            throw new DOMException('User denied Local Font Access', 'NotAllowedError');
        });
    });
    await page.locator('#format').selectOption('pdf');
    await page.locator('#btnSelectAll').click();
    const pending = page.waitForEvent('download', { timeout: 90000 });
    await page.locator('#btnExport').click();
    const download = await pending;
    const bytes = await readFile((await download.path())!);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const extracted = extractPdfText(bytes);
    expect(extracted.text).toContain('fixed endpoints');
    const artifact = info.outputPath('bilingual.pdf');
    await writeFile(artifact, bytes);
    await info.attach('bilingual.pdf', { path: artifact, contentType: 'application/pdf' });
    await info.attach('pdf-text.txt', { body: extracted.text, contentType: 'text/plain' });
    expect(extracted.text).toContain(chinese);
});

test('connection error clears when committed conversations become visible without reload', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
    await page.locator('#btnSyncAll').click();
    const status = page.locator('#scanStatus');
    await expect(status).toContainText('Open Gemini, log in and refresh the page before scanning.');
    await expect(page.locator('body')).toHaveAttribute('data-busy', 'false');
    await attachLoggedInGemini(context);
    // Model the real passive commit after Gemini attaches; do not reload Options.
    await page.evaluate(async accountId => {
        await Reflect.get(globalThis, 'uiFixture').ingestDetail(accountId, 'attached', {
            quality: { status: 'complete' }, assets: [], messages: [],
        }, { title: 'Captured after connecting', titleSource: 'provider', updatedAt: 100 });
        window.dispatchEvent(new Event('focus'));
    }, accountId);
    await expect(page.locator('#list .item')).toHaveCount(1);
    await expect(page.locator('#selectedStat')).toHaveText('0 of 1 selected');
    await expect(status).not.toContainText('Open Gemini, log in and refresh the page before scanning.', { timeout: 2000 });
});

test('opening logged-in Gemini after Options allows scanning without reloading either page', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
    await expect(page.locator('#list .item')).toHaveCount(0);
    await page.locator('#btnSyncAll').click();
    await expect(page.locator('#scanStatus')).toContainText('Open Gemini, log in and refresh the page before scanning.');
    await expect(page.locator('body')).toHaveAttribute('data-busy', 'false');
    // Badge presence is an observable content-script readiness signal, not a sleep.
    await expect(page.locator('.tour-popover h2')).toHaveText('Connect Gemini account');
    await attachLoggedInGemini(context);
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByRole('button', { name: 'Continue sync', exact: true }).click();
    await expect(page.locator('[data-chat-id="0000000000000452"]')).toContainText('Captured conversation 0452');
    await expect(page.locator('body')).toHaveAttribute('data-busy', 'false');
    await expect(page.locator('#scanStatus')).not.toContainText('Open Gemini, log in and refresh the page before scanning.');
});

test('local records alone do not dismiss missing Gemini source guidance', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
    await page.locator('#btnSyncAll').click();
    await expect(page.locator('#scanStatus')).toContainText('Open Gemini, log in and refresh the page before scanning.');
    await expect(page.locator('body')).toHaveAttribute('data-busy', 'false');
    await page.evaluate(async accountId => {
        await Reflect.get(globalThis, 'uiFixture').ingestDetail(accountId, 'offline', {
            quality: { status: 'complete' }, assets: [], messages: [],
        }, { title: 'Offline import', titleSource: 'derived' });
        window.dispatchEvent(new Event('focus'));
    }, accountId);
    await expect(page.locator('#list .item')).toHaveCount(1);
    await expect(page.locator('#scanStatus')).toContainText('Open Gemini, log in and refresh the page before scanning.');
});

test('characterization: search hides a selected row but export still includes that row', async ({ context, extensionId }, info) => {
    const page = await openOptions(context, extensionId);
    await seedConversations(page, [{ id: 'wetland', title: 'Wetland' }, { id: 'monochord', title: 'Monochord' }]);
    await page.locator('[data-chat-id="wetland"] input').check();
    await page.locator('#chatSearchInput').fill('Monochord');
    await expect(page.locator('#list .item')).toHaveCount(1);
    await expect(page.locator('#list input')).not.toBeChecked();
    await expect(page.locator('#selectedStat')).toHaveText('1 of 2 selected');
    await info.attach('hidden-selection.png', { body: await page.screenshot(), contentType: 'image/png' });
    const pending = page.waitForEvent('download');
    await page.locator('#btnExport').click();
    const file = await pending;
    expect(file.suggestedFilename()).toMatch(/\.md$/);
    const body = await readFile((await file.path())!, 'utf8');
    expect(body).toContain('Answer wetland');
    expect(body).not.toContain('Answer monochord');
    // This captures the UX risk, not a decision to clear selection on search.
});

test('conversation arrow opens the requested conversation in a new tab', async ({ context, extensionId }) => {
    await context.route('https://gemini.google.com/**', route => route.fulfill({
        contentType: 'text/html', body: '<h1>Gemini destination fixture</h1>',
    }));
    const page = await openOptions(context, extensionId);
    await seedConversations(page, [{ id: '0123456789abcdef', title: 'Open this conversation' }]);
    const pending = context.waitForEvent('page');
    await page.locator('.open-link').click();
    const destination = await pending;
    await expect(destination).toHaveURL('https://gemini.google.com/app/0123456789abcdef');
    await expect(page.locator('#list input')).not.toBeChecked();
    // Clicking the title selects a row; it is not the external navigation control.
    await page.locator('.chat-title').click();
    await expect(page.locator('#list input')).toBeChecked();
});

test('visual ui_idle busy probe recognizes an active Options scan', async ({ context, extensionId }) => {
    // Obtain the exact expression executed by the Python action, then run it
    // against a real browser DOM. No hand-copied selector/probe implementation.
    const expression = execFileSync('python3', ['-c', `
import json
from scripts.framework.pipeline.actions import AssertIdleAction
class Capture:
    def eval(self, expression):
        print(json.dumps(expression))
        return False
AssertIdleAction(max_wait=1).execute(None, Capture())
`], { encoding: 'utf8' }).trim();
    const page = await openOptions(context, extensionId);
    const probe: string = JSON.parse(expression);
    expect(await page.evaluate(probe)).toBe(false);
    // Reconstruct the public UI state observed while scan RPCs are outstanding.
    await page.evaluate(() => {
        document.body.dataset.busy = 'true';
        (document.getElementById('btnSyncAll') as HTMLButtonElement).disabled = true;
        document.getElementById('progWrap')!.style.display = 'block';
    });
    await expect(page.locator('body')).toHaveAttribute('data-busy', 'true');
    await expect(page.locator('#btnSyncAll')).toBeDisabled();
    expect(await page.evaluate(probe)).toBe(true);
});

test('cancelled directory selection has readable feedback which clears when a scan starts', async ({ context, extensionId }) => {
    await attachLoggedInGemini(context);
    const page = await openOptions(context, extensionId);
    await page.evaluate(() => {
        Reflect.set(window, 'showDirectoryPicker', async () => {
            throw new DOMException("Failed to execute 'showDirectoryPicker' on 'Window': The user aborted a request.", 'AbortError');
        });
    });
    await page.locator('input[name="delivery"][value="folderWriter"]').check();
    await page.locator('#btnSetDir').click();
    await expect(page.locator('#status')).toContainText('Operation cancelled');
    await expect(page.locator('#status')).not.toContainText('showDirectoryPicker');
    await expect(page.locator('#log')).toContainText('showDirectoryPicker');
    await page.locator('#btnSyncAll').click();
    await expect(page.locator('#status')).not.toContainText('Operation cancelled');
});
