/**
 * V2 replacement for the retired BatchWorker/fetchChatDetail/resolveChat APIs.
 * Keep real Gemini L1 parsing/Provider, L2 admission, L3a IndexedDB and
 * L3b/L4 presentation. Only Provider network transport and tab slot are faked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { sourceDetail, sourceList, sourceMessage, activityHtml, takeoutArchive } from './helpers/l1SourceFixture.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { ConfirmedGeminiConversationNotFound } from '../src/l1/client/gemini/geminiClient.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { importTakeout } from '../src/l1/imports/takeout/importTakeout.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { readConversation } from '../src/l2/readConversation.js';
import { getDetail, getIndex, getExportRecord, putExportRecord } from '../src/l3a/storageService.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';

useIndexStorage();
const account = fixtureAccount('gemini');
const key = (conversationId: string) => ({ accountId: account.id, conversationId });
function native(id: string, title: string, answer: string, updatedAt = 1800000000000) {
    const result = sourceDetail({ id, title, updatedAt,
        messages: [sourceMessage('r_' + id, answer, 'model')] });
    result.conversation.detail.savedAt = updatedAt;
    result.conversation.detail.quality.status = 'complete';
    return result;
}
function provider(getConversationDetail: (conversationId: string, slot?: string | null) =>
    Promise<ReturnType<typeof native>>, route: (accountId: string) => Promise<string> = async () => 'u0') {
    return new GeminiProvider({
        getConversationList: async () => sourceList('G_SOURCE_EMPTY_01'),
        getConversationDetail,
    }, route);
}

test('C1: native online Detail flows through real L1 -> L2 -> L3a; no BatchWorker envelope is persisted', async () => {
    const id = 'c1-online-1';
    const resourceContext = createSourceResourceContext();
    const parsed = native(id, 'Source RPC title', 'Provider model answer');
    parsed.conversation.detail.assets.push({ id: 'diagram', kind: 'image', name: 'diagram.png', mediaType: 'image/png' });
    parsed.conversation.detail.messages[0].content.push({ type: 'image', assetId: 'diagram' });
    parsed.acquisitionHints = { diagram: { dataBase64: 'AQID' } };
    const requests: Array<{ id: string; slot: string | null | undefined }> = [];
    const actual = new GeminiProvider({
        getConversationList: async () => sourceList('G_SOURCE_EMPTY_01'),
        getConversationDetail: async (conversationId, slot) => {
            requests.push({ id: conversationId, slot });
            return parsed;
        },
    }, async () => 'u0', resourceContext);
    try {
        await actual.fetchConversationDetail(account.id, id);
        assert.deepEqual(requests, [{ id, slot: 'u0' }]);
        const saved = await readConversation(key(id));
        assert.ok(saved);
        assert.equal(saved.index.title, 'Source RPC title');
        assert.equal(saved.index.titleSource, 'provider');
        assert.equal(saved.detail.quality.status, 'complete');
        assert.equal(saved.detail.messages.length, 1);
        assert.match(JSON.stringify(saved.detail.messages), /Provider model answer/);
        assert.ok(!JSON.stringify(saved).includes('AQID'), 'acquisition hints are task-only');
        assert.equal(await getDetail({ ...key(id), accountId: '10000000-0000-4000-8000-000000000002' }), null);
        const bytes = await actual.acquireResource(key(id), saved.detail.assets[0]);
        assert.deepEqual([...bytes.bytes], [1, 2, 3]);
        const document = composeDomainDocument(saved, account);
        assert.match(renderDocumentMarkdown(document, {}), /Provider model answer/);
    } finally { resourceContext.release(); }
});

test('C1: pre-cancelled and in-flight AbortSignal stop v2 acquisition without admitting Detail', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    let called = 0;
    const skipped = provider(async id => { called++; return native(id, 'Not fetched', 'Should not appear'); });
    await assert.rejects(skipped.fetchConversationDetail(account.id, 'c1-preabort', cancelled.signal),
        (error: unknown) => error instanceof Error && error.name === 'AbortError');
    assert.equal(called, 0);
    assert.equal(await getDetail(key('c1-preabort')), null);

    let release!: () => void, entered!: () => void;
    const gated = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = provider(async id => {
        entered();
        await gated;
        return native(id, 'Late response', 'Should never commit');
    });
    const controller = new AbortController();
    const operation = pending.fetchConversationDetail(account.id, 'c1-midflight', controller.signal);
    await started;
    controller.abort();
    release();
    await assert.rejects(operation,
        (error: unknown) => error instanceof Error && error.name === 'AbortError');
    assert.equal(await getIndex(key('c1-midflight')), null);
    assert.equal(await getDetail(key('c1-midflight')), null);
});

test('C1: verified account route change and foreign Detail identity fail closed', async () => {
    const id = 'c1-owned', reply = native(id, 'Trusted title', 'Trusted body');
    let calls = 0;
    const changed = provider(async () => reply, async () => ++calls === 1 ? 'u0' : 'u1');
    await assert.rejects(changed.fetchConversationDetail(account.id, id), /route changed/);
    assert.equal(await getDetail(key(id)), null);

    const foreign = provider(async () => native('other-conversation', 'Foreign', 'Foreign body'));
    await assert.rejects(foreign.fetchConversationDetail(account.id, id), /Detail identity mismatch/);
    assert.equal(await getDetail(key('other-conversation')), null);
    assert.equal(await getDetail(key(id)), null);
});

test('C1: malformed native body fails L2 schema validation without replacing a trusted stored snapshot', async () => {
    const id = 'c1-untrusted';
    await ingestDetail(account.id, id, {
        savedAt: 100, quality: { status: 'complete' }, assets: [],
        messages: [{ role: 'assistant', content: [{
            type: 'paragraph', children: [{ type: 'text', text: 'Last trusted answer' }],
        }] }],
    }, { title: 'Saved title', titleSource: 'user', updatedAt: 100 });
    const before = await readConversation(key(id));
    const broken = native(id, 'Malformed reply', 'Untrusted text');
    broken.conversation.detail.messages[0].role = 'model' as never;
    await assert.rejects(provider(async () => broken).fetchConversationDetail(account.id, id), /Domain contract/);
    assert.deepEqual(await readConversation(key(id)), before);
});

test('C1: incomplete Takeout survives transient online failure; a newer complete native response supersedes its body', async () => {
    const id = 'c1-history';
    const imported = await importTakeout(takeoutArchive(activityHtml('<p>Takeout offline answer</p>', id)), account.id);
    assert.equal(imported.imported, 1);
    const offline = await readConversation(key(id));
    assert.ok(offline);
    assert.equal(offline.detail.quality.status, 'partial');
    const unavailable = provider(async () => { throw new Error('transient provider network error'); });
    await assert.rejects(unavailable.fetchConversationDetail(account.id, id), /transient provider network error/);
    assert.deepEqual(await readConversation(key(id)), offline, 'failed L1 fetch cannot erase durable L2 Detail');

    const online = native(id, 'Updated RPC answer', 'Full online answer', 1893456000000);
    await provider(async () => online).fetchConversationDetail(account.id, id);
    const stored = await readConversation(key(id));
    assert.ok(stored);
    assert.equal(stored.detail.quality.status, 'complete');
    assert.match(JSON.stringify(stored.detail.messages), /Full online answer/);
    assert.equal(stored.index.title, 'Updated RPC answer');
    assert.equal(stored.index.titleSource, 'provider');
});

test('C1: unknown semantic blocks remain readable without reconstructing obsolete legacy messages', async () => {
    const id = 'c1-unknown';
    await ingestDetail(account.id, id, {
        savedAt: 101, quality: { status: 'complete' }, assets: [],
        messages: [{ role: 'unknown', content: [{
            type: 'unknown', sourceType: 'provider-tool', text: 'Opaque but readable tool result',
        }] }],
    }, { title: 'Unexpected source role', titleSource: 'derived', updatedAt: 101 });
    const saved = await readConversation(key(id));
    assert.ok(saved);
    assert.equal(saved.detail.messages[0].role, 'unknown');
    assert.deepEqual(saved.detail.messages[0].content, [{
        type: 'unknown', sourceType: 'provider-tool', text: 'Opaque but readable tool result',
    }]);
    const rendered = renderDocumentMarkdown(composeDomainDocument(saved, account), {});
    assert.match(rendered, /Opaque but readable tool result/);
    assert.match(rendered, /provider-tool/);
});

test('C1: only an exactly confirmed provider deletion removes v2 Index, Detail and ExportRecord', async () => {
    const target = 'c1-delete', other = 'c1-preserve';
    for (const id of [target, other]) {
        await ingestDetail(account.id, id, {
            savedAt: 100, quality: { status: 'complete' }, assets: [],
            messages: [{ role: 'assistant', content: [] }],
        }, { title: id, titleSource: 'provider', updatedAt: 100 });
        await putExportRecord(key(id), { exportedAt: 200, format: 'markdown', status: 'ok' });
    }
    const wrongReply = provider(async () => { throw new ConfirmedGeminiConversationNotFound('c_' + other); });
    await assert.rejects(wrongReply.fetchConversationDetail(account.id, target), /Confirmed Gemini Detail not found/);
    assert.ok(await getDetail(key(target)), 'wrong request identity cannot authorize deletion');

    const confirmed = provider(async () => { throw new ConfirmedGeminiConversationNotFound('c_' + target); });
    await assert.rejects(confirmed.fetchConversationDetail(account.id, target), /conversation_not_found/);
    assert.equal(await getIndex(key(target)), null);
    assert.equal(await getDetail(key(target)), null);
    assert.equal(await getExportRecord(key(target)), null);
    assert.ok(await getDetail(key(other)), 'another conversation is preserved');
    assert.equal((await getExportRecord(key(other)))?.status, 'ok');
});
