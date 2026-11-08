import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { readFileSync } from 'node:fs';
import { mount, read } from './helpers/uiPortHarness.js';
import { UI_COPY } from '../src/ui/shared/legacyLabels.js';
let browser: Browser, page: Page;
before(async () => { browser = await chromium.launch({ chromiumSandbox: true, headless: true }); });
afterEach(async () => { await page?.close(); }); after(async () => { await browser?.close(); });
async function open(kind: 'options' | 'popup' = 'options') { page = await browser.newPage(); await mount(page, kind); await page.locator(kind === 'options' ? '#accountIdSelect' : '#currentChatTitle').waitFor(); }

test('i18n - every current inline UI label has nonempty English and Chinese text', async () => {
    for (const kind of ['options', 'popup'] as const) {
        await open(kind);
        const labels = await page.locator('[data-en], [data-zh]').evaluateAll(nodes => nodes.map(node => [node.getAttribute('data-en'), node.getAttribute('data-zh')]));
        const keys = await page.locator('[data-i18n]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-i18n')!));
        assert.ok(labels.length + keys.length > 0);
        const en = new Map(Object.entries(UI_COPY.en)), zh = new Map(Object.entries(UI_COPY.zh));
        for (const key of keys) labels.push([en.get(key) ?? null, zh.get(key) ?? null]);
        for (const pair of labels) assert.ok(pair.every(text => typeof text === 'string' && text.length > 0), JSON.stringify(pair));
        await page.close();
    }
});
test('i18n - all declared inline labels render their selected language', async () => {
    await open(); await page.locator('#langToggle').setChecked(false); await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    const labels = await page.locator('[data-en][data-zh]').evaluateAll(nodes => nodes.map(node => [node.textContent, node.getAttribute('data-zh')]));
    for (const [actual, expected] of labels) assert.equal(actual, expected);
});
test('i18n - visible current controls have accessible names, including search and account selectors', async () => {
    await open(); assert.equal(await page.locator('#chatSearchInput').getAttribute('aria-label'), 'Search title or ID');
    assert.equal(await page.locator('#accountIdSelect').getAttribute('aria-label'), 'Account');
    for (const button of await page.locator('button:visible').all()) assert.ok((await button.textContent())?.trim());
});
test('i18n - parametric scan counts render through the selected UI language', async () => {
    await open(); await page.locator('#langToggle').setChecked(false); await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    await page.evaluate(() => { Reflect.get(window, 'harness').holdScan = true; }); await page.locator('#btnSyncAll').click();
    await page.waitForFunction(() => document.getElementById('scanStatus')?.textContent === '已接纳 2 页、150 条来源记录');
    await page.evaluate(() => Reflect.get(window, 'harness').finishScan());
});
test('i18n - Settings observer handles local changes and removes its listener on cleanup', async () => {
    await open();
    const calls = await page.evaluate(() => {
        const settings = Reflect.get(window, 'testUi').settings, h = Reflect.get(window, 'harness'); let count = 0;
        const stop = settings.observeSettings(() => count++); h.fireSettingsChange('sync'); assertCount(0);
        h.fireSettingsChange('local', 'unrelated_key'); assertCount(0);
        h.fireSettingsChange('local'); assertCount(1);
        h.fireSettingsChange('local', 'gemini_suppress_direct_write_prompt'); assertCount(2);
        stop(); h.fireSettingsChange('local'); return count;
        function assertCount(expected: number) { if (count !== expected) throw Error('Unexpected observer calls'); }
    }); assert.equal(calls, 2);
});
test('i18n - inline language attributes are not duplicated within a source element', () => {
    for (const kind of ['options', 'popup']) {
        const source = readFileSync(`src/ui/${kind}/${kind}.html`, 'utf8');
        for (const tag of source.match(/<[^>]+>/g) ?? []) for (const attr of ['data-en', 'data-zh']) assert.ok((tag.match(new RegExp(`\\b${attr}=`, 'g')) ?? []).length <= 1, tag);
    }
});
test('i18n - current labels recover when switching back from Chinese to English', async () => {
    await open(); await page.locator('#langToggle').setChecked(false); await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    await page.locator('#langToggle').setChecked(true); await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await page.locator('#btnSyncAll').textContent(), 'Sync All'); assert.equal(await page.locator('#btnSelectAll').getAttribute('aria-label'), 'Select all visible conversations');
});
test('i18n - labelPage translates descendants as text without interpreting translation markup', async () => {
    await open(); const result = await page.evaluate(() => {
        const root = document.createElement('div'), child = document.createElement('span');
        root.dataset.en = '<img src=x onerror=alert(1)>'; root.dataset.zh = '安全'; child.dataset.en = 'Child'; child.dataset.zh = '子元素';
        // Root and descendant are separate entries. Root text replacement must never execute HTML.
        document.body.append(root, child); Reflect.get(window, 'testUi').settings.labelPage();
        return { text: root.textContent, child: child.textContent, images: root.querySelectorAll('img').length };
    }); assert.deepEqual(result, { text: '<img src=x onerror=alert(1)>', child: 'Child', images: 0 });
});
test('i18n - undeclared prototype keys cannot become labels, translations or scan handlers', async () => {
    await open();
    const keys = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    const labels = await page.evaluate(keys => {
        const settings = Reflect.get(window, 'testUi').settings;
        const nodes = keys.map(key => {
            const node = document.createElement('input');
            node.textContent = 'original'; node.title = 'original'; node.placeholder = 'original';
            node.setAttribute('aria-label', 'original');
            node.dataset.i18n = key; node.dataset.i18nTitle = key;
            node.dataset.i18nPlaceholder = key; node.dataset.i18nAriaLabel = key;
            document.body.append(node); return node;
        });
        settings.labelPage();
        return nodes.map(node => [node.textContent, node.title, node.placeholder, node.getAttribute('aria-label')]);
    }, keys);
    assert.deepEqual(labels, keys.map(() => ['original', 'original', 'original', 'original']));
    await page.locator('#langToggle').setChecked(false);
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    const errors = await page.evaluate(keys => keys.map(key => Reflect.get(window, 'testUi').settings.errorText(new Error(key))), keys);
    assert.deepEqual(errors, keys.map(() => '操作失败，请重试；详情请查看日志或诊断报告。'));
    for (const reason of keys) {
        await page.evaluate(reason => { Reflect.get(window, 'harness').scanResult = {
            status: 'error', reason, pagesFetched: 0, conversationsFetched: 0,
        }; }, reason);
        await page.locator('#btnSyncAll').click();
        await page.waitForFunction(() => document.body.dataset.busy !== 'true');
        assert.equal(await page.locator('#scanStatus').textContent(), '扫描失败 · 0 / 0');
    }
});
test('i18n - language selector updates the single Settings owner and document language', async () => {
    await open(); await page.locator('#langToggle').setChecked(false); await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    assert.ok((await read(page, 'patches')).some((patch: { language?: string }) => patch.language === 'zh'));
    assert.equal(await page.locator('#langToggle').isChecked(), false);
});
test('i18n - business Settings stays independent from DOM translation and document labeling', () => {
    const source = readFileSync('src/application/settings/index.ts', 'utf8');
    assert.doesNotMatch(source, /\b(?:document|HTMLElement|querySelector|createElement|navigator)\b/);
    assert.match(readFileSync('src/ui/shared/settings.ts', 'utf8'), /export function labelPage/);
});

