import test from 'node:test';
import assert from 'node:assert/strict';
import { v2LiveSaveHost, seedLiveDetail, liveKey } from './helpers/v2LiveSaveHost.js';
import { runLiveSave } from '../src/runtime/background/liveSaveHandler.js';
import { getDetail, getExportRecord } from '../src/l3a/storageService.js';
import { getSettings, updateSettings } from '../src/application/settings/index.js';

// v2 has no content-side RPC/DOM resolver, mock-success mode, image writer or
// second queue. Real Domain -> unified Export -> Folder Writer owns these cases.
test('Live Save exports committed authoritative Domain without a content scraper or active refresh', async t => {
    const host = v2LiveSaveHost(t);
    await seedLiveDetail('authority', [], { title: 'RPC Authority Title' });
    const before = await getDetail(liveKey('authority'));
    const result = await runLiveSave(liveKey('authority'));
    assert.equal(result?.exported, 1);
    assert.deepEqual(await getDetail(liveKey('authority')), before);
    assert.deepEqual(host.requests, []);
    assert.ok([...host.files.values()].some(text => typeof text === 'string' && text.includes('RPC Authority Title')));
});
for (const permission of ['denied', 'prompt'] as const) {
    test(`Live Save never prompts or downloads when folder permission is ${permission}`, async t => {
        const host = v2LiveSaveHost(t);
        await seedLiveDetail('permission'); host.permission(permission);
        await assert.rejects(runLiveSave(liveKey('permission')), /Reauthorize/);
        assert.equal(host.requestCount(), 0);
        assert.equal(host.files.size, 0);
        assert.equal((await getSettings()).enabledDisk, true, 'preserve user enablement intent');
        assert.equal(await getExportRecord(liveKey('permission')), null);
    });
}
test('missing directory does not start acquisition or publish success', async t => {
    const host = v2LiveSaveHost(t);
    await seedLiveDetail('no-directory'); host.directory(null);
    await assert.rejects(runLiveSave(liveKey('no-directory')), /Choose a Live Save directory/);
    assert.equal(host.files.size, 0); assert.deepEqual(host.requests, []);
    assert.equal((await getSettings()).enabledDisk, true);
});
test('non-Markdown settings disable Live Save without resetting the user preference', async t => {
    const host = v2LiveSaveHost(t);
    await seedLiveDetail('format'); await updateSettings({ defaultFormat: 'pdf' });
    assert.equal(await runLiveSave(liveKey('format')), null);
    assert.equal(host.files.size, 0);
    assert.equal((await getSettings()).enabledDisk, true);
});
test('missing source bytes produce visible placeholders, a partial record and unchanged source facts', async t => {
    const host = v2LiveSaveHost(t), key = liveKey('missing');
    await seedLiveDetail(key.conversationId, [{ id: 'image', kind: 'image', sourceUri: 'https://example.test/missing.png' }]);
    const before = await getDetail(key);
    const result = await runLiveSave(key);
    assert.equal(result?.exported, 1); assert.equal(result?.partial, 1);
    assert.equal((await getExportRecord(key))?.status, 'partial');
    assert.equal([...host.files.keys()].some(path => path.startsWith('assets/')), false);
    assert.ok([...host.files.values()].some(text => typeof text === 'string' && text.includes('Attachment failed: Unknown error')));
    assert.deepEqual(await getDetail(key), before);
});
test('same authored asset names receive distinct physical paths with exact binary views', async t => {
    const host = v2LiveSaveHost(t), key = liveKey('collision');
    const raw = Uint8Array.of(99, 1, 2, 3, 88);
    const bytes = [raw.subarray(1, 4), Uint8Array.of(4, 5, 6)];
    const assets = bytes.map((_, index) => ({ id: 'image-' + index, kind: 'image' as const, name: 'same.png', sourceUri: 'https://example.test/' + index }));
    await seedLiveDetail(key.conversationId, assets);
    assets.forEach((asset, index) => host.source(asset.sourceUri, bytes[index]));
    const before = await getDetail(key);
    assert.equal((await runLiveSave(key))?.exported, 1);
    const files = [...host.files.entries()].filter(([path]) => path.startsWith('assets/'));
    assert.equal(files.length, 2); assert.notEqual(files[0][0], files[1][0]);
    for (const value of bytes) assert.ok(files.some(([, data]) => data instanceof Uint8Array && Buffer.from(data).equals(Buffer.from(value))));
    const md = [...host.files.values()].find(value => typeof value === 'string') as string;
    files.forEach(([path]) => assert.ok(md.includes(path)));
    assert.deepEqual(await getDetail(key), before);
});
test('a multi-image turn completes every image once without retaining resource bytes in Domain', async t => {
    const host = v2LiveSaveHost(t);
    const assets = Array.from({ length: 9 }, (_, index) => ({ id: 'image-' + index, kind: 'image' as const, name: index + '.png', sourceUri: 'https://example.test/' + index }));
    await seedLiveDetail('many', assets);
    assets.forEach((asset, index) => host.source(asset.sourceUri, Uint8Array.of(index + 1)));
    const result = await runLiveSave(liveKey('many'));
    assert.equal(result?.exported, 1); assert.equal(result?.partial, 0);
    assert.equal(host.requests.length, 9);
    assert.equal([...host.files.keys()].filter(path => path.startsWith('assets/')).length, 9);
    assert.ok(!JSON.stringify(await getDetail(liveKey('many'))).includes('dataBase64'));
});
test('write failure does not poison the next Live Save task and only the delivered task gets a record', async t => {
    const host = v2LiveSaveHost(t);
    await seedLiveDetail('first'); await seedLiveDetail('second');
    host.failWrite('.md');
    assert.equal((await runLiveSave(liveKey('first')))?.exported, 0);
    host.failWrite(null);
    assert.equal((await runLiveSave(liveKey('second')))?.exported, 1);
    assert.equal(await getExportRecord(liveKey('first')), null);
    assert.equal((await getExportRecord(liveKey('second')))?.status, 'ok');
});
