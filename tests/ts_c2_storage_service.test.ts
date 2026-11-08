import test from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../src/l3a/storageService.js';
import { storageUnitEnvironment as indexStorage, useStorageUnitEnvironment as useIndexStorage } from './helpers/l3aStorageUnitEnvironment.js';
import { fixtureKey } from './helpers/domainFixture.js';

useIndexStorage();
test('normal ExportRecord storage preserves provider-native IDs and replaces the accepted value', async () => {
    const key = fixtureKey('c_native');
    await storage.putExportRecord(key, { exportedAt: 10, chatTime: 5, format: 'markdown', status: 'partial' });
    await storage.putExportRecord(key, { exportedAt: 2, format: 'html', status: 'ok' });
    assert.deepEqual(await storage.listExportRecords(key.accountId), { c_native: { exportedAt: 2, format: 'html', status: 'ok' } });
    assert.equal(await storage.getExportRecord(fixtureKey('native')), null);
});
test('concurrent IDB admission sees committed predecessors without JavaScript/WebLock queues', async () => {
    const key = fixtureKey('counter');
    const original = navigator.locks.request;
    navigator.locks.request = () => { throw new Error('IDB must not use Settings lock'); };
    try {
        await Promise.all(Array.from({ length: 12 }, () => storage.updateIndexesAtomically([key], old => [{ key, updatedAt: (old[0]?.updatedAt ?? 0) + 1 }])));
        assert.equal((await storage.getIndex(key))?.updatedAt, 12);
    } finally { navigator.locks.request = original; }
});
test('a failed native transaction rolls back the batch and cannot stall later admissions', async () => {
    const key = fixtureKey('valid');
    await assert.rejects(storage.putIndexes([{ key }, { key: { ...key, conversationId: undefined! } }]));
    assert.equal(await storage.getIndex(key), null);
    await storage.updateIndexesAtomically([key], () => [{ key, updatedAt: 1 }]);
    assert.equal((await storage.getIndex(key))?.updatedAt, 1);
});
test('ordinary reads never fall back to old slots, export scalars, lastSync or Chrome lists', async () => {
    const key = fixtureKey('legacy');
    const env = indexStorage({ [`conversations_${key.accountId}`]: [{ id: 'legacy' }], [`exported_${key.accountId}`]: { legacy: true }, gemini_account_slots: { u0: {} }, last_sync: 1 });
    try {
        assert.deepEqual(await storage.listIndexes(key.accountId), []);
        assert.deepEqual(await storage.listExportRecords(key.accountId), {});
        assert.deepEqual(await storage.listAccounts(), []);
        await storage.putExportRecord(key, { exportedAt: 0, format: 'json', status: 'ok' });
        assert.deepEqual(env.local[`exported_${key.accountId}`], { legacy: true });
    } finally { env.restore(); }
});