test('i18n - static tooltips and accessible group labels switch with the workbench language', async () => {
    await open();
    assert.equal(await page.locator('#devModeWrapper').getAttribute('title'), 'Show developer diagnostics and advanced controls');
    assert.equal(await page.locator('#btnClearExported').getAttribute('title'), 'Clear export records only; keep conversations and downloaded files');
    assert.equal(await page.locator('#localDataControls').getAttribute('aria-label'), 'Local records');
    await page.locator('#langToggle').setChecked(false);
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    assert.equal(await page.locator('#devModeWrapper').getAttribute('title'), '显示开发者诊断及高级选项');
    assert.equal(await page.locator('#btnClearScan').getAttribute('title'), '清除该账号的本地对话、扫描覆盖和导出记录；保留已下载的文件');
    assert.equal(await page.locator('#localDataControls').getAttribute('aria-label'), '本地记录');
    await page.locator('#langToggle').setChecked(true);
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await page.locator('#localDataControls').getAttribute('aria-label'), 'Local records');
});

test('i18n - current scan progress and result switch languages, historical log messages do not', async () => {
    await open();
    await page.evaluate(() => { Reflect.get(window, 'harness').holdScan = true; });
    await page.locator('#btnSyncAll').click();
    await page.waitForFunction(() => document.getElementById('scanStatus')?.textContent === 'Committed 2 pages, 150 source entries');
    const originalLog = await page.locator('#log').textContent();
    assert.match(originalLog ?? '', /Resolving conversation source/);
    await page.locator('#langToggle').setChecked(false);
    await page.waitForFunction(() => document.getElementById('scanStatus')?.textContent === '已接纳 2 页、150 条来源记录');
    assert.equal(await page.locator('#scanStatus').textContent(), '已接纳 2 页、150 条来源记录');
    assert.equal(await page.locator('#log').textContent(), originalLog);
    await page.evaluate(() => Reflect.get(window, 'harness').finishScan());
    await page.waitForFunction(() => document.getElementById('scanStatus')?.textContent === '已达到本地页数预算 · 2 / 150');
    const completedLog = await page.locator('#log').textContent();
    await page.locator('#langToggle').setChecked(true);
    await page.waitForFunction(() => document.getElementById('scanStatus')?.textContent === 'Local page budget reached · 2 / 150');
    assert.equal(await page.locator('#log').textContent(), completedLog);
});

