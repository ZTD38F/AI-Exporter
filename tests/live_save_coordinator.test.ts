import test from 'node:test';
import assert from 'node:assert/strict';
import { liveCoordinatorHost } from './helpers/liveCoordinatorHost.js';
import { executeLiveSave, cleanup, init } from '../src/runtime/content/liveSaveCoordinator.js';

test('Live Save sends only the accepted ConversationKey to the unified worker and displays its result', async t => {
    const host = await liveCoordinatorHost(t);
    assert.deepEqual(await executeLiveSave(host.key), host.result);
    assert.deepEqual(host.sent, [{ action: 'runLiveSave', key: host.key }]);
    assert.deepEqual(host.feedback, [host.result]);
});
test('disabled Live Save response produces neither success feedback nor a download fallback', async t => {
    const host = await liveCoordinatorHost(t);
    host.reply(async () => ({ ok: true, result: null }));
    assert.equal(await executeLiveSave(host.key), null);
    assert.deepEqual(host.feedback, []);
    assert.deepEqual(host.sent, [{ action: 'runLiveSave', key: host.key }]);
});
for (const error of ['no_dir_handle', 'dir_not_found', 'NotFoundError', 'permission_denied']) {
    test(`Live Save reports ${error} and leaves recovery to the configured folder capability`, async t => {
        const host = await liveCoordinatorHost(t);
        host.reply(async () => ({ ok: false, error }));
        await assert.rejects(executeLiveSave(host.key), new RegExp(error));
        assert.deepEqual(host.errors, [host.key.accountId]);
        assert.deepEqual(host.feedback, []);
        assert.equal(host.sent.length, 1);
    });
}
test('partial Live Save feedback retains the actual result instead of claiming full success', async t => {
    const host = await liveCoordinatorHost(t);
    const partial = { ...host.result, partial: 1 };
    host.reply(async () => ({ ok: true, result: partial }));
    assert.deepEqual(await executeLiveSave(host.key), partial);
    assert.deepEqual(host.feedback, [partial]);
});
test('reinitialization and cleanup suppress feedback from an old pending request', async t => {
    const host = await liveCoordinatorHost(t);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    host.reply(async () => { await gate; return { ok: true, result: host.result }; });
    const pending = executeLiveSave(host.key);
    cleanup(); init({ badge: host.badge }); release();
    await pending;
    assert.deepEqual(host.feedback, []);
    cleanup();
    assert.equal(await executeLiveSave(host.key), null);
    assert.equal(host.sent.length, 1);
});

test('completed reply forwards the refresh requirement to the authenticated worker', async t => {
    const host = await liveCoordinatorHost(t);
    await executeLiveSave(host.key, true);
    assert.deepEqual(host.sent, [{ action: 'runLiveSave', key: host.key, refreshDetail: true }]);
});

test('Live Save rejects malformed IPC results before returning them or notifying Badge', async t => {
    const host = await liveCoordinatorHost(t);
    const invalid = [null, {}, { ok: 1, result: host.result }, { ok: true },
        ...[undefined, false, [], {}, { ...host.result, exported: '1' },
            { ...host.result, skipped: -1 }, { ...host.result, partial: 0.5 },
            { ...host.result, aborted: 0 }, { ...host.result, failed: null },
            { ...host.result, failed: [{ ...host.key, accountId: 'foreign' }] },
            { ...host.result, failed: [{ ...host.key, conversationId: ' padded ' }] },
            { ...host.result, expiredConversations: null }, { ...host.result, otherPartial: -1 },
            { ...host.result, attachmentIssues: {} }, { ...host.result, attachmentIssues: [null] },
            ...[{ resourceId: 1, name: 'file', code: 'FAILED' },
                { resourceId: 'r', name: 'file', code: 1 },
                { resourceId: 'r', name: 'file', code: 'FAILED', sourceUrl: false },
                { resourceId: 'r', name: 'file', code: 'FAILED', httpStatus: '404' }]
                .map(issue => ({ ...host.result, attachmentIssues: [issue] }))]
            .map(result => ({ ok: true, result }))];
    for (const reply of invalid) {
        host.reply(async () => reply);
        await assert.rejects(executeLiveSave(host.key), /Live Save|conversation key/);
        assert.deepEqual(host.feedback, []);
    }
    assert.equal(host.errors.length, invalid.length);
});

test('Live Save decodes complete failure and attachment details without changing their values', async t => {
    const host = await liveCoordinatorHost(t);
    const result = { ...host.result, failed: [host.key], partial: 1, expiredConversations: 1, otherPartial: 0,
        attachmentIssues: [{ resourceId: 'r', name: 'file', code: 'RESOURCE_SOURCE_EXPIRED',
            sourceUrl: 'https://example.test/file', httpStatus: 404 }] };
    host.reply(async () => ({ ok: true, result }));
    assert.deepEqual(await executeLiveSave(host.key), result);
    assert.deepEqual(host.feedback, [result]);
    assert.deepEqual(host.errors, []);
});
