import test from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../src/l3a/storageService.js';
import { useStorageUnitEnvironment as useIndexStorage } from './helpers/l3aStorageUnitEnvironment.js';
import { fixtureKey } from './helpers/domainFixture.js';

import { buildSync } from 'esbuild';
import vm from 'node:vm';
import { IDBObjectStore } from 'fake-indexeddb';
test('Storage exposes exactly the 26 agreed passive IO functions', () => {
    const code = buildSync({ entryPoints: ['src/l3a/storageService.ts'], bundle: true, write: false, format: 'cjs' }).outputFiles[0].text;
    const context = { module: { exports: {} } }; vm.runInNewContext(code, context);
    assert.deepEqual(Object.keys(context.module.exports).sort(), [
        'getAccount', 'listAccounts', 'insertAccountIfAbsent', 'admitAccountAtomically', 'putAccount',
        'getIndex', 'listIndexes', 'putIndexes', 'updateIndexesAtomically',
        'getDetail', 'updateConversationAtomically', 'deleteStoredConversation',
        'getCoverage', 'updateCoverageAtomically', 'getExportRecord', 'listExportRecords',
        'putExportRecord', 'clearStoredAccountExportRecords', 'getStoredSettings',
        'patchStoredSettings', 'getDirectoryHandle', 'setDirectoryHandle', 'clearStoredAccountScanRecords', 'clearStoredAccountCoverage',
        'getSourceCooldown', 'extendSourceCooldown',
    ].sort());
});
useIndexStorage();
test('folder basename metadata persists separately for the same conversation ID in different accounts', async () => {
    const first = fixtureKey('shared-folder-id', 'gemini');
    const second = fixtureKey('shared-folder-id', 'chatgpt');
    await storage.putExportRecord(first, { exportedAt: 1, format: 'markdown', status: 'ok', folderBaseName: 'Gemini file' });
    await storage.putExportRecord(second, { exportedAt: 2, format: 'markdown', status: 'ok', folderBaseName: 'ChatGPT file' });
    assert.equal((await storage.getExportRecord(first))?.folderBaseName, 'Gemini file');
    assert.equal((await storage.getExportRecord(second))?.folderBaseName, 'ChatGPT file');
});
test('ExportRecord writes do not finalize or mutate Index/Detail', async () => {
    const key = fixtureKey('export');
    await storage.putIndexes([{ key, title: 'Authoritative', titleSource: 'provider', updatedAt: 1 }]);
    const before = await storage.getIndex(key);
    await storage.putExportRecord(key, { exportedAt: 2, format: 'html', status: 'partial' });
    assert.deepEqual(await storage.getIndex(key), before);
    assert.equal(await storage.getDetail(key), null);
    assert.deepEqual(await storage.getExportRecord(key), { exportedAt: 2, format: 'html', status: 'partial' });
});


test('Node Storage fixture preserves native in-line and out-of-line key semantics', async () => {
    const originalPut = IDBObjectStore.prototype.put;
    const calls: Array<[string, number]> = [];
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
        if (this.name === 'exportRecords' || this.name === 'directoryHandles')
            calls.push([this.name, arguments.length]);
        return arguments.length === 1 ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    try {
        const key = fixtureKey('key-mode');
        const record = { exportedAt: 1, format: 'markdown' as const, status: 'ok' as const };
        const directory = { kind: 'directory', name: 'selected' } as FileSystemDirectoryHandle;
        await storage.putExportRecord(key, record);
        await storage.setDirectoryHandle(directory);
        assert.deepEqual(calls, [['exportRecords', 1], ['directoryHandles', 2]]);
        assert.deepEqual(await storage.getExportRecord(key), record);
        assert.deepEqual(await storage.getDirectoryHandle(), directory);
    } finally {
        IDBObjectStore.prototype.put = originalPut;
    }
});
