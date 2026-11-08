import { decodeChatGPTDetail } from '../src/l1/parsers/chatgpt/decodeDetail.js';
import { parseChatGPTConversation } from '../src/l1/parsers/chatgpt/parseConversation.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { ConfirmedSourceEmptyError } from '../src/l1/client/sourceErrors.js';
/**
 * V2 export completion regression: L2 admits Index/Detail once, Application
 * coordinates one runExport path, L4 delivers, and only then L3a records outcome.
 * No retired SessionRecovery, ExportOrchestrator, BatchWorker or catalog callbacks.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureAccount } from './helpers/domainFixture.js';
import { v2ExportHost, exportKey, exportRequest, seedExportConversation,
    seedExportIndexOnly } from './helpers/v2ExportHost.js';
import { runExport } from '../src/application/export/runExport.js';
import { ingestDetail, ingestIndexes } from '../src/l2/ingestion.js';
import { getIndex, getExportRecord, putExportRecord } from '../src/l3a/storageService.js';
import { readConversation } from '../src/l2/readConversation.js';
import { ProviderRegistry } from '../src/l1/client/providerRegistry.js';
import type { AIProvider } from '../src/l1/client/aiProvider.js';
import type { ExportDiagnostic, ExportRecord, ExportItemUpdate } from '../src/application/export/types.js';
import { __getZipConstructor, __setZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';

const account = fixtureAccount('gemini');
const old: ExportRecord = { exportedAt: 90, format: 'markdown', status: 'ok', chatTime: 90 };
const body = (text: string) => ({
    savedAt: 100,
    quality: { status: 'complete' as const },
    assets: [],
    messages: [{ role: 'assistant' as const, content: [
        { type: 'paragraph' as const, children: [{ type: 'text' as const, text }] },
    ] }],
});
function replaceProvider(t: TestContext, fetchConversationDetail: AIProvider['fetchConversationDetail']) {
    const previous = ProviderRegistry.get('gemini');
    const provider: AIProvider = {
        id: 'gemini', name: 'Completion provider test', hostPatterns: [],
        matchesUrl: () => false, checkReadiness: async () => ({ ready: true }),
        listConversations: async () => 'source_end',
        fetchConversationDetail,
        acquireResource: async () => { throw new Error('No assets in this test'); },
    };
    ProviderRegistry.register(provider);
    t.after(() => {
        ProviderRegistry.unregister('gemini');
        if (previous) ProviderRegistry.register(previous);
    });
}

test('a completed delivery creates one minimal v2 ExportRecord without modifying Index metadata', async t => {
    const observed: string[] = [];
    const host = v2ExportHost(t, () => observed.push('delivered'));
    await seedExportConversation('completion-success', 100);
    const key = exportKey('completion-success');
    const before = await getIndex(key);
    assert.ok(before);
    assert.equal(await getExportRecord(key), null);

    const result = await runExport(exportRequest([key.conversationId]));
    assert.deepEqual({ exported: result.exported, partial: result.partial, failed: result.failed },
        { exported: 1, partial: 0, failed: [] });
    assert.deepEqual(observed, ['delivered']);
    assert.equal(host.blobs.length, 1);
    assert.match(await host.blobs[0].text(), /Answer for completion-success/);
    const record = await getExportRecord(key);
    assert.ok(record);
    assert.deepEqual(Object.keys(record).sort(), ['chatTime', 'exportedAt', 'format', 'status']);
    assert.equal(record.format, 'markdown');
    assert.equal(record.status, 'ok');
    assert.equal(record.chatTime, 100, 'source version belongs to Detail, not the delivery clock');
    assert.ok(Number.isSafeInteger(record.exportedAt));
    assert.deepEqual(await getIndex(key), before, 'Export cannot promote its file title into L2 Index');
});

test('Index title authority is independent of ExportRecord and exported text', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('completion-title');
    const key = exportKey('completion-title');
    await ingestIndexes(account.id, [{ conversationId: key.conversationId,
        fields: { title: 'Authoritative imported name', titleSource: 'user', updatedAt: 100 } }]);
    // A later low-priority source cannot displace the user title.
    await ingestDetail(account.id, key.conversationId, body('Original answer'),
        { title: 'Derived candidate', titleSource: 'derived', updatedAt: 100 });

    const result = await runExport(exportRequest([key.conversationId]));
    assert.equal(result.exported, 1);
    assert.equal((await getIndex(key))?.title, 'Authoritative imported name');
    assert.equal((await getIndex(key))?.titleSource, 'user');
    const text = await host.blobs[0].text();
    assert.match(text, /Authoritative imported name/);
    assert.doesNotMatch(text, /Derived candidate/);
    const record = await getExportRecord(key);
    assert.ok(record);
    assert.equal('title' in record, false, 'v2 records do not duplicate Index title facts');
    assert.equal('messageCount' in record, false, 'message count belongs to Detail, not ExportRecord');
});

test('a missing Detail is never exported or recorded as successful completion', async t => {
    const host = v2ExportHost(t);
    await seedExportIndexOnly('completion-index-only');
    const key = exportKey('completion-index-only');
    replaceProvider(t, async () => { /* Source returned without committing Detail. */ });

    const result = await runExport(exportRequest([key.conversationId]));
    assert.equal(result.exported, 0);
    assert.deepEqual(result.failed, [key]);
    assert.equal(host.blobs.length, 0);
    assert.equal(await readConversation(key), null);
    assert.equal(await getExportRecord(key), null);
    assert.equal((await getIndex(key))?.title, 'Unavailable completion-index-only');
});

