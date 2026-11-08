import test from 'node:test';
import assert from 'node:assert/strict';
import { runExport } from '../src/application/export/runExport.js';
import { getExportRecord } from '../src/l3a/storageService.js';
import { __getZipConstructor, __setZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';
import { ingestDetail, ingestIndexes } from '../src/l2/ingestion.js';
import { getOrCreateAccount } from '../src/runtime/api/accountRegistry.js';
import { sessionGen } from './fixtures/providers/chatgptSession.js';
import { handleHttp429 } from '../src/l1/client/gemini/api/retryPolicy.js';
import { v2ExportHost, exportKey, exportRequest, seedExportConversation, readDeliveredFiles } from './helpers/v2ExportHost.js';

/**
 * V2 cancellation ownership:
 * - Application uses one AbortSignal, not an ExportOrchestrator session.
 * - Cancelled linked batches salvage staged files; only delivered, settled items get records.
 * - Real delivery errors fail keys without being mistaken for user abort.
 * - Once delivery is accepted, cancellation cannot retroactively erase Records.
 */

test('cancellation packages completed staged bodies into a readable ZIP and records only delivered keys', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('cancel-first');
    await seedExportConversation('cancel-second');
    await seedExportConversation('cancel-third');
    const zip = __getZipConstructor();
    __setZipConstructor(require('../lib/jszip.min.js'));
    t.after(() => __setZipConstructor(zip));
    const controller = new AbortController();
    const progress: number[] = [];

    const result = await runExport(exportRequest(['cancel-first', 'cancel-second', 'cancel-third']), {
        signal: controller.signal,
        onProgress: item => {
            progress.push(item.current);
            if (item.current === 3) controller.abort();
        },
    });

    assert.deepEqual(progress, [1, 2, 3]);
    assert.equal(result.aborted, true);
    assert.equal(result.exported, 2);
    assert.equal(result.partial, 0);
    assert.deepEqual(result.failed, []);
    assert.equal(host.clicks(), 1);
    assert.match(host.filenames[0], /\.zip$/);
    const files = await readDeliveredFiles(host);
    assert.equal(files.length, 2);
    const text = (await Promise.all(files.map(file => file.async('string')))).join('\n');
    assert.match(text, /Answer for cancel-first/);
    assert.match(text, /Answer for cancel-second/);
    assert.doesNotMatch(text, /Answer for cancel-third/);
    assert.equal((await getExportRecord(exportKey('cancel-first')))?.status, 'ok');
    assert.equal((await getExportRecord(exportKey('cancel-second')))?.status, 'ok');
    assert.equal(await getExportRecord(exportKey('cancel-third')), null);
});

test('host permission revocation fails the delivered key, not the v2 AbortSignal', async t => {
    const host = v2ExportHost(t, () => {
        throw new DOMException('Download permission was revoked', 'NotAllowedError');
    });
    await seedExportConversation('permission-revoked');
    const result = await runExport(exportRequest(['permission-revoked']));

    assert.equal(host.clicks(), 1);
    assert.equal(result.aborted, false, 'a host error is not a user cancellation');
    assert.equal(result.exported, 0);
    assert.deepEqual(result.failed, [exportKey('permission-revoked')]);
    assert.equal(await getExportRecord(exportKey('permission-revoked')), null);
});

test('real L1 429 backoff obeys the same AbortSignal and never waits out 30 seconds', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = handleHttp429({
        resp: { status: 429, headers: { get: () => '30' } },
        retryAfterMs: 30_000,
        signal: controller.signal,
    });
    controller.abort();

    const response = await pending;
    assert.deepEqual(response, { shouldRetry: false, aborted: true });
    assert.ok(Date.now() - started < 1500, 'abort must interrupt rate-limit backoff immediately');
});

test('cancel during confirmed browser delivery cannot roll back the v2 ExportRecord', async t => {
    const controller = new AbortController();
    const host = v2ExportHost(t, () => controller.abort());
    await seedExportConversation('already-delivered');

    const result = await runExport(exportRequest(['already-delivered']), { signal: controller.signal });

    assert.equal(host.clicks(), 1);
    assert.equal(result.exported, 1, 'L4 delivery preceded and committed the v2 record');
    assert.deepEqual(result.failed, []);
    assert.equal(result.aborted, true, 'the caller signal still reports its final state');
    assert.equal((await getExportRecord(exportKey('already-delivered')))?.status, 'ok');
    assert.match(await host.blobs[0].text(), /Answer for already-delivered/);

    // The next task owns a fresh AbortSignal. No stale cancellation/session state.
    const retry = await runExport(exportRequest(['already-delivered'], { skipUnchanged: true }));
    assert.equal(retry.aborted, false);
    assert.equal(retry.skipped, 1);
    assert.equal(retry.exported, 0);
    assert.equal(host.clicks(), 1);
});

