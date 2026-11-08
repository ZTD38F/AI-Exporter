import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { indexStorage } from './helpers/indexStorage.js';
import { ensureUpgraded } from '../src/migration/upgradeV1.js';
import { getSettings, updateSettings } from '../src/application/settings/index.js';
import { FEEDBACK_URL, UNINSTALL_FEEDBACK_URL } from '../src/shared/utils/constants.js';
const SUPPORTED_FORMATS: readonly string[] = ['markdown', 'html', 'json', 'pdf', 'docx'];
const html = () => readFileSync('src/ui/options/options.html', 'utf8');

test('current Settings default to the supported Markdown export format', async () => {
    const env = indexStorage();
    try {
        const format = (await getSettings()).defaultFormat;
        assert.equal(format, 'markdown');
        assert.ok(SUPPORTED_FORMATS.includes(format));
    } finally { env.restore(); }
});
test('current Options format control accepts exactly the five current formats', () => {
    const select = html().match(/<select id="format"[^>]*>(.*?)<\/select>/s)?.[1]; assert.ok(select);
    const values = [...select.matchAll(/value="([^"]+)"/g)].map(match => match[1]);
    for (const format of ['markdown', 'html', 'pdf', 'docx', 'json']) assert.ok(values.includes(format));
    for (const invalid of ['json_openai', 'json_raw', 'xml', '']) assert.equal(values.includes(invalid), false);
});
test('removed saved formats normalize only through the one-time migration owner', async () => {
    for (const value of ['markdown', 'html', 'json', 'pdf', 'json_openai', 'json_raw', 'invalid']) {
        const env = indexStorage({ gemini_export_format: value }); try {
            await ensureUpgraded(); assert.equal((await getSettings()).defaultFormat, SUPPORTED_FORMATS.includes(value) ? value : 'markdown');
        } finally { env.restore(); }
    }
});
test('format control choices match the ExportRequest formats rather than removed legacy variants', () => {
    const select = html().match(/<select id="format"[^>]*>(.*?)<\/select>/s)?.[1] ?? '';
    assert.deepEqual([...select.matchAll(/value="([^"]+)"/g)].map(match => match[1]).sort(), [...SUPPORTED_FORMATS].sort());
});
test('feedback links attribute extension and uninstall sources separately', () => {
    assert.equal(FEEDBACK_URL, 'https://tally.so/r/Y56ZBB?source=extension');
    assert.equal(UNINSTALL_FEEDBACK_URL, 'https://tally.so/r/Y56ZBB?source=uninstall');
});
for (const stored of ['json_openai', 'json_raw']) for (const developerMode of [false, true]) test(`migration repairs saved ${stored} in developer mode ${developerMode}`, async () => {
    const env = indexStorage({ gemini_export_format: stored, gemini_dev_mode: developerMode }); try {
        await ensureUpgraded(); const settings = await getSettings();
        assert.equal(settings.defaultFormat, 'markdown'); assert.equal(settings.developerMode, developerMode);
        await updateSettings({ defaultFormat: 'html' }); assert.equal((await getSettings()).defaultFormat, 'html');
        assert.equal(env.local.gemini_export_format, stored, 'normal v2 Settings writes do not maintain a legacy preference mirror');
    } finally { env.restore(); }
});
