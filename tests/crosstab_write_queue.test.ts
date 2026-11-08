import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { A, B, key } from './helpers/v2ConversationFixture.js';
import type * as Storage from '../src/l3a/storageService.js';
const code = buildSync({ entryPoints: ['src/l3a/storageService.ts'], bundle: true, write: false, format: 'iife', globalName: 'storage' }).outputFiles[0].text;
function contexts() {
    const database = new IDBFactory();
    const create = () => new Function('indexedDB', 'IDBKeyRange', code + ';return storage;')(database, IDBKeyRange) as typeof Storage;
    return [create(), create()] as const;
}
test('T1: independent Storage contexts cannot lose concurrent Index transactions', async () => {
    const [a, b] = contexts();
    await a.putIndexes([{ key: key('a'), updatedAt: 1 }, { key: key('b'), updatedAt: 2 }]);
    await Promise.all([
        a.updateIndexesAtomically([key('a')], rows => [{ ...rows[0]!, title: 'A edit', titleSource: 'provider' }]),
        b.updateIndexesAtomically([key('b')], rows => [{ ...rows[0]!, updatedAt: 20 }]),
    ]);
    assert.equal((await b.getIndex(key('a')))?.title, 'A edit'); assert.equal((await a.getIndex(key('b')))?.updatedAt, 20);
});
test('T2: independent Storage contexts preserve concurrent ExportRecords', async () => {
    const [a, b] = contexts();
    const record = { format: 'markdown' as const, status: 'ok' as const, exportedAt: 1 };
    await Promise.all([a.putExportRecord(key('a'), record), b.putExportRecord(key('b'), record)]);
    assert.deepEqual(Object.keys(await a.listExportRecords(A)).sort(), ['a', 'b']);
});
test('T4: native transactions serialize same-key edits without a Web Locks API', async () => {
    const [a, b] = contexts(); await a.putIndexes([{ key: key(), updatedAt: 0 }]);
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).updateIndexesAtomically([key()], rows => [{ ...rows[0]!, updatedAt: rows[0]!.updatedAt! + 1 }])));
    assert.equal((await a.getIndex(key()))?.updatedAt, 20);
});
test('T5: an empty Index admission decision leaves stored facts unchanged', async () => {
    const [a] = contexts(); const row = { key: key(), title: 'Keep', titleSource: 'provider' as const };
    await a.putIndexes([row]); await a.updateIndexesAtomically([key()], () => []);
    assert.deepEqual(await a.getIndex(key()), row);
});
test('T6: verified deletion atomically drops Index, Detail and ExportRecord only for its ConversationKey', async () => {
    const [a, b] = contexts();
    const record = { format: 'markdown' as const, status: 'ok' as const, exportedAt: 1 };
    for (const accountId of [A, B]) {
        const target = key('same', accountId); await a.putIndexes([{ key: target }]);
        await a.updateConversationAtomically(target, () => ({
            detail: { key: target, quality: { status: 'complete' }, messages: [], assets: [] }, result: undefined
        }));
        await a.putExportRecord(target, record);
    }
    await a.deleteStoredConversation(key('same'));
    assert.equal(await b.getIndex(key('same')), null); assert.equal(await b.getDetail(key('same')), null); assert.equal(await b.getExportRecord(key('same')), null);
    assert.ok(await b.getIndex(key('same', B))); assert.ok(await b.getDetail(key('same', B))); assert.deepEqual(await b.getExportRecord(key('same', B)), record);
});
