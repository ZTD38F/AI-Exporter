import test from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../src/l3a/storageService.js';
import { useStorageUnitEnvironment as useIndexStorage } from './helpers/l3aStorageUnitEnvironment.js';
import { fixtureKey } from './helpers/domainFixture.js';

useIndexStorage();
test('compound storage keys partition identical provider IDs by Account UUID', async () => {
    const key = fixtureKey('same'), other = { ...key, accountId: '20000000-0000-4000-8000-000000000002' };
    await storage.putIndexes([{ key, title: 'First', titleSource: 'provider' }, { key: other, title: 'Second', titleSource: 'provider' }]);
    assert.equal((await storage.getIndex(key))?.title, 'First');
    assert.equal((await storage.listIndexes(other.accountId))[0].title, 'Second');
});
test('storage never infers deletions from an incoming page or migration batch', async () => {
    const key = fixtureKey('older'), next = fixtureKey('newer');
    await storage.putIndexes([{ key }]);
    await storage.putIndexes([{ key: next }]);
    await storage.putIndexes([]);
    assert.equal((await storage.listIndexes(key.accountId)).length, 2);
});
test('Settings patches persist exactly the caller-supplied v2 values', async () => {
    assert.deepEqual(await storage.getStoredSettings(), {});
    await storage.patchStoredSettings({ defaultFormat: 'markdown', skipExported: false });
    assert.deepEqual(await storage.getStoredSettings(), { defaultFormat: 'markdown', skipExported: false });
    await storage.patchStoredSettings({ defaultFormat: 'pdf' });
    assert.deepEqual(await storage.getStoredSettings(), { defaultFormat: 'pdf', skipExported: false });
});