test('a Delivery failure must not replace the prior record; successful retry commits afterwards', async t => {
    let fail = true;
    const host = v2ExportHost(t, () => { if (fail) throw new Error('Browser download failed'); });
    await seedExportConversation('completion-retry');
    const key = exportKey('completion-retry');
    await putExportRecord(key, old);

    const diagnostics: ExportDiagnostic[] = [];
    const failed = await runExport(exportRequest([key.conversationId]), { onDiagnostic: event => diagnostics.push(event) });
    assert.ok(diagnostics.some(event => event.key?.conversationId === key.conversationId
        && event.code === 'EXPORT_FAILED' && event.message === 'Browser download failed'));
    assert.equal(failed.exported, 0);
    assert.deepEqual(failed.failed, [key]);
    assert.deepEqual(await getExportRecord(key), old);
    fail = false;

    const success = await runExport(exportRequest([key.conversationId]));
    assert.equal(success.exported, 1);
    assert.deepEqual(success.failed, []);
    const next = await getExportRecord(key);
    assert.ok(next);
    assert.equal(next.status, 'ok');
    assert.equal(next.chatTime, 100);
    assert.ok(next.exportedAt >= old.exportedAt);
    assert.ok(host.clicks() >= 2);
});

test('ExportRecord write failure is reported only after delivery and leaves the previous value', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('completion-write-failure');
    const key = exportKey('completion-write-failure');
    await putExportRecord(key, old);
    host.failStorage('exportRecords');

    const failed = await runExport(exportRequest([key.conversationId]));
    assert.equal(failed.exported, 0);
    assert.deepEqual(failed.failed, [key]);
    assert.equal(host.blobs.length, 1, 'the file is already delivered before record persistence');
    assert.deepEqual(await getExportRecord(key), old);

    host.failStorage();
    const recovered = await runExport(exportRequest([key.conversationId]));
    assert.equal(recovered.exported, 1);
    assert.equal((await getExportRecord(key))?.chatTime, 100);
});

test('Export completion never creates a catalog row from a standalone ExportRecord', async t => {
    v2ExportHost(t);
    const key = exportKey('uncatalogued-record');
    await putExportRecord(key, old);
    assert.equal(await getIndex(key), null, 'export history is not evidence of an L2 conversation');
    assert.equal(await readConversation(key), null);
    assert.deepEqual(await getExportRecord(key), old);
});

