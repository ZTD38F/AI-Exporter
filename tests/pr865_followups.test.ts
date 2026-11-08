import test from 'node:test';
import { __getZipConstructor, __setZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';
import assert from 'node:assert/strict';
import { admitFixture } from './helpers/admitFixture.js';
import { bindFixture, fixtureAccount } from './helpers/domainFixture.js';
import { historicalFixture } from './helpers/nativeFixture.js';
import { makeConversationIndex } from './helpers/conversationIndexFixture.js';
import { useIndexStorage } from './helpers/indexStorage.js';
import { runExport, shouldSkipExport } from '../src/application/export/runExport.js';
import type { ExportRequest } from '../src/application/export/types.js';
import { scanAll } from '../src/application/sync/scanController.js';
import { ingestDeletedConversation } from '../src/l2/ingestion.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';
import { ProviderRegistry } from '../src/l1/client/providerRegistry.js';
import type { AIProvider, ListEnd } from '../src/l1/client/aiProvider.js';
import { getDetail, getExportRecord, getIndex, putExportRecord, putIndexes } from '../src/l3a/storageService.js';

useIndexStorage();

const account = fixtureAccount('custom');
const otherAccountId = '10000000-0000-4000-8000-000000000002';
const sourceTime = 1_700_000_000_000;

function key(conversationId: string) {
    return { accountId: account.id, conversationId };
}
function request(conversationId: string, changes: Partial<ExportRequest> = {}): ExportRequest {
    return {
        keys: [key(conversationId)],
        format: 'markdown',
        delivery: 'browserDownload',
        includeAssets: false,
        skipUnchanged: false,
        ...changes,
    };
}
function snapshot(id: string, content: string, updatedAt = sourceTime) {
    return historicalFixture({
        id, title: id, updatedAt, messages: [{ role: 'user', content }],
    }, { providerId: 'custom', qualityStatusOverride: 'complete' });
}

/** v2 L1 seam: a provider admits a refreshed Detail itself; Export only sees its Promise. */
function registerCustomProvider(overrides: Partial<Pick<AIProvider, 'fetchConversationDetail' | 'acquireResource'>> = {}): () => void {
    const previous = ProviderRegistry.get('custom');
    const provider: AIProvider = {
        id: 'custom',
        name: 'PR865 v2 fixture provider',
        hostPatterns: [],
        matchesUrl: () => false,
        checkReadiness: async () => ({ ready: true }),
        listConversations: async () => 'source_end',
        fetchConversationDetail: async () => { throw new Error('HTTP 503'); },
        acquireResource: async () => { throw new Error('Resource unavailable'); },
        ...overrides,
    };
    ProviderRegistry.register(provider);
    return () => {
        ProviderRegistry.unregister('custom');
        if (previous) ProviderRegistry.register(previous);
    };
}

/** Exercise the actual v2 L4 Browser Download anchor, not the removed JSZip/BatchWorker seam. */
function captureBrowserDownloads(click?: () => void) {
    const blobs: Blob[] = [];
    const clicked: string[] = [];
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const oldMouseEvent = Object.getOwnPropertyDescriptor(globalThis, 'MouseEvent');
    Object.defineProperty(globalThis, 'MouseEvent', { configurable: true, value: Event });
    const oldCreate = URL.createObjectURL;
    const oldRevoke = URL.revokeObjectURL;
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            body: { appendChild: () => {} },
            createElement(tag: string) {
                assert.equal(tag, 'a');
                return {
                    href: '',
                    download: '',
                    dispatchEvent() {
                        click?.();
                        clicked.push(this.download);
                        return true;
                    },
                    remove() {},
                };
            },
        },
    });
    URL.createObjectURL = ((blob: Blob) => {
        blobs.push(blob);
        return 'blob:pr865-' + blobs.length;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    return {
        blobs,
        clicked,
        restore() {
            URL.createObjectURL = oldCreate;
            URL.revokeObjectURL = oldRevoke;
            if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
            else Reflect.deleteProperty(globalThis, 'document');
            if (oldMouseEvent) Object.defineProperty(globalThis, 'MouseEvent', oldMouseEvent);
            else Reflect.deleteProperty(globalThis, 'MouseEvent');
        },
    };
}

test('v2 uses a fresh local Detail without cloud fetch, and refreshes stale Detail through L1 admission', async () => {
    const id = 'freshness';
    await admitFixture(account.id, snapshot(id, 'Saved local answer'));
    let fetches = 0;
    const restoreProvider = registerCustomProvider({
        fetchConversationDetail: async (accountId, conversationId) => {
            assert.equal(accountId, account.id);
            assert.equal(conversationId, id);
            fetches++;
            await admitFixture(accountId, snapshot(id, 'Fresh cloud answer', sourceTime + 5_000));
        },
    });
    const download = captureBrowserDownloads();
    try {
        assert.equal((await runExport(request(id))).exported, 1);
        assert.equal(fetches, 0, 'a complete, current Detail does not need a remote fetch');
        assert.match(await download.blobs[0].text(), /Saved local answer/);

        await putIndexes([makeConversationIndex({
            key: { accountId: account.id, conversationId: id }, title: id, updatedAt: sourceTime + 5_000,
        })]);
        assert.equal((await runExport(request(id))).exported, 1);
        assert.equal(fetches, 1);
        assert.match(await download.blobs[1].text(), /Fresh cloud answer/);
        assert.doesNotMatch(await download.blobs[1].text(), /Saved local answer/);
        assert.equal((await getExportRecord(key(id)))?.chatTime, sourceTime + 5_000);
        assert.equal((await runExport(request(id, { skipUnchanged: true }))).skipped, 1);
        assert.equal(fetches, 1);
    } finally {
        download.restore();
        restoreProvider();
    }
});

test('a transient refresh failure exports a stale snapshot as partial, retries Skip and becomes ok after fresh admission', async () => {
    const id = 'retry_snapshot';
    await admitFixture(account.id, snapshot(id, 'Saved snapshot'));
    await putIndexes([makeConversationIndex({
        key: { accountId: account.id, conversationId: id }, title: id, updatedAt: sourceTime + 5_000,
    })]);
    let fetches = 0;
    let available = false;
    const restoreProvider = registerCustomProvider({
        fetchConversationDetail: async (accountId) => {
            fetches++;
            if (!available) throw new Error('HTTP 503');
            await admitFixture(accountId, snapshot(id, 'Updated body', sourceTime + 5_000));
        },
    });
    const download = captureBrowserDownloads();
    try {
        const first = await runExport(request(id));
        assert.deepEqual({ exported: first.exported, partial: first.partial, failed: first.failed.length },
            { exported: 1, partial: 1, failed: 0 });
        assert.match(await download.blobs[0].text(), /Saved snapshot/);
        assert.deepEqual(
            { status: (await getExportRecord(key(id)))?.status, chatTime: (await getExportRecord(key(id)))?.chatTime },
            { status: 'partial', chatTime: sourceTime },
        );

        const retry = await runExport(request(id, { skipUnchanged: true }));
        assert.equal(retry.skipped, 0);
        assert.equal(fetches, 2, 'partial snapshots are not eligible for Skip');
        available = true;
        const refreshed = await runExport(request(id, { skipUnchanged: true }));
        assert.equal(refreshed.partial, 0);
        assert.equal((await getExportRecord(key(id)))?.status, 'ok');
        assert.equal((await getExportRecord(key(id)))?.chatTime, sourceTime + 5_000);
        assert.match(await download.blobs[2].text(), /Updated body/);
        assert.equal((await runExport(request(id, { skipUnchanged: true }))).skipped, 1);
        assert.equal(fetches, 3);
    } finally {
        download.restore();
        restoreProvider();
    }
});

test('unavailable resources mark delivered content partial; explicitly excluding assets is not a failure', async t => {
    const previousZip = __getZipConstructor();
    __setZipConstructor(require('../lib/jszip.min.js'));
    t.after(()=>__setZipConstructor(previousZip));
    const id = 'missing_resource';
    const source = historicalFixture({
        id, title: id, updatedAt: sourceTime,
        messages: [{ role: 'model', content: 'Saved answer',
            images: [{ url: 'https://example.com/missing.png', fileName: 'missing.png' }] }],
    }, { providerId: 'custom', qualityStatusOverride: 'complete' });
    assert.ok(collectDocumentResources(composeDomainDocument(source.conversation, source.account)).referencedIds.size,
        'fixture must reference an actual v2 Document AST resource');
    await admitFixture(account.id, source);
    let detailFetches = 0;
    let assetFetches = 0;
    const restoreProvider = registerCustomProvider({
        fetchConversationDetail: async () => { detailFetches++; throw new Error('unnecessary Detail fetch'); },
        acquireResource: async () => { assetFetches++; throw new Error('unavailable resource bytes'); },
    });
    const download = captureBrowserDownloads();
    try {
        const incomplete = await runExport(request(id, { includeAssets: true }));
        assert.equal(incomplete.exported, 1);
        assert.equal(incomplete.partial, 1);
        assert.equal(incomplete.failed.length, 0);
        assert.ok(assetFetches > 0);
        assert.equal(detailFetches, 0);
        assert.equal((await getExportRecord(key(id)))?.status, 'partial');
        const zip = await require('../lib/jszip.min.js').loadAsync(await download.blobs[0].arrayBuffer());
        const name = Object.keys(zip.files).find(name => name.endsWith('.md'));
        assert.ok(name);
        assert.match(await zip.file(name).async('string'), /Saved answer/);
        const attempts = assetFetches;

        const withoutAssets = await runExport(request(id, { includeAssets: false, skipUnchanged: true }));
        assert.equal(withoutAssets.skipped, 0, 'a previous partial delivery must be retried');
        assert.equal(withoutAssets.exported, 1);
        assert.equal(withoutAssets.partial, 0, 'an explicit no-assets choice is not partial');
        assert.equal(assetFetches, attempts, 'no resources are acquired when includeAssets=false');
        assert.equal((await getExportRecord(key(id)))?.status, 'ok');
        assert.equal((await runExport(request(id, { includeAssets: true, skipUnchanged: true }))).skipped, 1,
            'v2 Skip considers last format/version/status, not includeAssets');
    } finally {
        download.restore();
        restoreProvider();
    }
});

test('confirmed conversation_not_found deletes the local Key/record and forbids old-Detail fallback', async () => {
    const id = 'confirmed_deleted';
    await admitFixture(account.id, snapshot(id, 'Must not export deleted answer'));
    await putIndexes([makeConversationIndex({
        key: { accountId: account.id, conversationId: id }, title: id, updatedAt: sourceTime + 1_000,
    })]);
    await putExportRecord(key(id), { exportedAt: sourceTime + 2_000, format: 'markdown',
        status: 'partial', chatTime: sourceTime });
    const restoreProvider = registerCustomProvider({
        fetchConversationDetail: async (accountId, conversationId) => {
            await ingestDeletedConversation(accountId, conversationId);
            throw new Error('conversation_not_found');
        },
    });
    const download = captureBrowserDownloads();
    try {
        const result = await runExport(request(id));
        assert.equal(result.exported, 0);
        assert.deepEqual(result.failed, [key(id)]);
        assert.equal(download.clicked.length, 0);
        assert.equal(await getIndex(key(id)), null);
        assert.equal(await getDetail(key(id)), null);
        assert.equal(await getExportRecord(key(id)), null);
    } finally {
        download.restore();
        restoreProvider();
    }
});

test('a failed fetch does not use another account\'s Detail or create a record', async () => {
    const id = 'missing_local';
    const foreign = historicalFixture({
        id, title: 'Other account', updatedAt: sourceTime,
        messages: [{ role: 'user', content: 'Private other-account answer' }],
    }, { qualityStatusOverride: 'complete' });
    await admitFixture(otherAccountId, bindFixture(foreign, otherAccountId));
    await putIndexes([makeConversationIndex({ key: { accountId: account.id, conversationId: id }, title: 'Not available', updatedAt: sourceTime })]);
    const restoreProvider = registerCustomProvider();
    const download = captureBrowserDownloads();
    try {
        const result = await runExport(request(id));
        assert.equal(result.exported, 0);
        assert.deepEqual(result.failed, [key(id)]);
        assert.equal(await getExportRecord(key(id)), null);
        assert.equal(download.clicked.length, 0);
        assert.ok(await getDetail({ accountId: otherAccountId, conversationId: id }),
            'foreign Account data must remain isolated and intact');
    } finally {
        download.restore();
        restoreProvider();
    }
});

test('ExportRecord.chatTime uses the delivered Detail version, never a newer Index timestamp', async () => {
    const id = 'older_body_version';
    await admitFixture(account.id, snapshot(id, 'Captured older body'));
    await putIndexes([makeConversationIndex({
        key: { accountId: account.id, conversationId: id }, title: id, updatedAt: sourceTime + 5_000,
    })]);
    let attempts = 0;
    const restoreProvider = registerCustomProvider({
        fetchConversationDetail: async () => { attempts++; throw new Error('HTTP 503'); },
    });
    const download = captureBrowserDownloads();
    try {
        assert.equal((await runExport(request(id))).partial, 1);
        const record = await getExportRecord(key(id));
        assert.equal(record?.chatTime, sourceTime);
        assert.equal(record?.status, 'partial');
        assert.equal((await getIndex(key(id)))?.updatedAt, sourceTime + 5_000);
        const next = await runExport(request(id, { skipUnchanged: true }));
        assert.equal(next.skipped, 0);
        assert.equal(attempts, 2);
    } finally {
        download.restore();
        restoreProvider();
    }
});

test('v2 Skip requires an ok record for the same format and a comparable body version', () => {
    const wanted = request('skip_rule', { skipUnchanged: true });
    const record = { exportedAt: sourceTime + 10, format: 'markdown' as const,
        status: 'ok' as const, chatTime: sourceTime };
    assert.equal(shouldSkipExport(record, sourceTime, wanted), true);
    assert.equal(shouldSkipExport({ ...record, sourceTurn: 'unfinished' }, sourceTime, wanted), false);
    assert.equal(shouldSkipExport({ ...record, sourceTurn: 'unknown' }, sourceTime, wanted), false);
    assert.equal(shouldSkipExport({ ...record, sourceTurn: 'handoff' }, sourceTime, wanted), false);
    assert.equal(shouldSkipExport({ ...record, sourceTurn: 'finished' }, sourceTime, wanted), true);
    assert.equal(shouldSkipExport(record, sourceTime + 1, wanted), false);
    assert.equal(shouldSkipExport({ ...record, status: 'partial' }, sourceTime, wanted), false);
    assert.equal(shouldSkipExport({ ...record, format: 'json' }, sourceTime, wanted), false);
    assert.equal(shouldSkipExport({ ...record, chatTime: undefined }, sourceTime, wanted), false);
    assert.equal(shouldSkipExport(record, undefined, wanted), false);
    assert.equal(shouldSkipExport(record, sourceTime, request('skip_rule')), false);
});

test('records are written only after final Browser Download starts, not after rendering/staging', async () => {
    const id = 'delivery_gate';
    await admitFixture(account.id, snapshot(id, 'Delivery gate'));
    let failClick = true;
    const restoreProvider = registerCustomProvider({
        fetchConversationDetail: async () => { throw new Error('unexpected refresh'); },
    });
    const download = captureBrowserDownloads(() => {
        if (failClick) throw new Error('Unable to start download');
    });
    try {
        const notDelivered = await runExport(request(id));
        assert.equal(notDelivered.exported, 0);
        assert.deepEqual(notDelivered.failed, [key(id)]);
        assert.equal(await getExportRecord(key(id)), null);
        failClick = false;
        const delivered = await runExport(request(id));
        assert.equal(delivered.exported, 1);
        assert.equal(delivered.failed.length, 0);
        assert.equal(download.clicked.length, 1);
        assert.equal((await getExportRecord(key(id)))?.status, 'ok');
    } finally {
        download.restore();
        restoreProvider();
    }
});

test('v2 Sync reports real incomplete/aborted/error outcomes instead of a 100% success broadcast', async () => {
    const previous = ProviderRegistry.get('gemini');
    assert.ok(previous, 'the Gemini provider must be registered');
    let mode: ListEnd | 'abort' | 'failure' = 'source_end';
    const mock: AIProvider = {
        id: 'gemini',
        name: 'Scan outcome fixture',
        hostPatterns: [],
        matchesUrl: () => false,
        checkReadiness: async () => ({ ready: true }),
        fetchConversationDetail: async () => {},
        acquireResource: async () => ({ bytes: new Uint8Array([1]) }),
        listConversations: async options => {
            await options.onPageCommitted?.({ page: 1, totalObserved: 3 });
            if (mode === 'abort') throw new DOMException('Stopped', 'AbortError');
            if (mode === 'failure') throw new Error('HTTP 503');
            return mode;
        },
    };
    ProviderRegistry.register(mock);
    try {
        const cases: Array<{ end: ListEnd | 'abort' | 'failure'; status: string; reason?: string }> = [
            { end: 'provider_limit', status: 'partial_limit', reason: 'provider_limit' },
            { end: 'max_pages', status: 'partial_limit', reason: 'max_pages' },
            { end: 'stopped', status: 'error', reason: 'Unverified scan stop' },
            { end: 'abort', status: 'aborted' },
            { end: 'failure', status: 'error', reason: 'HTTP 503' },
            { end: 'source_end', status: 'complete' },
        ];
        for (const scenario of cases) {
            mode = scenario.end;
            const progress: number[] = [];
            const result = await scanAll({ accountId: '10000000-0000-4000-8000-000000000001' },
                { onProgress: value => progress.push(value.conversationsFetched) });
            assert.equal(result.status, scenario.status, scenario.end);
            assert.equal(result.reason, scenario.reason, scenario.end);
            assert.deepEqual(progress, [3]);
            assert.equal(result.pagesFetched, 1);
            assert.equal(result.conversationsFetched, 3);
        }
    } finally {
        ProviderRegistry.register(previous);
    }
});
