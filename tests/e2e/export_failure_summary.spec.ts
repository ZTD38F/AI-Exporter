import { test, expect } from '@playwright/test';
import { A, mount, read } from '../helpers/uiPortHarness';
import { parseGeminiRpcConversation } from '../../src/l1/parsers/gemini/rpc/parseConversation';
import { detailGen } from '../fixtures/providers/geminiDetail';
import { fixtureAccount } from '../helpers/domainFixture';

test('attachment diagnostics stay recorded but are visible only in developer mode', async ({ page }) => {
    await mount(page, 'options', { holdExport: true });
    await page.locator('#btnSelectAll').click();
    await page.locator('#btnExport').click();
    await page.evaluate(() => {
        const h = Reflect.get(window, 'harness');
        for (const [stage, code] of [['resource', 'RESOURCE_DOWNLOAD_FAILED'], ['render', 'HTML_ASSET_UNRESOLVED']])
            h.exportOptions.onDiagnostic({ key: h.exports[0].keys[0], stage, code, severity: 'warning', message: code });
        h.finishExport();
    });
    await expect(page.locator('#exportFailureCard')).toBeHidden();
    await page.locator('#devToggle').check();
    await expect(page.locator('#exportFailureList > details')).toHaveCount(2);
    const downloaded = page.waitForEvent('download');
    await page.locator('#btnExportDiag').click();
    const filePath = await (await downloaded).path();
    if (!filePath) throw new Error('Diagnostic download missing');
    const { readFile } = await import('node:fs/promises');
    const report = JSON.parse(await readFile(filePath, 'utf8'));
    expect(report.exportRuns[0].diagnostics).toHaveLength(2);
    await page.locator('#devToggle').uncheck();
    await expect(page.locator('#exportFailureCard')).toBeHidden();
    await page.locator('#btnExport').click();
    await page.evaluate(() => {
        const h = Reflect.get(window, 'harness');
        h.failExport = true;
        h.finishExport();
    });
    await expect(page.locator('#exportFailureCard')).toBeVisible();
    await expect(page.locator('#exportFailureTitle')).toContainText('1 conversations failed');
});

test('100 failed conversations collapse into one group, copy the reason once, and retry only failures', async ({ page }) => {
    const indexes = Array.from({ length: 101 }, (_, i) => ({
        key: { accountId: A, conversationId: `chat-${i}` }, title: `Conversation ${i}`, updatedAt: 5,
    }));
    await mount(page, 'options', { indexes, failExport: true, partial: true });
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async (value: string) => { Reflect.set(window, 'copiedFailures', value); } } }));
    await page.locator('#btnSelectAll').click();
    await page.locator('#btnExport').click();
    await page.locator('#btnModalContinueZip').click();
    await expect(page.locator('#exportFailureTitle')).toHaveText('100 conversations failed · Issue groups: 1');
    await expect(page.locator('#exportFailureCard')).toHaveAttribute('data-severity', 'error');
    const groups = page.locator('#exportFailureList > details');
    await expect(groups).toHaveCount(1);
    await expect(groups.locator('summary')).toHaveText('File delivery failed · 100 conversations · 100 occurrences');
    await expect(groups).not.toHaveAttribute('open');
    await groups.locator('summary').click();
    await expect(groups).toContainText('Injected export failure');
    await expect(groups).toContainText('Conversation 100 (chat-100)');
    await expect(groups).not.toContainText('Conversation 0 (chat-0)');
    await page.locator('#btnCopyFailedLog').click();
    const copied = await page.evaluate(() => Reflect.get(window, 'copiedFailures'));
    expect(copied.split('Injected export failure').length - 1).toBe(1);
    expect(copied).toContain(`${A}/chat-100`);
    await page.locator('#langToggle').uncheck();
    await expect(page.locator('#exportFailureTitle')).toHaveText('100 条会话导出失败 · 1 组问题');
    await page.locator('#btnRetryFailed').click();
    const retry = (await read(page, 'exports'))[1];
    expect(retry.keys).toHaveLength(100);
    expect(retry.keys).not.toContainEqual(indexes[0].key);
    expect(retry.skipUnchanged).toBe(false);
});

test('error messages and conversation titles are rendered as text', async ({ page }) => {
    const message = '<img src=x onerror=alert(1)>';
    await mount(page, 'options', { failExport: true, exportError: message });
    await page.locator('#btnSelectAll').click();
    await page.locator('#btnExport').click();
    const group = page.locator('#exportFailureList > details');
    await expect(group).toHaveCount(1);
    await group.locator('summary').click();
    await expect(group).toContainText(message);
    await expect(group).toContainText(`${message} (a)`);
    await expect(page.locator('#exportFailureList img')).toHaveCount(0);
    await expect(page.locator('#list img')).toHaveCount(0);
});

test('partial exports aggregate warnings, preserve all counts beyond log limits, and export the groups', async ({ page }) => {
    await mount(page, 'options', { holdExport: true, partial: true });
    await page.locator('#devToggle').check();
    await page.locator('#btnSelectAll').click();
    await page.locator('#btnExport').click();
    await page.evaluate(() => {
        const h = Reflect.get(window, 'harness');
        const key = h.exports[0].keys[0];
        for (let i = 0; i < 10001; i++) h.exportOptions.onDiagnostic({ key, stage: 'resource', severity: 'warning',
            code: 'RESOURCE_PROCESSING_FAILED', message: `Resource ${i} rejected` });
        h.finishExport();
    });
    await expect(page.locator('#exportFailureTitle')).toHaveText('Export warnings · Issue groups: 1');
    await expect(page.locator('#exportFailureList summary')).toHaveText('Attachment could not be processed · 1 conversations · 10001 occurrences');
    await expect(page.locator('#btnRetryFailed')).toBeHidden();
    const downloaded = page.waitForEvent('download');
    await page.locator('#btnExportDiag').focus();
    await page.locator('#btnExportDiag').press('Enter');
    const file = await downloaded;
    const { readFile } = await import('node:fs/promises');
    const filePath = await file.path();
    expect(filePath).toBeTruthy();
    if (!filePath) throw new Error('Diagnostic download missing');
    const report = JSON.parse(await readFile(filePath, 'utf8'));
    expect(report.exportRuns[0].diagnostics).toHaveLength(10000);
    expect(report.exportRuns[0].droppedDiagnostics).toBe(1);
    expect(report.exportRuns[0].issues[0]).toMatchObject({ category: 'RESOURCE_PROCESSING_FAILED', severity: 'warning', occurrences: 10001 });
    expect(report.exportRuns[0].issues[0].conversations).toHaveLength(1);
});

