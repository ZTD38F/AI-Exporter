import test from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../src/l3a/storageService.js';
import { useStorageUnitEnvironment as useIndexStorage } from './helpers/l3aStorageUnitEnvironment.js';
import { fixtureKey } from './helpers/domainFixture.js';

import { openStorageDB } from '../src/l3a/idb.js';
import { isDirectoryHandle } from '../src/runtime/capabilities/directoryHandle.js';
useIndexStorage();
test('directory selection uses the single default key in the shared v2 DB', async () => {
    assert.equal(await storage.getDirectoryHandle(), null);
    const first = { name: 'First', kind: 'directory' } as FileSystemDirectoryHandle;
    const second = { name: 'Second', kind: 'directory' } as FileSystemDirectoryHandle;
    await storage.setDirectoryHandle(first); await storage.setDirectoryHandle(second);
    assert.deepEqual(await storage.getDirectoryHandle(), second);
    const db = await openStorageDB();
    try {
        const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
            const request = db.transaction('directoryHandles').objectStore('directoryHandles').getAllKeys();
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        assert.deepEqual(keys, ['default']);
    } finally { db.close(); }
});
test('directory IO fails visibly when IndexedDB is unavailable, without memory fallback', async () => {
    const previous = globalThis.indexedDB;
    try {
        Object.assign(globalThis, { indexedDB: undefined });
        await assert.rejects(storage.getDirectoryHandle());
        await assert.rejects(storage.setDirectoryHandle({ name: 'Fake' } as FileSystemDirectoryHandle));
    } finally { globalThis.indexedDB = previous; }
});

test('restored directory permission methods must be present before use', () => {
    const legacy = { name: 'Legacy', kind: 'directory' } as FileSystemDirectoryHandle;
    assert.equal(isDirectoryHandle(legacy), false);
    const missingRequest = { ...legacy, queryPermission: async () => 'granted' };
    assert.equal(isDirectoryHandle(missingRequest), false);
    const ready = { ...missingRequest, requestPermission: async () => 'granted' };
    assert.equal(isDirectoryHandle(ready), true);
});
