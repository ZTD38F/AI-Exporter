import test from 'node:test';
import assert from 'node:assert/strict';
import { runExport } from '../src/application/export/runExport.js';
import { getExportRecord } from '../src/l3a/storageService.js';
import { v2ExportHost, exportKey, exportRequest, seedExportConversation } from './helpers/v2ExportHost.js';
import { __setZipConstructor, __getZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';
import { handleGetImageBlob } from '../src/runtime/capabilities/assetFetcher.js';
const JSZip = require('../lib/jszip.min.js');

// P1-023: progress is now an Application callback with current/total, not
// a removed ExportOrchestrator ProgressReporter. Assert actual v2 delivery too.
test('P1-023: v2 multi-chat export progress stays ordered and each delivered key gets a Record', async t => {
    const host = v2ExportHost(t);
    const previousZip = __getZipConstructor();
    __setZipConstructor(JSZip);
    t.after(() => __setZipConstructor(previousZip));
    const ids = ['progress-a', 'progress-b', 'progress-c', 'progress-d'];
    for (const id of ids) await seedExportConversation(id);
    const updates: Array<{ current: number; total: number; id: string }> = [];
    const result = await runExport(exportRequest(ids), { onProgress: ({ current, total, key }) => {
        updates.push({ current, total, id: key.conversationId });
    } });

    assert.equal(result.exported, 4);
    assert.deepEqual(result.failed, []);
    assert.equal(host.clicks(), 1, 'one ZIP is delivered for the full batch');
    assert.deepEqual(updates, ids.map((id, i) => ({ current: i + 1, total: ids.length, id })));
    const zip = await JSZip.loadAsync(await host.blobs[0].arrayBuffer());
    const bodies = await Promise.all(Object.values(zip.files)
        .filter((entry: any) => !entry.dir && entry.name.endsWith('.md'))
        .map((entry: any) => entry.async('string')));
    assert.equal(bodies.length, ids.length);
    for (const id of ids) {
        assert.ok(bodies.some((body: string) => body.includes('Answer for ' + id)));
        assert.equal((await getExportRecord(exportKey(id)))?.status, 'ok');
    }
});

// P1-027: a large image may travel as raw bytes, but not through Base64 encoding.
test('P1-027: >50 MiB image succeeds as a buffer and is rejected as Base64', async () => {
    const originalFetch = globalThis.fetch;
    const bytes = new Uint8Array([1, 2, 3]);
    const oversize = {
        size: 51 * 1024 * 1024,
        type: 'image/png',
        arrayBuffer: async () => bytes.buffer,
    };
    globalThis.fetch = (async () => {
        return {
            ok: true, status: 200,
            headers: { get: () => 'image/png' },
            blob: async () => oversize,
        } as unknown as Response;
    }) as typeof fetch;
    try {
        const replies: Array<{ success: boolean; dataBuffer?: ArrayBuffer; error?: string }> = [];
        await handleGetImageBlob(
            { url: 'https://lh3.googleusercontent.com/example', preferBuffer: true },
            (reply) => replies.push(reply)
        );
        assert.equal(replies.length, 1);
        assert.equal(replies[0].success, true);
        assert.deepEqual(new Uint8Array(replies[0].dataBuffer!), bytes);

        replies.length = 0;
        await handleGetImageBlob(
            { url: 'https://lh3.googleusercontent.com/example', preferBuffer: false },
            (reply) => replies.push(reply)
        );
        assert.equal(replies.length, 1);
        assert.equal(replies[0].success, false);
        assert.match(replies[0].error || '', /too large/i);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

// P1-036: ensure an active rate-limit cooldown can be interrupted.


// P1-037: stagger is an externally observable delay, not a variable-name contract.