test('batch completion stores records per key and Skip consumes only delivered versions', async t => {
    const host = v2ExportHost(t);
    const previousZip = __getZipConstructor();
    __setZipConstructor(require('../lib/jszip.min.js'));
    t.after(() => __setZipConstructor(previousZip));
    await seedExportConversation('completion-batch-1');
    await seedExportConversation('completion-batch-2');
    const ids = ['completion-batch-1', 'completion-batch-2'];
    const first = await runExport(exportRequest(ids));
    assert.equal(first.exported, 2);
    assert.deepEqual(first.failed, []);
    assert.equal(host.blobs.length, 1, 'the batch has one final browser artifact');
    for (const id of ids) {
        const record = await getExportRecord(exportKey(id));
        assert.equal(record?.status, 'ok');
        assert.equal(record?.chatTime, 100);
    }

    const skipped = await runExport(exportRequest(ids, { skipUnchanged: true }));
    assert.equal(skipped.skipped, 2);
    assert.equal(skipped.exported, 0);
    assert.equal(host.blobs.length, 1, 'skipped exports cannot trigger another delivery');
});


test('partial fallback diagnostics explain freshness and source failure without changing delivery', async t => {
    const host = v2ExportHost(t);
    await seedExportIndexOnly('diagnostic-partial');
    const key = exportKey('diagnostic-partial');
    await ingestDetail(account.id, key.conversationId, {
        ...body('Cached answer'), quality: { status: 'partial' },
    }, { updatedAt: 200 });
    const diagnostics: ExportDiagnostic[] = [];
    const result = await runExport(exportRequest([key.conversationId]), {
        onDiagnostic: event => diagnostics.push(event),
    });
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 1);
    assert.equal(host.blobs.length, 1);
    assert.ok(diagnostics.some(event => event.key?.conversationId === key.conversationId
        && event.code === 'SOURCE_REFRESH_FAILED' && event.message.length > 0));
    assert.deepEqual(diagnostics.find(event => event.code === 'DETAIL_NOT_COMPLETE')?.details,
        { quality: 'partial', messageCount: 1, savedAt: 100, indexUpdatedAt: 200,
            lastMessageId: null, lastMessageRole: 'assistant' });
    assert.deepEqual(diagnostics.find(event => event.code === 'DETAIL_STALE')?.details,
        { savedAt: 100, updatedAt: 200, lagMs: 100 });
    assert.deepEqual(diagnostics.find(event => event.code === 'DETAIL_REFRESH_RESULT')?.details, {
        refreshFailed: true, requestedExplicitly: false, needsSourceReaders: false,
        before: { savedAt: 100, indexUpdatedAt: 200, quality: 'partial', messageCount: 1 },
        after: { savedAt: 100, indexUpdatedAt: 200, quality: 'partial', messageCount: 1 },
    });
    assert.equal((await getExportRecord(key))?.otherContentMissing, true);
    const retry = await runExport(exportRequest([key.conversationId]), {
        onDiagnostic: () => { throw new Error('Diagnostic observer failed'); },
    });
    assert.equal(retry.exported, 1, 'diagnostic observer cannot break delivery');
    assert.equal(retry.partial, 1);
});

test('confirmed source-empty conversations are skipped without delivery, replacing local bodies or success records', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('confirmed-empty', 100);
    const key = exportKey('confirmed-empty');
    const before = await readConversation(key);
    const originalFetch = GeminiProvider.prototype.fetchConversationDetail;
    GeminiProvider.prototype.fetchConversationDetail = async () => { throw new ConfirmedSourceEmptyError(); };
    t.after(() => { GeminiProvider.prototype.fetchConversationDetail = originalFetch; });
    const diagnostics: ExportDiagnostic[] = [];
    const result = await runExport(exportRequest([key.conversationId]), { refreshDetail: true,
        onDiagnostic: event => diagnostics.push(event) });
    assert.equal(result.skipped, 1);
    assert.equal(result.partial, 0);
    assert.deepEqual(result.failed, []);
    assert.equal(host.blobs.length, 0);
    assert.equal(await getExportRecord(key), null);
    assert.deepEqual(await readConversation(key), before);
    assert.ok(diagnostics.some(d => d.code === 'SOURCE_CONVERSATION_EMPTY'));
    assert.ok(!diagnostics.some(d => d.code === 'SOURCE_REFRESH_FAILED'));
});

