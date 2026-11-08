import { key, reset, events, state } from './helpers/applicationHarness.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSettings, updateSettings, isLiveSaveEffective } from '../src/application/settings/index.js';
import { clearLocalScanRecords, clearLocalExportRecords } from '../src/application/localCleanup.js';

test.beforeEach(reset);
test('Settings defaults are applied only on read; explicit choices are preserved', async () => {
    assert.deepEqual(await getSettings(), { defaultFormat: 'markdown', skipExported: true, includeAssets: false, enabledDisk: false, developerMode: false, exportDelivery: 'browserDownload' });
    assert.deepEqual(events, []);
    await updateSettings({ includeAssets: false, language: 'en' });
    await updateSettings({ enabledDisk: true });
    const settings = await getSettings();
    assert.equal(settings.includeAssets, false);
    await updateSettings({ includeAssets: true });
    assert.equal((await getSettings()).includeAssets, true);
    assert.equal(settings.language, 'en'); assert.equal(settings.enabledDisk, true);
});
test('sparse Settings patches preserve optional Spotlight, Takeout and Badge state', async () => {
    const badgePosition = { left: 12, top: 34 };
    await updateSettings({ lastSeenFeatureVersion: '1.8.0', takeoutPromptCompleted: true, badgePosition });
    await updateSettings({ includeAssets: false, skipExported: false });
    assert.deepEqual(await getSettings(), {
        defaultFormat: 'markdown', skipExported: false, includeAssets: false,
        enabledDisk: false, developerMode: false, exportDelivery: 'browserDownload',
        lastSeenFeatureVersion: '1.8.0', takeoutPromptCompleted: true, badgePosition,
    });
    assert.deepEqual(events, ['settings-write', 'settings-write']);
});
test('Live Save format and directory changes pause effectiveness without mutating user intent', async () => {
    await updateSettings({ enabledDisk: true });
    const markdown = await getSettings();
    assert.equal(markdown.exportDelivery, 'folderWriter', 'existing Live Save users retain the local folder mode');
    assert.equal(isLiveSaveEffective(markdown, true), true);
    assert.equal(isLiveSaveEffective(markdown, false), false);
    for (const defaultFormat of ['pdf', 'html', 'json'] as const) {
        await updateSettings({ defaultFormat });
        assert.equal(isLiveSaveEffective(await getSettings(), true), false);
        assert.equal((await getSettings()).enabledDisk, true);
    }
    await updateSettings({ defaultFormat: 'markdown' });
    assert.equal(isLiveSaveEffective(await getSettings(), true), true);
    await updateSettings({ exportDelivery: 'browserDownload' });
    assert.equal((await getSettings()).enabledDisk, true, 'browser mode pauses without clearing intent');
    assert.equal(isLiveSaveEffective(await getSettings(), true), false);
    await updateSettings({ exportDelivery: 'folderWriter' });
    assert.equal(isLiveSaveEffective(await getSettings(), true), true);
    assert.equal(events.filter(event => event === 'settings-write').length, 7);
});
test('Settings IO failures propagate instead of silently manufacturing defaults or claiming success', async () => {
    state.failSettingsRead = true; await assert.rejects(getSettings(), /read failed/);
    state.failSettingsWrite = true; await assert.rejects(updateSettings({ language: 'en' }), /write failed/);
    assert.deepEqual(events, []);
});
test('clearExportRecords delegates exactly once to the account-scoped Storage port', async () => {
    await clearLocalExportRecords(key().accountId);
    assert.deepEqual(events, ['clear-export:' + key().accountId]);
});
test('clearScanRecords delegates one combined Storage transaction, never separate Export cleanup', async () => {
    await clearLocalScanRecords(key().accountId);
    assert.deepEqual(events, ['clear-scan:' + key().accountId]);
});
test('clearExportRecords propagates a failed Storage transaction', async () => {
    state.failDelete = 'record';
    await assert.rejects(clearLocalExportRecords(key().accountId), /delete failed/);
    assert.deepEqual(events, ['clear-export:' + key().accountId]);
});
test('clearScanRecords propagates a failed Storage transaction without triggering another call', async () => {
    state.failDelete = 'coverage';
    await assert.rejects(clearLocalScanRecords(key().accountId), /coverage failed/);
    assert.deepEqual(events, ['clear-scan:' + key().accountId]);
});
