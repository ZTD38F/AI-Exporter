import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { getSettings, updateSettings, type GlobalSettings } from '../src/application/settings/index.js';
import { isVersionGreater } from '../src/shared/utils/pathUtils.js';

test('userPreferences - developer mode uses the single Application Settings owner', async () => {
    const env = indexStorage(); try {
        assert.equal((await getSettings()).developerMode, false);
        await updateSettings({ developerMode: true }); assert.equal((await getSettings()).developerMode, true);
        await updateSettings({ developerMode: false }); assert.equal((await getSettings()).developerMode, false);
    } finally { env.restore(); }
});
test('Tour completion is not a durable preference and legacy completion flags do not enter Settings', async () => {
    const env = indexStorage({ has_completed_tour: true }); try {
        const settings = await getSettings(); assert.equal(Object.hasOwn(settings, 'tourCompleted'), false);
        assert.equal(Object.hasOwn(settings, 'has_completed_tour'), false); assert.equal(env.writes(), 0);
    } finally { env.restore(); }
});
test('userPreferences - feature version persists through Settings; version comparison retains numeric semantics', async () => {
    const env = indexStorage(); try {
        assert.equal((await getSettings()).lastSeenFeatureVersion, undefined);
        await updateSettings({ lastSeenFeatureVersion: '1.10.0' }); assert.equal((await getSettings()).lastSeenFeatureVersion, '1.10.0');
        assert.equal(isVersionGreater('1.10.0', '1.9.0'), true); assert.equal(isVersionGreater('1.0.0', '1.0.0'), false);
    } finally { env.restore(); }
});
test('informational prompts are durable one-time preferences and honor older acknowledgements', async () => {
    const env = indexStorage({ gemini_suppress_direct_write_prompt: true }); try {
        const initial = await getSettings();
        assert.equal(initial.directWritePromptCompleted, true, 'do not replay the v1 bulk tip');
        assert.equal(initial.takeoutPromptCompleted, undefined);
        await updateSettings({ takeoutPromptCompleted: true });
        const settings = await getSettings();
        assert.equal(settings.takeoutPromptCompleted, true);
        assert.equal(settings.directWritePromptCompleted, true);
    } finally { env.restore(); }
});
test('large batch tip completion persists without old suppression key', async () => {
    const env = indexStorage(); try {
        assert.equal((await getSettings()).directWritePromptCompleted, undefined);
        await updateSettings({ directWritePromptCompleted: true });
        assert.equal((await getSettings()).directWritePromptCompleted, true);
    } finally { env.restore(); }
});
test('userPreferences - position and language roundtrip; ZIP and diagnostics remain outside Settings', async () => {
    const env = indexStorage({ gemini_export_zip: true, diagnostics_enabled: true, gemini_exporter_lang: 'zh' }); try {
        const initial = await getSettings(); assert.equal(initial.language, undefined);
        assert.equal(Object.hasOwn(initial, 'zip'), false); assert.equal(Object.hasOwn(initial, 'diagnostics'), false);
        const patch: Partial<GlobalSettings> = { language: 'zh', badgePosition: { left: 100, top: 200 }, defaultFormat: 'pdf' };
        await updateSettings(patch); const read = await getSettings();
        assert.equal(read.language, 'zh'); assert.deepEqual(read.badgePosition, patch.badgePosition); assert.equal(read.defaultFormat, 'pdf');
        assert.equal(read.enabledDisk, false); assert.equal(read.includeAssets, false);
    } finally { env.restore(); }
});
