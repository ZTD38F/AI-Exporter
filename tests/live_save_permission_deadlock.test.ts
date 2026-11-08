/**
 * V2 Folder authority crosses real L3a handle persistence, Runtime capability
 * controller and Background Live Save. Only native structured-cloneable
 * FileSystemDirectoryHandle and the extension host are faked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveSave } from '../src/runtime/background/liveSaveHandler.js';
import { updateSettings, getSettings } from '../src/application/settings/index.js';
import { getDirectoryHandle } from '../src/l3a/storageService.js';
import { getExportRecord } from '../src/l3a/storageService.js';
import * as Directory from '../src/runtime/capabilities/dirHandleController.js';
import { liveKey, seedLiveDetail, v2LiveSaveHost } from './helpers/v2LiveSaveHost.js';

test('degraded Background Live Save never requests disk permission or writes even when user enabled it', async t => {
    const host = v2LiveSaveHost(t), id = 'degraded-directory';
    Directory.setDirHandle(null);
    t.after(() => Directory.setDirHandle(null));
    await seedLiveDetail(id);
    host.permission('prompt');

    await assert.rejects(runLiveSave(liveKey(id)), /Reauthorize.*Options/);
    assert.equal(host.queryCount(), 1);
    assert.equal(host.requestCount(), 0, 'the worker cannot request user activation');
    assert.equal(host.files.size, 0);
    assert.equal(await getExportRecord(liveKey(id)), null);
    assert.equal((await getSettings()).enabledDisk, true);
});

test('explicit v2 Directory Controller reauthorization retains a pending handle and restores real Live Save', async t => {
    const host = v2LiveSaveHost(t), id = 'reauthorized';
    Directory.setDirHandle(null);
    t.after(() => Directory.setDirHandle(null));
    await seedLiveDetail(id);
    host.permission('prompt');

    assert.equal(await Directory.restoreSavedDirHandle(), null);
    assert.equal(Directory.getPendingPermissionHandle(), host.root);
    assert.equal(Directory.getDirHandle(), null);
    assert.equal(host.requestCount(), 0);
    assert.equal(await Directory.reauthorizeDirHandle(), true);
    assert.equal(host.requestCount(), 1);
    assert.equal(Directory.getPendingPermissionHandle(), null);
    assert.equal(Directory.getDirHandle(), host.root);
    assert.equal(await getDirectoryHandle(), host.root, 'L3a persists the selected capability');

    const result = await runLiveSave(liveKey(id));
    assert.equal(result?.exported, 1);
    assert.equal(result?.partial, 0);
    assert.equal((await getExportRecord(liveKey(id)))?.status, 'ok');
    assert.equal([...host.files.keys()].filter(name => name.endsWith('.md')).length, 1);
    assert.match(String([...host.files.values()][0]), /Answer for reauthorized/);
    assert.equal((await getSettings()).enabledDisk, true);
});

test('disabled Live Save intention remains disabled after restoring a previously granted directory', async t => {
    const host = v2LiveSaveHost(t), id = 'disabled-with-handle';
    Directory.setDirHandle(null);
    t.after(() => Directory.setDirHandle(null));
    await seedLiveDetail(id);
    await updateSettings({ enabledDisk: false });
    assert.equal(await Directory.restoreSavedDirHandle(), host.root);
    assert.equal(Directory.getPendingPermissionHandle(), null);
    assert.equal(await runLiveSave(liveKey(id)), null);
    assert.equal(host.files.size, 0);
    assert.equal(host.requestCount(), 0);
    assert.equal(await getExportRecord(liveKey(id)), null);
});
