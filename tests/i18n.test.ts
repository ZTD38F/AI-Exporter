import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as I18n from '../src/core/utils/i18n.js';
import zh from '../src/core/utils/locales/zh.js';
import en from '../src/core/utils/locales/en.js';

test('i18n - check dictionary parity between zh and en', () => {
    const zhKeys = Object.keys(I18n.LOCALES.zh);
    const enKeys = Object.keys(I18n.LOCALES.en);

    assert.ok(zhKeys.length >= 70, `zh locale dictionary should have at least 70 keys (got ${zhKeys.length})`);
    assert.ok(enKeys.length >= 70, `en locale dictionary should have at least 70 keys (got ${enKeys.length})`);

    for (const k of zhKeys) {
        assert.ok(k in I18n.LOCALES.en, `Key '${k}' in zh locale is missing in en locale`);
    }
    for (const k of enKeys) {
        assert.ok(k in I18n.LOCALES.zh, `Key '${k}' in en locale is missing in zh locale`);
    }
});

test('i18n - check all HTML data-i18n attributes are present in i18n.js', () => {
    for (const htmlFile of ['src/ui/options/options.html', 'src/ui/popup/popup.html']) {
        const htmlPath = path.join(__dirname, '..', htmlFile);
        const htmlContent = fs.readFileSync(htmlPath, 'utf8');
        const matches = htmlContent.matchAll(/data-i18n(?:-title|-placeholder|-html)?=["']([^"']+)["']/g);
        for (const m of matches) {
            const key = m[1];
            assert.ok(key in I18n.LOCALES.zh, `Key '${key}' used in ${htmlFile} missing in zh locale`);
            assert.ok(key in I18n.LOCALES.en, `Key '${key}' used in ${htmlFile} missing in en locale`);
        }
    }
});

test('i18n - parametric interpolation and language switching', async () => {
    await I18n.setLang('zh');
    assert.strictEqual(I18n.getLang(), 'zh');
    assert.strictEqual(I18n.t('syncedBadge', 42), '已同步 42 条');
    assert.strictEqual(I18n.t('exportFinished', 10, 2, 12), '导出完成！成功: 10，失败: 2，总计: 12');

    await I18n.setLang('en');
    assert.strictEqual(I18n.getLang(), 'en');
    assert.strictEqual(I18n.t('syncedBadge', 42), '42 synced');
    assert.strictEqual(I18n.t('exportFinished', 10, 2, 12), 'Export completed! Success: 10, Failed: 2, Total: 12');
});

test('i18n - language change event listener', async () => {
    let triggeredLang: string | null = null;
    I18n.onLanguageChange((lang) => {
        triggeredLang = lang;
    });

    await I18n.setLang('zh');
    assert.strictEqual(triggeredLang, 'zh');

    await I18n.setLang('en');
    assert.strictEqual(triggeredLang, 'en');
});

test('i18n - ensure no duplicate object literal keys in locale sources', () => {
    for (const lang of ['zh', 'en']) {
        const tsPath = path.join(__dirname, '..', 'src', 'core', 'utils', 'locales', lang + '.ts');
        const jsPath = path.join(__dirname, '..', 'src', 'core', 'utils', 'locales', lang + '.js');
        const localePath = fs.existsSync(tsPath) ? tsPath : jsPath;
        const content = fs.readFileSync(localePath, 'utf8');
        const bodyMatch = content.match(/return \{([\s\S]*)\n\s*\};/);
        assert.ok(bodyMatch, lang + ' dictionary body should exist');
        const block = bodyMatch![1];
        const keyMatches = [...block.matchAll(/^\s*([a-zA-Z0-9_]+):/gm)].map(m => m[1]);
        const counts: Record<string, number> = {};
        for (const k of keyMatches) {
            counts[k] = (counts[k] || 0) + 1;
        }
        const duplicates = Object.entries(counts).filter(([_, c]) => c > 1).map(([k]) => k);
        assert.deepStrictEqual(duplicates, [], `Found duplicate keys in ${lang} dictionary: ${duplicates.join(', ')}`);
    }
});

test('i18n - dynamic dictionary recovery via ensureLocales and direct locale exports', () => {
    assert.ok(zh && (zh as any).extName, 'zh locale export should be valid');
    assert.ok(en && (en as any).extName, 'en locale export should be valid');
    assert.strictEqual(I18n.t('extName'), 'Gemini Exporter');
});


test('i18n - applyI18n translates root element and descendants safely', async () => {
    await I18n.setLang('zh');

    class MockElement {
        attrs: Record<string, any>;
        textContent: string = '';
        title: string = '';
        placeholder: string = '';
        children: MockElement[] = [];
        nodeType: number = 1;

        constructor(attrs: Record<string, any> = {}) {
            this.attrs = attrs;
        }
        getAttribute(name: string) {
            return this.attrs[name] || null;
        }
        appendChild(child: MockElement) {
            this.children.push(child);
        }
        querySelectorAll(_selector: string) {
            const results: MockElement[] = [];
            const walk = (el: MockElement) => {
                for (const c of el.children) {
                    if (c.attrs['data-i18n'] || c.attrs['data-i18n-html'] || c.attrs['data-i18n-title'] || c.attrs['data-i18n-placeholder']) {
                        results.push(c);
                    }
                    walk(c);
                }
            };
            walk(this);
            return results;
        }
    }

    const rootEl = new MockElement({ 'data-i18n': 'extName' });
    const childEl = new MockElement({ 'data-i18n-title': 'btnSetDir', 'data-i18n-placeholder': 'searchPlaceholder' });
    rootEl.children.push(childEl);

    // Mock global document if needed
    const origDoc = (global as any).document;
    (global as any).document = {
        createElement: () => new MockElement(),
        createTextNode: (text: string) => ({ textContent: text })
    };

    try {
        I18n.applyI18n(rootEl as any);
        assert.strictEqual(rootEl.textContent, 'Gemini Exporter', 'Root element data-i18n should be translated');
        assert.strictEqual(childEl.title, '设置目录...', 'Child element data-i18n-title should be translated');
        assert.strictEqual(childEl.placeholder, '搜索标题 / ID...', 'Child element data-i18n-placeholder should be translated');
    } finally {
        if (origDoc !== undefined) (global as any).document = origDoc;
        else delete (global as any).document;
    }
});

test('i18n - applyLangToggleUI operates with injected elements without DOM coupling', async () => {
    await I18n.setLang('zh');
    const mockToggle = { checked: true };
    const mockZh = { style: { opacity: '' } };
    const mockEn = { style: { opacity: '' } };

    I18n.applyLangToggleUI({
        toggle: mockToggle as any,
        labelZh: mockZh as any,
        labelEn: mockEn as any
    });

    assert.strictEqual(mockToggle.checked, false, 'zh language should have toggle unchecked');
    assert.strictEqual(mockZh.style.opacity, '1', 'zh label should be full opacity');
    assert.strictEqual(mockEn.style.opacity, '0.6', 'en label should be muted opacity');

    await I18n.setLang('en');
    I18n.applyLangToggleUI({
        toggle: mockToggle as any,
        labelZh: mockZh as any,
        labelEn: mockEn as any
    });
    assert.strictEqual(mockToggle.checked, true, 'en language should have toggle checked');
    assert.strictEqual(mockEn.style.opacity, '1', 'en label should be full opacity');
    assert.strictEqual(mockZh.style.opacity, '0.6', 'zh label should be muted opacity');
});




