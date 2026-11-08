import test from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../src/l3a/storageService.js';
import { useStorageUnitEnvironment } from './helpers/l3aStorageUnitEnvironment.js';
import type { GlobalSettings } from '../src/application/settings/index.js';

useStorageUnitEnvironment();

test('L3a stores the v2 Settings patch without applying Application defaults', async () => {
    assert.deepEqual(await storage.getStoredSettings(), {});
    const patch = { enabledDisk: true, includeAssets: false } satisfies Partial<GlobalSettings>;
    await storage.patchStoredSettings(patch);
    assert.deepEqual(await storage.getStoredSettings(), patch);
    await storage.patchStoredSettings({ enabledDisk: false });
    assert.deepEqual(await storage.getStoredSettings(), { enabledDisk: false, includeAssets: false });
});

test('directory handle persists independently from the installed Settings fields', async () => {
    const handle = { kind: 'directory', name: 'Selected' } as FileSystemDirectoryHandle;
    await storage.patchStoredSettings({ enabledDisk: true });
    assert.equal(await storage.getDirectoryHandle(), null);
    await storage.setDirectoryHandle(handle);
    await storage.patchStoredSettings({ defaultFormat: 'pdf' });
    assert.deepEqual(await storage.getDirectoryHandle(), handle);
    assert.deepEqual(await storage.getStoredSettings(), { enabledDisk: true, defaultFormat: 'pdf' });
    await storage.setDirectoryHandle(null);
    assert.equal(await storage.getDirectoryHandle(), null);
    assert.deepEqual(await storage.getStoredSettings(), { enabledDisk: true, defaultFormat: 'pdf' });
});
