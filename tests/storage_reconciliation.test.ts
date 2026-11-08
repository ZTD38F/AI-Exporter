import test from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../src/l3a/storageService.js';
import { useStorageUnitEnvironment as useIndexStorage } from './helpers/l3aStorageUnitEnvironment.js';
import { fixtureKey } from './helpers/domainFixture.js';

useIndexStorage();
test('explicit deletion uses the exact opaque ConversationKey without c_ alias rewriting', async () => {
    const key = fixtureKey('id'), alias = fixtureKey('c_id'), other = { ...key, accountId: '20000000-0000-4000-8000-000000000002' };
    await storage.putIndexes([{ key }, { key: alias }, { key: other }]);
    await storage.deleteStoredConversation(alias);
    assert.equal(await storage.getIndex(alias), null);
    assert.ok(await storage.getIndex(key)); assert.ok(await storage.getIndex(other));
    await storage.deleteStoredConversation(fixtureKey('absent'));
    assert.equal((await storage.listIndexes(key.accountId)).length, 1);
});
test('empty atomic admission never reconciles away previously stored history', async () => {
    const key = fixtureKey('offline'); await storage.putIndexes([{ key, title: 'Offline', titleSource: 'derived' }]);
    await storage.updateIndexesAtomically([], () => []);
    assert.equal((await storage.getIndex(key))?.title, 'Offline');
});
test('deleting one conversation leaves Coverage and other conversation records intact', async () => {
    const key = fixtureKey('delete'), kept = fixtureKey('keep');
    for (const k of [key, kept]) await storage.putExportRecord(k, { exportedAt: 0, format: 'json', status: 'ok' });
    await storage.updateCoverageAtomically(key.accountId, 'recent', () => ({ next: { range: null }, result: undefined }));
    await storage.deleteStoredConversation(key);
    assert.equal(await storage.getExportRecord(key), null); assert.ok(await storage.getExportRecord(kept));
    assert.deepEqual(await storage.getCoverage(key.accountId, 'recent'), { range: null });
});