test('cancel requested by a new task does not erase previous committed v2 records', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('committed');
    await seedExportConversation('new-pending');
    const first = await runExport(exportRequest(['committed']));
    assert.equal(first.exported, 1);
    assert.equal(host.clicks(), 1);

    const controller = new AbortController();
    const second = await runExport(exportRequest(['new-pending']), {
        signal: controller.signal, onProgress: () => controller.abort(),
    });
    assert.equal(second.aborted, true);
    assert.equal(second.exported, 0);
    assert.deepEqual(second.failed, []);
    assert.equal(host.clicks(), 1);
    assert.equal(await getExportRecord(exportKey('new-pending')), null);
    assert.equal((await getExportRecord(exportKey('committed')))?.status, 'ok');
});

for (const stage of ['source', 'attachment'] as const) {
    test(`real ChatGPT ${stage} 429 stops the batch and salvages readable files without false success`, async t => {
        const host = v2ExportHost(t);
        const zip = __getZipConstructor();
        __setZipConstructor(require('../lib/jszip.min.js'));
        t.after(() => __setZipConstructor(zip));
        const account = await getOrCreateAccount('chatgpt', JSON.stringify(['export-user', 'export-space']));
        const keys = ['first', 'second', 'limited'].map(conversationId => ({ accountId: account.id, conversationId }));
        for (const key of keys.slice(0, stage === 'source' ? 2 : 3)) {
            const hasAsset = stage === 'attachment' && key.conversationId === 'limited'
                || stage === 'source' && key.conversationId === 'first';
            await ingestDetail(account.id, key.conversationId, {
                savedAt: 100, quality: { status: 'complete', sourceTurn: 'finished' },
                assets: hasAsset ? [{ id: 'file', kind: 'file', name: 'pending.txt', sourceUri: stage === 'source' ? 'https://example.test/ready.txt' : 'sediment://file_pending' }] : [],
                messages: [{ role: 'assistant', content: [
                    { type: 'paragraph', children: [{ type: 'text', text: 'Saved body ' + key.conversationId }] },
                    ...(hasAsset ? [{ type: 'file' as const, assetId: 'file' }] : []),
                ] }],
            }, { title: key.conversationId, titleSource: 'provider', updatedAt: 100 });
        }
        if (stage === 'source') await ingestIndexes(account.id, [{ conversationId: 'limited', fields: {
            title: 'limited', titleSource: 'provider', updatedAt: 100,
        } }]);
        let calls = 0;
        let acquired = () => {};
        const completedAsset = new Promise<void>(resolve => { acquired = resolve; });
        t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
            if (String(input).endsWith('/api/auth/session')) return Response.json(sessionGen(
                stage === 'source' ? 'C_EXPORT_CANCEL_429_SOURCE_SESSION' : 'C_EXPORT_CANCEL_429_ASSET_SESSION'));
            if (String(input) === 'https://example.test/ready.txt') return new Response('SAVED ATTACHMENT', { headers: { 'Content-Type': 'text/plain' } });
            calls++;
            if (stage === 'source') {
                await completedAsset;
                await new Promise(resolve => setImmediate(resolve));
            }
            return new Response(null, { status: 429, headers: { 'Retry-After': '24' } });
        });
        const result = await runExport({ ...exportRequest([]), keys, includeAssets: true }, {
            onResourceProgress: p => { if (p.downloaded === 1) acquired(); },
        });
        assert.equal(result.aborted, true);
        assert.equal(result.exported, 2);
        assert.deepEqual(result.failed, []);
        assert.ok(result.rateLimitedUntil && result.rateLimitedUntil >= Date.now() + 3_590_000);
        assert.equal(calls, 1, 'no retry or next source request after the first 429');
        const files = await readDeliveredFiles(host);
        assert.equal(files.length, 3);
        if (stage === 'source') {
            const attachment = files.find(file => file.name.startsWith('files/'));
            assert.ok(attachment);
            assert.equal(await attachment.async('string'), 'SAVED ATTACHMENT');
        }
        const text = (await Promise.all(files.map(file => file.async('string')))).join('\n');
        assert.match(text, /Saved body first/);
        assert.match(text, /Saved body second/);
        assert.equal((await getExportRecord(keys[0]))?.status, 'ok');
        assert.equal((await getExportRecord(keys[1]))?.status, 'ok');
        assert.equal(await getExportRecord(keys[2]), null, 'unfinished source/attachment work has no success record');
        const retry = await runExport({ ...exportRequest([]), keys: [keys[2]], includeAssets: true });
        assert.equal(retry.aborted, true);
        assert.equal(retry.rateLimitedUntil, result.rateLimitedUntil);
        assert.equal(calls, 1, 'a new export cannot bypass the persisted cooldown');
    });
}

test('ZIP delivery failure during cancellation is reported without writing success records', async t => {
    const controller = new AbortController();
    v2ExportHost(t, () => { throw new DOMException('Download denied', 'NotAllowedError'); });
    await seedExportConversation('staged-failure');
    await seedExportConversation('never-started');
    const result = await runExport(exportRequest(['staged-failure', 'never-started']), {
        signal: controller.signal, onProgress: p => { if (p.current === 2) controller.abort(); },
    });
    assert.equal(result.aborted, true);
    assert.equal(result.exported, 0);
    assert.deepEqual(result.failed, [exportKey('staged-failure')]);
    assert.equal(await getExportRecord(exportKey('staged-failure')), null);
});
