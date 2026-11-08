import test from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../src/l3a/storageService.js';
import { indexStorage, useIndexStorage } from './helpers/indexStorage.js';
import { fixtureKey } from './helpers/domainFixture.js';

function readiness(): typeof import('../src/runtime/background/readiness.js') {
    const file = require.resolve('../src/runtime/background/readiness.js');
    delete require.cache[file]; return require(file);
}
test('Background readiness shares in-flight upgrade and caches success', async () => {
    const env = indexStorage();
    try {
        const { ensureV2Ready } = readiness();
        const first = ensureV2Ready(); assert.equal(first, ensureV2Ready()); await first;
        assert.equal(env.local.gemini_exporter_v2_initialized, true);
        const writes = env.writes(); assert.equal(first, ensureV2Ready()); await ensureV2Ready();
        assert.equal(env.writes(), writes);
    } finally { env.restore(); }
});
test('Background retries failed upgrade and never admits a failed marker commit', async () => {
    const env = indexStorage();
    try {
        const { ensureV2Ready } = readiness(); env.fail('gemini_exporter_v2_initialized');
        let admitted = false;
        await assert.rejects(ensureV2Ready().then(() => { admitted = true; }), /write failed/);
        assert.equal(admitted, false); assert.equal(env.local.gemini_exporter_v2_initialized, undefined);
        env.fail(); await ensureV2Ready(); assert.equal(env.local.gemini_exporter_v2_initialized, true);
    } finally { env.restore(); }
});
test('passive Storage neither invokes Migration nor stores an initialization marker', async () => {
    const env = indexStorage({ gemini_exporter_schema_version: 999 });
    try {
        await storage.putIndexes([{ key: fixtureKey('passive') }]);
        assert.ok(await storage.getIndex(fixtureKey('passive')));
        assert.deepEqual(env.local, { gemini_exporter_schema_version: 999 });
    } finally { env.restore(); }
});