test('unchanged exports with only attachment 404s skip before refreshing or acquiring resources', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('expired-only', 100);
    const key = exportKey('expired-only');
    const record: ExportRecord = { exportedAt: 200, chatTime: 100, format: 'markdown', status: 'partial',
        attachmentIssues: [{ resourceId: 'expired', name: 'Expired image', code: 'RESOURCE_SOURCE_EXPIRED', httpStatus: 404 }] };
    await putExportRecord(key, record);
    const originalFetch = GeminiProvider.prototype.fetchConversationDetail;
    GeminiProvider.prototype.fetchConversationDetail = async () => { assert.fail('404-only unchanged exports must not refresh'); };
    t.after(() => { GeminiProvider.prototype.fetchConversationDetail = originalFetch; });
    const result = await runExport({ ...exportRequest([key.conversationId]), skipUnchanged: true });
    assert.equal(result.skipped, 1);
    assert.equal(result.exported, 0);
    assert.equal(host.blobs.length, 0);
    assert.deepEqual(await getExportRecord(key), record);
});


test('batch delivery failure carries the same diagnostic to every affected item', async t => {
    v2ExportHost(t, () => { throw new Error('Browser download failed'); });
    const previousZip = __getZipConstructor();
    __setZipConstructor(require('../lib/jszip.min.js'));
    t.after(() => __setZipConstructor(previousZip));
    const ids = ['batch-failed-one', 'batch-failed-two'];
    for (const id of ids) await seedExportConversation(id);
    const updates: ExportItemUpdate[] = [];
    const result = await runExport(exportRequest(ids), { onItemUpdate: update => updates.push(update) });
    assert.deepEqual(result.failed, ids.map(exportKey));
    const failures = updates.filter(update => update.status === 'failed');
    assert.equal(failures.length, 2);
    for (const update of failures) {
        assert.equal(update.diagnostic.issue?.code, 'FILE_WRITE_FAILED');
        assert.equal(update.diagnostic.message, 'Browser download failed');
        assert.equal(await getExportRecord(update.key), null);
    }
});

for (const sourceTurn of ['unfinished', 'interrupted', 'handoff', 'awaiting_reply', 'tool_pending', 'unknown'] as const) {
    test(`${sourceTurn} source reply delivers all available text without marking missing body`, async t => {
        const host = v2ExportHost(t);
        const id = 'source-turn-' + sourceTurn;
        await seedExportConversation(id);
        const key = exportKey(id);
        const snapshot = { ...body('Earlier complete reply\n\n本批完成：Migration / Released 1.7\n\n已'),
            quality: { status: 'complete' as const, sourceTurn } };
        await ingestDetail(account.id, id, snapshot, { updatedAt: 200 });
        let refreshes = 0;
        t.mock.method(GeminiProvider.prototype, 'fetchConversationDetail', async () => {
            refreshes++; await ingestDetail(account.id, id, snapshot, { updatedAt: 200 });
        });
        const diagnostics: ExportDiagnostic[] = [];
        const result = await runExport(exportRequest([id]), { onDiagnostic: event => diagnostics.push(event) });
        assert.equal(result.exported, 1);
        assert.equal(result.partial, 0);
        assert.deepEqual(result.failed, []);
        assert.equal(host.blobs.length, 1);
        const markdown = await host.blobs[0].text();
        assert.match(markdown, /Earlier complete reply/);
        assert.match(markdown, /本批完成：Migration \/ Released 1.7/);
        assert.match(markdown, /已/);
        const record = await getExportRecord(key);
        assert.equal(record?.status, 'ok');
        assert.equal(record?.sourceTurn, sourceTurn);
        assert.equal(record?.otherContentMissing, undefined);
        assert.ok(diagnostics.some(d => d.code === 'SOURCE_TURN_' + sourceTurn.toUpperCase() && d.severity === 'info'));
        assert.ok(!diagnostics.some(d => d.code === 'DETAIL_NOT_COMPLETE'));
        // Timestamp disagreement is retained as freshness evidence, never fabricated body loss.
        assert.ok(diagnostics.some(d => d.code === 'DETAIL_STALE'));
        assert.equal(refreshes, 1);
        await runExport(exportRequest([id], { skipUnchanged: true }));
        assert.equal(refreshes, 2, 'unfinished/uncertain or stale source snapshots are refreshed on the next export');
    });
}

