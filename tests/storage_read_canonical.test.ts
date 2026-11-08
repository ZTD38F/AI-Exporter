import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { A, B, key, seed } from './helpers/v2ConversationFixture.js';
import { listIndexes, listExportRecords, putExportRecord } from '../src/l3a/storageService.js';

test('current-schema reads use only account-scoped v2 stores, ignoring legacy global fallback keys', async () => {
    const env = indexStorage({ conversations: [{ id: 'leak' }], exported: { leak: {} }, ['conversations_' + A]: [{ id: 'old' }] });
    try {
        await seed('a'); await seed('b', { accountId: B });
        assert.deepEqual((await listIndexes(A)).map(row => row.key.conversationId), ['a']);
        assert.deepEqual((await listIndexes(B)).map(row => row.key.conversationId), ['b']);
        assert.deepEqual(await listExportRecords(A), {});
    } finally { env.restore(); }
});
test('current-schema read paths are non-mutating, including empty-account reads', async () => {
    const env = indexStorage(); try {
        await seed(); const before = env.writes(), local = structuredClone(env.local);
        await listIndexes(A); await listIndexes(B); await listExportRecords(A); await listExportRecords(B);
        assert.equal(env.writes(), before); assert.deepEqual(env.local, local);
    } finally { env.restore(); }
});
test('listExportRecords enforces account isolation without fallback leakage', async () => {
    const env = indexStorage(); try {
        const a = { format: 'html' as const, status: 'ok' as const, exportedAt: 10 };
        const b = { format: 'json' as const, status: 'partial' as const, exportedAt: 20 };
        await putExportRecord(key('same'), a); await putExportRecord(key('same', B), b);
        assert.deepEqual(await listExportRecords(A), { same: a }); assert.deepEqual(await listExportRecords(B), { same: b });
    } finally { env.restore(); }
});
