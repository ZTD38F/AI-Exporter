import test from 'node:test';
import assert from 'node:assert/strict';
import { runExport, shouldSkipExport } from '../src/application/export/runExport.js';
import { getExportRecord } from '../src/l3a/storageService.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { v2ExportHost, exportKey, exportRequest } from './helpers/v2ExportHost.js';

async function version(id: string, time: number | undefined, turns: number) {
    await ingestDetail(exportKey(id).accountId, id, {
        ...(time !== undefined ? { savedAt: time } : {}), quality: { status: 'complete' }, assets: [],
        messages: Array.from({ length: turns * 2 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const,
            timestamp: 1700000000000 + i, content: [{ type: 'paragraph' as const,
                children: [{ type: 'text' as const, text: `Turn ${Math.floor(i / 2) + 1} part ${i % 2}` }] }] })),
    }, { title: 'Continued conversation', titleSource: 'provider', ...(time !== undefined ? { updatedAt: time } : {}) });
}
test('completion records retain captured source versions across successive exports and skip only known unchanged versions', async t => {
    const host = v2ExportHost(t), id = 'continued_chat_test_1';
    const request = exportRequest([id], { skipUnchanged: true });
    const T1 = 1700000000500, T2 = 1700000100800, T3 = 1700000300900;
    await version(id, T1, 1);
    assert.equal((await runExport(request)).exported, 1);
    const first = await getExportRecord(exportKey(id));
    assert.equal(first?.chatTime, T1); assert.equal(first?.status, 'ok');
    assert.equal(shouldSkipExport(first, T1, request), true);
    assert.equal(shouldSkipExport(first, T2, request), false);
    await version(id, T2, 2);
    assert.equal((await runExport(request)).exported, 1);
    const second = await getExportRecord(exportKey(id));
    assert.equal(second?.chatTime, T2); assert.equal(second?.status, 'ok');
    assert.equal((await runExport(request)).skipped, 1);
    assert.equal(shouldSkipExport(second, T3, request), false);
    assert.equal(host.clicks(), 2);
    assert.match(await host.blobs[1].text(), /Turn 2 part 1/);
    assert.equal(Object.hasOwn(second!, 'messageCount'), false, 'the minimal Record has no parallel message-count freshness rule');
});
test('message timestamps cannot manufacture an unknown conversation source version', async t => {
    const host = v2ExportHost(t), id = 'undated';
    await version(id, undefined, 2);
    const request = exportRequest([id], { skipUnchanged: true });
    assert.equal((await runExport(request)).exported, 1);
    const record = await getExportRecord(exportKey(id));
    assert.equal(record?.chatTime, undefined);
    assert.equal(shouldSkipExport(record, undefined, request), false);
    assert.equal(host.clicks(), 1);
});
test('a client clock behind the source clock cannot invalidate a matching source export version', async t => {
    v2ExportHost(t);
    const sourceTime = 1700000050000, clientTime = sourceTime - 10000;
    t.mock.method(Date, 'now', () => clientTime);
    await version('skew_chat', sourceTime, 2);
    const request = exportRequest(['skew_chat'], { skipUnchanged: true });
    assert.equal((await runExport(request)).exported, 1);
    const record = await getExportRecord(exportKey('skew_chat'));
    assert.equal(record?.exportedAt, clientTime); assert.equal(record?.chatTime, sourceTime);
    assert.equal((await runExport(request)).skipped, 1);
});
