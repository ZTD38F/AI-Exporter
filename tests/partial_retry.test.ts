/**
 * Real v2 Live Save / Export partial-retry behavior:
 * L2 Detail -> L3a Index/Detail -> L1 resource -> Application -> L3b/L4
 * Folder Writer -> committed minimal ExportRecord. External disk and HTTP only
 * are simulated. The v1 asset Base64, 'hasFailedAssets' and StorageService
 * APIs were intentionally removed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveSave } from '../src/runtime/background/liveSaveHandler.js';
import { runExport } from '../src/application/export/runExport.js';
import { getExportRecord, listExportRecords } from '../src/l3a/storageService.js';
import { updateSettings, getSettings } from '../src/application/settings/index.js';
import { liveKey, seedLiveDetail, v2LiveSaveHost } from './helpers/v2LiveSaveHost.js';

const png = (id: string, url: string) => ({ id, kind: 'image' as const,
    name: id + '.png', sourceUri: url, mediaType: 'image/png' });
const request = (id: string) => ({ keys: [liveKey(id)], format: 'markdown' as const,
    delivery: 'folderWriter' as const, includeAssets: true, skipUnchanged: true });
function markdown(files: Map<string, string | Uint8Array>): string {
    const result = [...files.entries()].find(([name]) => name.endsWith('.md') && !name.startsWith('files/'));
    assert.ok(result, 'the real folder writer must have saved Markdown');
    assert.equal(typeof result[1], 'string');
    return result[1] as string;
}

test('Live Save: unavailable bytes write readable partial Markdown, remain retryable at the same source version, then recover', async t => {
    const host = v2LiveSaveHost(t), id = 'retry-image', url = 'https://example.test/retry.png';
    await seedLiveDetail(id, [png('image', url)], { title: 'Attachment retry' });
    host.source(url, null);

    const first = await runLiveSave(liveKey(id));
    assert.ok(first);
    assert.equal(first.exported, 1);
    assert.equal(first.partial, 1);
    assert.deepEqual(first.failed, []);
    assert.match(markdown(host.files), /Answer for retry-image/);
    assert.match(markdown(host.files), /\[Open source\]\(https:\/\/example\.test\/retry\.png\)/);
    assert.doesNotMatch(markdown(host.files), /!\[[^\]]*\]\(https:/);
    assert.equal([...host.files.keys()].filter(name => name.startsWith('assets/')).length, 0);
    assert.equal((await getExportRecord(liveKey(id)))?.status, 'partial');
    assert.deepEqual(Object.keys(await listExportRecords(liveKey(id).accountId)), [id]);

    // SkipUnchanged applies only to a matching 'ok' record, never a partial.
    const stillFailed = await runExport(request(id));
    assert.equal(stillFailed.skipped, 0);
    assert.equal(stillFailed.exported, 1);
    assert.equal(stillFailed.partial, 1);

    const bytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7);
    host.source(url, bytes);
    const recovered = await runLiveSave(liveKey(id));
    assert.ok(recovered);
    assert.equal(recovered.exported, 1);
    assert.equal(recovered.partial, 0);
    assert.equal((await getExportRecord(liveKey(id)))?.status, 'ok');

    const asset = [...host.files.entries()].find(([name]) => name.startsWith('assets/') && name.endsWith('.png'));
    assert.ok(asset);
    assert.deepEqual(asset[1], bytes);
    assert.ok(markdown(host.files).includes(asset[0]), 'recovered Markdown uses its actual saved asset path');
    const unchanged = await runExport(request(id));
    assert.equal(unchanged.skipped, 1);
    assert.equal(unchanged.exported, 0);
    assert.equal(Object.keys(await listExportRecords(liveKey(id).accountId)).length, 1);
});

test('Live Save: local attachments survive source failure, while deleted attachments remain retryable', async t => {
    const host = v2LiveSaveHost(t), id = 'source-regressed', url = 'https://example.test/dynamic.png';
    await seedLiveDetail(id, [png('fresh-image', url)]);
    host.source(url, Uint8Array.of(12, 34, 56));
    const first = await runLiveSave(liveKey(id));
    assert.equal(first?.exported, 1);
    assert.equal(first?.partial, 0);
    assert.equal((await getExportRecord(liveKey(id)))?.status, 'ok');

    host.source(url, null);
    const second = await runLiveSave(liveKey(id));
    assert.equal(second?.exported, 1, 'Live Save is triggered by accepted Detail changes, not by skipUnchanged');
    assert.equal(second?.partial, 0);
    assert.equal((await getExportRecord(liveKey(id)))?.status, 'ok');
    assert.match(markdown(host.files), /assets\//, 'existing local bytes remain usable when their source expires');
    assert.deepEqual(host.requests, [url], 'the existing file bypasses reacquisition');
    for (const path of host.files.keys()) if (path.startsWith('assets/')) host.files.delete(path);
    const missing = await runLiveSave(liveKey(id));
    assert.equal(missing?.partial, 1);
    assert.equal((await getExportRecord(liveKey(id)))?.status, 'partial');
    assert.doesNotMatch(markdown(host.files), /assets\//, 'a missing local file with an unavailable source cannot retain a dangling link');
    const pending = await runExport(request(id));
    assert.equal(pending.skipped, 0);
    assert.equal(pending.partial, 1);
});

test('Live Save: an L4 folder-sidecar write error preserves a written Markdown file but never commits a successful record', async t => {
    const host = v2LiveSaveHost(t), id = 'disk-fails', url = 'https://example.test/disk.png';
    await seedLiveDetail(id, [png('image', url)]);
    host.source(url, Uint8Array.of(1, 2, 3, 4));
    host.failWrite('assets/');
    const failed = await runLiveSave(liveKey(id));
    assert.ok(failed);
    assert.equal(failed.exported, 0);
    assert.deepEqual(failed.failed, [liveKey(id)]);
    assert.equal(await getExportRecord(liveKey(id)), null);
    assert.ok([...host.files.keys()].some(name => name.endsWith('.md')));
    assert.ok(![...host.files.keys()].some(name => name.startsWith('assets/')));
    assert.ok(host.events.some(event => event.startsWith('abort:assets/')));

    host.failWrite(null);
    const retried = await runLiveSave(liveKey(id));
    assert.equal(retried?.exported, 1);
    assert.equal(retried?.partial, 0);
    assert.equal((await getExportRecord(liveKey(id)))?.status, 'ok');
    assert.ok([...host.files.keys()].some(name => name.startsWith('assets/')));
});

test('Live Save: a missing or revoked directory prompts reauthorization without asking permission in the Worker', async t => {
    const host = v2LiveSaveHost(t), id = 'permission';
    await seedLiveDetail(id);
    host.directory(null);
    await assert.rejects(runLiveSave(liveKey(id)), /Choose a Live Save directory in Options/);
    host.directory(host.root);
    host.permission('prompt');
    await assert.rejects(runLiveSave(liveKey(id)), /Reauthorize the Live Save directory in Options/);
    assert.equal(host.requestCount(), 0);
    assert.equal(host.queryCount(), 1);
    assert.equal(host.files.size, 0);
    assert.equal(await getExportRecord(liveKey(id)), null);
    assert.equal((await getSettings()).enabledDisk, true, 'intention is retained for explicit reauthorization');
});

test('Live Save: disabled intention or non-Markdown format does not touch the directory or create records', async t => {
    const host = v2LiveSaveHost(t), id = 'paused-live';
    await seedLiveDetail(id);
    await updateSettings({ enabledDisk: false });
    assert.equal(await runLiveSave(liveKey(id)), null);
    await updateSettings({ enabledDisk: true, defaultFormat: 'pdf' });
    assert.equal(await runLiveSave(liveKey(id)), null);
    await updateSettings({ defaultFormat: 'html' });
    assert.equal(await runLiveSave(liveKey(id)), null);
    assert.equal(host.queryCount(), 0);
    assert.equal(host.requestCount(), 0);
    assert.equal(host.files.size, 0);
    assert.equal(await getExportRecord(liveKey(id)), null);
});
