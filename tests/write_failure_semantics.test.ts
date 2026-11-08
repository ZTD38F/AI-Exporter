/**
 * V2 write/commit failure semantics, on the real Export pipeline.
 *
 * The removed BatchWorker's 00_INDEX.md and _export_dev.log writers are not
 * v2 delivery artifacts. Failure boundaries are now Packaging, Delivery,
 * and the post-delivery ExportRecord write; no v1 compatibility mocks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runExport } from '../src/application/export/runExport.js';
import { getExportRecord, putExportRecord } from '../src/l3a/storageService.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { readConversation } from '../src/l2/readConversation.js';
import { ProviderRegistry } from '../src/l1/client/providerRegistry.js';
import { __getZipConstructor, __setZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';
import { makeTestExportProvider } from './helpers/makeTestWorker.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { v2ExportHost, exportKey, exportRequest, seedExportConversation } from './helpers/v2ExportHost.js';

const JSZip = require('../lib/jszip.min.js');

test('failed Browser Download start does not replace a previous ExportRecord and is retryable', async t => {
    let rejectDownload = true;
    const host = v2ExportHost(t, () => {
        if (rejectDownload) throw new Error('Browser download rejected');
    });
    const id = 'write-failure-retry';
    await seedExportConversation(id);
    const previous = { exportedAt: 12, format: 'html' as const, status: 'ok' as const, chatTime: 95 };
    await putExportRecord(exportKey(id), previous);

    const failed = await runExport(exportRequest([id]));
    assert.equal(failed.exported, 0);
    assert.equal(failed.partial, 0);
    assert.deepEqual(failed.failed, [exportKey(id)]);
    assert.equal(host.clicks(), 1, 'the actual download action was attempted');
    assert.deepEqual(await getExportRecord(exportKey(id)), previous);

    rejectDownload = false;
    const retried = await runExport(exportRequest([id]));
    assert.equal(retried.exported, 1);
    assert.deepEqual(retried.failed, []);
    assert.equal(host.clicks(), 2);
    assert.match(await host.blobs[1].text(), /Answer for write-failure-retry/);
    const record = await getExportRecord(exportKey(id));
    assert.equal(record?.format, 'markdown');
    assert.equal(record?.status, 'ok');
    assert.equal(record?.chatTime, 100);
    assert.ok((record?.exportedAt ?? 0) > previous.exportedAt);
});

test('ZIP writer error while staging multiple conversations fails all Keys before any delivery', async t => {
    const host = v2ExportHost(t);
    const previous = __getZipConstructor();
    const attempted: string[] = [];
    __setZipConstructor(class {
        file(path: string) {
            attempted.push(path);
            if (attempted.length === 2) throw new Error('Second staged Markdown failed');
        }
        async generateAsync(): Promise<never> { throw new Error('ZIP should not generate after a file failure'); }
    });
    t.after(() => __setZipConstructor(previous));
    await seedExportConversation('staged-one');
    await seedExportConversation('staged-two');

    const failed = await runExport(exportRequest(['staged-one', 'staged-two']));
    assert.equal(failed.exported, 0);
    assert.deepEqual(failed.failed, [exportKey('staged-one'), exportKey('staged-two')]);
    assert.equal(attempted.length, 2, 'failure occurs in the actual v2 ZIP file writer');
    assert.ok(attempted.every(path => path.endsWith('.md')));
    assert.equal(host.clicks(), 0, 'a staged ZIP is not a delivered file');
    assert.equal(await getExportRecord(exportKey('staged-one')), null);
    assert.equal(await getExportRecord(exportKey('staged-two')), null);

    __setZipConstructor(JSZip);
    const retried = await runExport(exportRequest(['staged-one', 'staged-two']));
    assert.equal(retried.exported, 2);
    assert.deepEqual(retried.failed, []);
    assert.equal(host.clicks(), 1);
    assert.match(host.filenames[0], /\.zip$/);
    const zip = await JSZip.loadAsync(await host.blobs[0].arrayBuffer());
    assert.equal(Object.keys(zip.files).filter(name => name.endsWith('.md')).length, 2);
});

test('a failed ExportRecord write is reported only after real delivery; retry succeeds', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('record-write-failure');
    host.failStorage('exportRecords');

    const failed = await runExport(exportRequest(['record-write-failure']));
    assert.equal(host.clicks(), 1, 'download was started before the record was attempted');
    assert.equal(failed.exported, 0);
    assert.deepEqual(failed.failed, [exportKey('record-write-failure')]);
    assert.equal(await getExportRecord(exportKey('record-write-failure')), null);

    host.failStorage();
    const retried = await runExport(exportRequest(['record-write-failure']));
    assert.equal(retried.exported, 1);
    assert.deepEqual(retried.failed, []);
    assert.equal(host.clicks(), 2);
    assert.equal((await getExportRecord(exportKey('record-write-failure')))?.status, 'ok');
});

test('a missing companion resource leaves a readable main file and a partial record after delivery', async t => {
    const host = v2ExportHost(t);
    const previousZip = __getZipConstructor();
    __setZipConstructor(JSZip);
    t.after(()=>__setZipConstructor(previousZip));
    const account = fixtureAccount('custom');
    const id = 'missing-companion';
    const key = { accountId: account.id, conversationId: id };
    const priorProvider = ProviderRegistry.get('custom');
    let acquisitions = 0;
    ProviderRegistry.register(makeTestExportProvider({
        id: 'custom',
        async acquireResource(receivedKey, asset) {
            assert.deepEqual(receivedKey, key);
            assert.equal(asset.id, 'missing-file');
            acquisitions++;
            throw new Error('Source file unavailable');
        },
    }));
    t.after(() => {
        ProviderRegistry.unregister('custom');
        if (priorProvider) ProviderRegistry.register(priorProvider);
    });
    await ingestDetail(account.id, id, {
        savedAt: 100, quality: { status: 'complete' },
        assets: [{ id: 'missing-file', kind: 'file', name: 'attachment.txt', mediaType: 'text/plain' }],
        messages: [{
            role: 'assistant',
            content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Readable main answer' }] }],
            attachmentIds: ['missing-file'],
        }],
    }, { title: 'Missing companion', titleSource: 'provider', updatedAt: 100 });
    const before = await readConversation(key);

    const result = await runExport({ ...exportRequest([]), keys: [key], includeAssets: true });
    assert.equal(acquisitions, 1);
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 1);
    assert.deepEqual(result.failed, []);
    assert.equal(host.clicks(), 1);
    assert.match(host.filenames[0], /\.zip$/);
    assert.equal(host.blobs.length, 1, 'the final ZIP includes the document and failure report');
    const zip = await JSZip.loadAsync(await host.blobs[0].arrayBuffer());
    const name = Object.keys(zip.files).find(name => name.endsWith('.md'));
    assert.ok(name);
    assert.match(await zip.file(name).async('string'), /Readable main answer/);
    assert.equal((await getExportRecord(key))?.status, 'partial');
    assert.deepEqual(await readConversation(key), before, 'resource acquisition never alters the trusted Domain');
});
