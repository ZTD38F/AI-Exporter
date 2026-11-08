/**
 * V2 replacement for the retired AssetPipeline direct-write failure test.
 *
 * L1 acquires source bytes; L2/L3a own facts; Application + L3b/L4 write the
 * main Markdown and its sidecar. Only HTTP and the FileSystemDirectoryHandle
 * host are simulated. Failed delivery never commits a successful ExportRecord.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveSave } from '../src/runtime/background/liveSaveHandler.js';
import { getExportRecord } from '../src/l3a/storageService.js';
import { liveKey, seedLiveDetail, v2LiveSaveHost } from './helpers/v2LiveSaveHost.js';

test('direct sidecar write rejects after one acquisition, with no refetch and no committed record', async t => {
    const host = v2LiveSaveHost(t), id = 'disk-full';
    const url = 'https://encrypted-tbn2.gstatic.com/licensed-image?q=test';
    const bytes = Uint8Array.of(1, 2, 3);
    await seedLiveDetail(id, [{ id: 'search', kind: 'image', name: 'search.png',
        mediaType: 'image/png', sourceUri: url }]);
    host.source(url, bytes, 'image/png');
    host.failWrite('assets/');
    const result = await runLiveSave(liveKey(id));
    assert.ok(result);
    assert.equal(result.exported, 0);
    assert.equal(result.partial, 0);
    assert.deepEqual(result.failed, [liveKey(id)]);
    assert.deepEqual(host.requests, [url], 'a disk error must not refetch already acquired source bytes');
    assert.equal(host.events.filter(event => event.startsWith('write:assets/')).length, 1);
    assert.equal(host.events.filter(event => event.startsWith('abort:assets/')).length, 1);
    assert.equal([...host.files.keys()].filter(name => name.startsWith('assets/')).length, 0);
    assert.ok([...host.files.keys()].some(name => name.endsWith('.md')),
        'Markdown can already have landed before the sidecar error');
    assert.equal(await getExportRecord(liveKey(id)), null, 'no success may be recorded for failed L4 delivery');
});

test('retry after direct disk failure reacquires once and commits exactly the delivered v2 asset', async t => {
    const host = v2LiveSaveHost(t), id = 'disk-recovered';
    const url = 'https://example.test/restored-image.png';
    const bytes = Uint8Array.of(137, 80, 78, 71, 9, 8, 7);
    await seedLiveDetail(id, [{ id: 'restored', kind: 'image', name: 'restored.png',
        mediaType: 'image/png', sourceUri: url }]);
    host.source(url, bytes);
    host.failWrite('assets/');
    const first = await runLiveSave(liveKey(id));
    assert.equal(first?.exported, 0);
    assert.equal(await getExportRecord(liveKey(id)), null);

    host.failWrite(null);
    const retry = await runLiveSave(liveKey(id));
    assert.equal(retry?.exported, 1);
    assert.equal(retry?.partial, 0);
    assert.deepEqual(retry?.failed, []);
    assert.deepEqual(host.requests, [url, url], 'one source acquisition per export attempt');
    const resource = [...host.files.entries()].find(([name]) => name.startsWith('assets/') && name.endsWith('restored.png'));
    assert.ok(resource);
    assert.deepEqual(resource[1], bytes);
    const main = [...host.files.values()].find(value => typeof value === 'string') as string | undefined;
    assert.ok(main);
    assert.ok(main.includes(resource[0]));
    assert.equal((await getExportRecord(liveKey(id)))?.status, 'ok');
});
