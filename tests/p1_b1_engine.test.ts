import test from 'node:test';
import assert from 'node:assert/strict';
import { runExport } from '../src/application/export/runExport.js';
import { getExportRecord } from '../src/l3a/storageService.js';
import { v2ExportHost, exportKey, exportRequest, seedExportConversation, seedExportIndexOnly } from './helpers/v2ExportHost.js';

/**
 * P1-011 on the shipped v2 pipeline. A failed L1 Detail acquisition must
 * not prevent Application from exporting a later healthy L2/L3a conversation.
 * There is no ExportOrchestrator, BatchWorker, or legacy export session.
 */
test('P1-011: failed L1 acquisition affects only its key; the next v2 Domain exports and commits', async t => {
    const host = v2ExportHost(t);
    await seedExportIndexOnly('broken');
    await seedExportConversation('healthy');

    const progress: string[] = [];
    const result = await runExport(exportRequest(['broken', 'healthy']), {
        onProgress: item => progress.push(item.key.conversationId),
    });

    assert.deepEqual(progress, ['broken', 'healthy']);
    assert.equal(result.aborted, false);
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
    assert.deepEqual(result.failed, [exportKey('broken')]);
    assert.equal(result.skipped, 0);
    assert.equal(host.clicks(), 1);
    assert.match(host.filenames[0], /\.md$/);
    assert.equal(host.blobs.length, 1);
    assert.match(await host.blobs[0].text(), /Answer for healthy/);
    assert.doesNotMatch(await host.blobs[0].text(), /Unavailable broken/);

    assert.equal(await getExportRecord(exportKey('broken')), null);
    const healthy = await getExportRecord(exportKey('healthy'));
    assert.ok(healthy);
    assert.equal(healthy.format, 'markdown');
    assert.equal(healthy.status, 'ok');
    assert.equal(healthy.chatTime, 100);
});
