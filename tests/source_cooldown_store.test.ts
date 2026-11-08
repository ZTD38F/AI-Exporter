import test from 'node:test';
import assert from 'node:assert/strict';
import { getSourceCooldown, extendSourceCooldown } from '../src/l3a/storageService.js';
import { useIndexStorage } from './helpers/indexStorage.js';
useIndexStorage();

test('transport deadlines are account scoped and concurrent writes cannot shorten a cooldown', async () => {
    await Promise.all([extendSourceCooldown('one', 7200000), extendSourceCooldown('one', 3600000)]);
    assert.equal(await getSourceCooldown('one'), 7200000);
    assert.equal(await getSourceCooldown('two'), 0);
    await extendSourceCooldown('two', 1800000);
    assert.equal(await getSourceCooldown('one'), 7200000);
    assert.equal(await getSourceCooldown('two'), 1800000);
});

test('malformed persisted deadlines do not become trusted transport state', async () => {
    for (const value of ['3600000', {}, -1, 0.5]) {
        await chrome.storage.local.set({ source_cooldown_one: value });
        assert.equal(await getSourceCooldown('one'), 0);
    }
});