test('i18n - log Ready caption uses initial language but existing entries remain unchanged', async () => {
    page = await browser.newPage();
    await mount(page, 'options', { settings: { language: 'zh' } });
    await page.locator('#accountIdSelect').waitFor();
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    assert.equal((await page.locator('#log').textContent())?.trim(), '就绪');
    await page.locator('#langToggle').setChecked(true);
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal((await page.locator('#log').textContent())?.trim(), '就绪');
});

test('i18n - Takeout status uses localized outcome and switches without rewriting logs', async () => {
    await open();
    await page.locator('#langToggle').setChecked(false);
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('#btnMoreActions').click();
    await page.locator('#btnImportTakeout').click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: 'Takeout.zip', mimeType: 'application/zip', buffer: Buffer.from('fixture') });
    await page.waitForFunction(() => document.getElementById('status')?.textContent === '已提交 2 条对话（部分完成）');
    const log = await page.locator('#log').textContent();
    await page.locator('#langToggle').setChecked(true);
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Imported 2 conversations (partial)');
    assert.equal(await page.locator('#log').textContent(), log);
});

test('i18n - known and unexpected errors localize in UI while logs preserve raw diagnostics', async () => {
    await open();
    await page.locator('#langToggle').setChecked(false);
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    const labels = await page.evaluate(() => {
        const { errorText } = Reflect.get(window, 'testUi').settings;
        return [errorText(new Error('Directory picker unavailable')),
            errorText(new Error('Select a Gemini account before importing Takeout')),
            errorText(new Error('Injected scan failure'))];
    });
    assert.deepEqual(labels, ['当前浏览器无法打开文件夹选择器。', '导入 Takeout 前，请先选择 Gemini 账号。',
        '操作失败，请重试；详情请查看日志或诊断报告。']);
    await page.evaluate(() => { Reflect.get(window, 'harness').failScan = true; });
    await page.locator('#btnSyncAll').click();
    await page.waitForFunction(() => document.getElementById('scanStatus')?.textContent === '操作失败，请重试；详情请查看日志或诊断报告。');
    assert.match(await page.locator('#log').textContent() ?? '', /Injected scan failure/);
    const logged = await page.locator('#log').textContent();
    await page.locator('#langToggle').setChecked(true);
    await page.waitForFunction(() => document.getElementById('scanStatus')?.textContent === 'Operation failed. Please retry; details are available in the logs or diagnostic report.');
    assert.equal(await page.locator('#log').textContent(), logged);
});

test('i18n - displayed conversation timestamps use the selected interface locale', async () => {
    await open();
    const english = await page.locator('#list .item .meta').first().textContent();
    await page.locator('#langToggle').setChecked(false);
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    const chinese = await page.locator('#list .item .meta').first().textContent();
    assert.ok(english?.trim());
    assert.ok(chinese?.trim());
    assert.notEqual(chinese, english);
});

test('i18n - popup status re-renders when another view updates language', async () => {
    await open('popup');
    await page.locator('#btnCurrent').click();
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Download initiated');
    await page.evaluate(() => {
        const harness = Reflect.get(window, 'harness');
        harness.settings.language = 'zh';
        harness.fireSettingsChange('local');
    });
    await page.waitForFunction(() => document.getElementById('status')?.textContent === '已发起下载');
});

test('i18n - known scan failures translate from structured diagnostics while preserving raw reasons', async () => {
    page = await browser.newPage();
    await mount(page, 'options', { scanResult: { status: 'error', reason: 'Gemini list failed: invalid_response',
        diagnostics: { providerId: 'gemini', streamId: 'recent', page: 1, requestCursor: null,
            failure: 'invalid_response' }, pagesFetched: 0, conversationsFetched: 0 } });
    await page.locator('#btnSyncAll').click();
    await page.waitForFunction(() => document.getElementById('scanStatus')?.textContent === 'Scan failed: invalid Gemini response · 0 / 0');
    const originalLog = await page.locator('#log').textContent();
    assert.match(originalLog ?? '', /invalid_response/);
    await page.locator('#langToggle').setChecked(false);
    await page.waitForFunction(() => document.getElementById('scanStatus')?.textContent === '扫描失败：Gemini 返回无效响应 · 0 / 0');
    assert.equal(await page.locator('#log').textContent(), originalLog);
});
