import test from 'node:test';
import assert from 'node:assert/strict';
import { v2ExportHost, exportRequest, exportKey, seedExportConversation } from './helpers/v2ExportHost.js';
import { runExport } from '../src/application/export/runExport.js';
import { getExportRecord, listExportRecords } from '../src/l3a/storageService.js';

// v2 deliberately has no persistent SessionStore. Restart behavior belongs to
// runExport + minimal ExportRecords; requests supply their own selection again.
const sessionKey = 'gemini_last_export_session';
async function assertNoSession() {
    const local = await chrome.storage.local.get(null);
    assert.equal(Object.hasOwn(local, sessionKey), false);
}

test('restart state is empty before any delivery, without creating a session', async t => {
    v2ExportHost(t);
    assert.deepEqual(await listExportRecords(exportKey('empty').accountId), {});
    assert.deepEqual(await runExport(exportRequest([])), { exported: 0, skipped: 0, partial: 0, failed: [], aborted: false });
    await assertNoSession();
});

test('a new execution rebuilds its pending selection from committed source versions', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('first');
    await seedExportConversation('second');
    assert.equal((await runExport(exportRequest(['first']))).exported, 1);
    // New request supplies selection; neither original run ID nor queue is resumed.
    const result = await runExport(exportRequest(['first', 'second'], { skipUnchanged: true }));
    assert.equal(result.skipped, 1);
    assert.equal(result.exported, 1);
    assert.equal(host.clicks(), 2);
    assert.deepEqual(Object.keys(await listExportRecords(exportKey('first').accountId)).sort(), ['first', 'second']);
    await assertNoSession();
});

test('cancellation before delivery stores no checkpoint or success record', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('cancelled');
    const controller = new AbortController();
    const result = await runExport(exportRequest(['cancelled']), {
        signal: controller.signal, onProgress: () => controller.abort(),
    });
    assert.equal(result.aborted, true);
    assert.equal(result.exported, 0);
    assert.equal(host.clicks(), 0);
    assert.equal(await getExportRecord(exportKey('cancelled')), null);
    await assertNoSession();
});

test('cancelling a later run preserves prior delivery facts', async t => {
    v2ExportHost(t);
    await seedExportConversation('prior');
    await runExport(exportRequest(['prior']));
    const record = await getExportRecord(exportKey('prior'));
    const controller = new AbortController(); controller.abort();
    const result = await runExport(exportRequest(['prior']), { signal: controller.signal });
    assert.equal(result.aborted, true);
    assert.deepEqual(await getExportRecord(exportKey('prior')), record);
    await assertNoSession();
});

test('subsequent delivery replaces the latest record without persistent queue metadata', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('replace', 100);
    await runExport(exportRequest(['replace']));
    await seedExportConversation('replace', 200);
    await runExport(exportRequest(['replace'], { format: 'json' }));
    const record = await getExportRecord(exportKey('replace'));
    assert.equal(record?.format, 'json');
    assert.equal(record?.chatTime, 200);
    assert.deepEqual(Object.keys(record!).sort(), ['chatTime', 'exportedAt', 'format', 'status']);
    assert.equal(host.clicks(), 2);
    await assertNoSession();
});
