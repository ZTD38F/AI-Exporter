// Cross-module behavior: real Application settings, L3a persistence, and Runtime Live Save.
// Only the browser and IndexedDB host surfaces are provided by indexStorage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { fixtureKey } from './helpers/domainFixture.js';
import { getSettings, updateSettings, isLiveSaveEffective } from '../src/application/settings/index.js';
import { getStoredSettings, getExportRecord } from '../src/l3a/storageService.js';
import { runLiveSave } from '../src/runtime/background/liveSaveHandler.js';

test('non-Markdown formats pause Live Save without discarding its v2 setting', async () => {
    const env = indexStorage();
    const key = fixtureKey('live-v2');
    try {
        await updateSettings({ enabledDisk: true, defaultFormat: 'markdown' });
        assert.equal(isLiveSaveEffective(await getSettings(), true), true);
        for (const format of ['pdf', 'html', 'json'] as const) {
            await updateSettings({ defaultFormat: format });
            const settings = await getSettings();
            assert.equal(settings.enabledDisk, true, 'format changes preserve the user intent');
            assert.equal(isLiveSaveEffective(settings, true), false);
            assert.equal(await runLiveSave(key), null, 'Runtime must not export a non-Markdown live save');
            assert.equal(await getExportRecord(key), null, 'no delivery or export record was created');
        }
        await updateSettings({ defaultFormat: 'markdown' });
        await updateSettings({ exportDelivery: 'browserDownload' });
        const paused = await getSettings();
        assert.equal(paused.enabledDisk, true, 'destination changes preserve the enabled preference');
        assert.equal(isLiveSaveEffective(paused, true), false);
        assert.equal(await runLiveSave(key), null, 'Runtime must not write files in browser-download mode');
        assert.equal(await getExportRecord(key), null);
        await updateSettings({ exportDelivery: 'folderWriter' });
        assert.equal(isLiveSaveEffective(await getSettings(), false), false);
        await assert.rejects(runLiveSave(key), /Choose a Live Save directory/, 'a Markdown live save still requires a writable folder');
        assert.equal((await getStoredSettings()).enabledDisk, true);
        await updateSettings({ enabledDisk: false });
        assert.equal(await runLiveSave(key), null);
    } finally {
        env.restore();
    }
});