test('Work handoff card is physically delivered as readable Markdown with a successful export record', async t => {
    const host = v2ExportHost(t);
    const id = 'visible-work-handoff';
    await seedExportConversation(id);
    const raw = { id, title: 'Handoff', current_node: 'handoff', update_time: 0.1, mapping: {
        root: { id: 'root', children: ['question'] },
        question: { id: 'question', parent: 'root', children: ['handoff'], message: {
            id: 'message-question', author: { role: 'user' }, recipient: 'all',
            content: { content_type: 'text', parts: ['Review the repository'] } } },
        handoff: { id: 'handoff', parent: 'question', children: [], message: {
            id: 'message-handoff', author: { role: 'assistant' }, recipient: 'local.handoff',
            status: 'finished_successfully', end_turn: false,
            content: { content_type: 'code', language: 'json', text: JSON.stringify({
                reason: 'Work can inspect the repository and prepare the requested changes.',
                prompt: 'INTERNAL-WORK-PROMPT' }) } } },
    } };
    const snapshot = parseChatGPTConversation({ conversation: decodeChatGPTDetail(raw, id), assetsByNode: new Map() }).conversation.detail;
    await ingestDetail(account.id, id, snapshot, { updatedAt: 100 });
    t.mock.method(GeminiProvider.prototype, 'fetchConversationDetail', async () => {
        await ingestDetail(account.id, id, snapshot, { updatedAt: 100 });
    });
    const result = await runExport(exportRequest([id]));
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
    assert.deepEqual(result.failed, []);
    const markdown = await host.blobs[0].text();
    assert.match(markdown, /Review the repository/);
    assert.match(markdown, /Continue in ChatGPT Work/);
    assert.match(markdown, /Work can inspect the repository/);
    assert.doesNotMatch(markdown, /INTERNAL-WORK-PROMPT|"reason"/);
    const record = await getExportRecord(exportKey(id));
    assert.equal(record?.status, 'ok');
    assert.equal(record?.sourceTurn, 'handoff');
    assert.equal(record?.otherContentMissing, undefined);
});

for (const sourceTurn of ['finished', 'awaiting_reply', 'tool_pending', 'unknown'] as const) {
    test(`${sourceTurn} never turns actual incomplete body coverage into a successful full export`, async t => {
        const host = v2ExportHost(t);
        const id = 'incomplete-source-' + sourceTurn;
        await seedExportIndexOnly(id);
        const snapshot = { ...body('Available part only'), quality: { status: 'partial' as const, sourceTurn } };
        await ingestDetail(account.id, id, snapshot, { updatedAt: 200 });
        t.mock.method(GeminiProvider.prototype, 'fetchConversationDetail', async () => {
            await ingestDetail(account.id, id, snapshot, { updatedAt: 200 });
        });
        const diagnostics: ExportDiagnostic[] = [];
        const result = await runExport(exportRequest([id]), { onDiagnostic: event => diagnostics.push(event) });
        assert.equal(result.exported, 1);
        assert.equal(result.partial, 1);
        assert.deepEqual(result.failed, []);
        assert.match(await host.blobs[0].text(), /Available part only/);
        const record = await getExportRecord(exportKey(id));
        assert.equal(record?.status, 'partial');
        assert.equal(record?.otherContentMissing, true);
        assert.ok(diagnostics.some(d => d.code === 'DETAIL_NOT_COMPLETE' && d.severity === 'warning'));
    });
}
