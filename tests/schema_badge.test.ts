import test from 'node:test';
import assert from 'node:assert/strict';
import { storageUnitEnvironment as indexStorage } from './helpers/l3aStorageUnitEnvironment.js';
import { patchStoredSettings, getStoredSettings } from '../src/l3a/storageService.js';

test('passive Storage propagates IO errors without a global schema freeze or badge side effects', async () => {
    const env = indexStorage();
    let badgeCalls = 0;
    Object.assign(chrome, { action: {
        setBadgeText: async () => { badgeCalls++; throw new Error('Badge unavailable'); },
        setBadgeBackgroundColor: async () => { badgeCalls++; throw new Error('Color unavailable'); },
    } });
    try {
        env.fail('gemini_exporter_v2_settings');
        await assert.rejects(patchStoredSettings({ enabledDisk: true }), /write failed/);
        assert.deepEqual(await getStoredSettings(), {});
        env.fail(); await patchStoredSettings({ enabledDisk: false });
        assert.deepEqual(await getStoredSettings(), { enabledDisk: false });
        assert.equal(badgeCalls, 0);
    } finally { env.restore(); }
});
