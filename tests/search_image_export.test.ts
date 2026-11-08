import test from 'node:test';
import assert from 'node:assert/strict';
import { v2LiveSaveHost, seedLiveDetail, liveKey } from './helpers/v2LiveSaveHost.js';
import { runLiveSave } from '../src/runtime/background/liveSaveHandler.js';
import { getExportRecord } from '../src/l3a/storageService.js';

test('search image export acquires bytes from the extension context and writes the actual image', async t => {
    const host = v2LiveSaveHost(t), key = liveKey('search');
    const url = 'https://encrypted-tbn2.gstatic.com/licensed-image?q=test';
    const bytes = Uint8Array.of(1, 2, 3);
    await seedLiveDetail(key.conversationId, [{ id: 'search-image', kind: 'image', name: 'search.png', sourceUri: url }]);
    host.source(url, bytes);
    assert.equal((await runLiveSave(key))?.exported, 1);
    assert.deepEqual(host.requests, [url]);
    const asset = [...host.files.entries()].find(([name]) => name.startsWith('assets/') && name.endsWith('search.png'));
    assert.ok(asset); assert.deepEqual(asset[1], bytes);
    assert.ok([...host.files.values()].some(value => typeof value === 'string' && value.includes(asset[0])));
    assert.equal((await getExportRecord(key))?.status, 'ok');
});
test('missing search images preserve the HTTP error and never create a fake successful asset', async t => {
    const host = v2LiveSaveHost(t), key = liveKey('missing-search');
    const url = 'https://encrypted-tbn2.gstatic.com/licensed-image?q=missing';
    await seedLiveDetail(key.conversationId, [{ id: 'missing', kind: 'image', sourceUri: url }]);
    t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
    const { prepareExportResources } = require('../src/application/export/prepareExportResources.js');
    const { acquireSourceResource } = require('../src/l1/resources/sourceResources.js');
    const results = await prepareExportResources([{ id: 'missing', kind: 'image', sourceUri: url }], new Set(['missing']), acquireSourceResource);
    assert.equal(results.get('missing')?.ok, false);
    assert.match(results.get('missing').reason, /404/);
    const result = await runLiveSave(key);
    assert.equal(result?.partial, 1);
    assert.equal([...host.files.keys()].some(name => name.startsWith('assets/')), false);
    assert.equal((await getExportRecord(key))?.status, 'partial');
});