for (const theme of ['light', 'dark'] as const) {
    test(`warnings use a warm notice and mixed failures stay red in ${theme} theme`, async ({ page }, testInfo) => {
        await mount(page, 'options', { holdExport: true, settings: { theme } });
        await page.locator('#btnSelectAll').click();
        await page.locator('#btnExport').click();
        const warn = async () => page.evaluate(() => {
            const h = Reflect.get(window, 'harness');
            h.exportOptions.onDiagnostic({ key: h.exports.at(-1).keys[0], stage: 'source_parse', severity: 'warning',
                code: 'GEMINI_STRUCTURED_FALLBACK', message: 'Native structured body unavailable; using Markdown fallback' });
        });
        await warn();
        await page.evaluate(() => Reflect.get(window, 'harness').finishExport());
        const card = page.locator('#exportFailureCard');
        const title = page.locator('#exportFailureTitle');
        await expect(page.locator('#btnExport')).toBeEnabled();
        await expect(card).toHaveAttribute('data-severity', 'warning');
        await expect(title).toHaveText('Export warnings · Issue groups: 1');
        await expect(title).toHaveCSS('color', theme === 'light' ? 'rgb(161, 98, 7)' : 'rgb(223, 183, 126)');
        await expect(page.locator('#btnRetryFailed')).toBeHidden();
        await expect(page.locator('#btnCopyFailedLog')).toHaveText('Copy Diagnostics');
        await page.locator('#langToggle').uncheck();
        await expect(title).toHaveText('导出警告 · 1 组提示');
        await expect(page.locator('#btnCopyFailedLog')).toHaveText('复制诊断');
        await card.screenshot({ path: testInfo.outputPath(`warning-${theme}.png`) });
        await page.locator('#langToggle').check();

        await page.locator('#btnExport').click();
        await warn();
        await page.evaluate(() => {
            const h = Reflect.get(window, 'harness');
            h.failExport = true;
            h.finishExport();
        });
        await expect(card).toHaveAttribute('data-severity', 'error');
        await expect(title).toHaveText('1 conversations failed · Issue groups: 2');
        await expect(title).toHaveCSS('color', theme === 'light' ? 'rgb(180, 35, 54)' : 'rgb(224, 139, 148)');
        await expect(page.locator('#btnRetryFailed')).toBeVisible();
        await expect(page.locator('#exportFailureList details[data-severity="warning"]')).toHaveCount(1);
        await expect(page.locator('#exportFailureList details[data-severity="error"]')).toHaveCount(1);
        await card.screenshot({ path: testInfo.outputPath(`mixed-${theme}.png`) });
    });
}

test('preflight folder authorization is a status prompt, not a batch failure', async ({ page }) => {
    await mount(page, 'options', { settings: { exportDelivery: 'folderWriter' } });
    await page.locator('#btnSelectAll').click();
    await page.locator('#btnExport').click();
    await expect(page.locator('#status')).toHaveText('Authorize a folder first');
    await expect(page.locator('#exportFailureCard')).toBeHidden();
    expect(await read(page, 'exports')).toHaveLength(0);
});

test('diagnostic download preserves native rejection evidence for offline replay', async ({ page }) => {
    const parsed = parseGeminiRpcConversation(detailGen('G_STRUCTURED_COVERAGE_02'),
        { account: fixtureAccount('gemini'), providerId: 'gemini' });
    const diagnostic = parsed.diagnostics.find(item => item.code === 'GEMINI_STRUCTURED_FALLBACK');
    if (!diagnostic) throw new Error('Fixture must produce a native rejection');
    await mount(page, 'options', { holdExport: true });
    await page.locator('#devToggle').check();
    await page.locator('#btnSelectAll').click();
    await page.locator('#btnExport').click();
    await page.evaluate(diagnosticJson => {
        const h = Reflect.get(window, 'harness');
        h.exportOptions.onDiagnostic({ ...JSON.parse(diagnosticJson), key: h.exports[0].keys[0], stage: 'source_parse' });
        h.finishExport();
    }, JSON.stringify(diagnostic));
    await expect(page.locator('#exportFailureList summary')).toContainText('Some source content required fallback parsing');
    const downloaded = page.waitForEvent('download');
    await page.locator('#btnExportDiag').focus();
    await page.locator('#btnExportDiag').press('Enter');
    const filePath = await (await downloaded).path();
    if (!filePath) throw new Error('Diagnostic download missing');
    const { readFile } = await import('node:fs/promises');
    const report = JSON.parse(await readFile(filePath, 'utf8'));
    expect(report.exportRuns[0].diagnostics[0].details).toEqual(diagnostic.details);
    expect(report.exportRuns[0].issues[0].diagnostic.details).toEqual(diagnostic.details);
    expect(JSON.stringify(report)).toContain('PRIVATE_SOURCE_TEXT');
});
