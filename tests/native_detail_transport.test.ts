/**
 * V2 native Detail transport integration:
 * Provider RPC -> L1 source parser -> Content domainIngest IPC -> L2 -> L3a.
 * The fake Chrome messaging boundary dispatches to real L2 and fake IndexedDB.
 * Background sender authorization is tested in browser_runtime_v2.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID, OTHER_ACCOUNT_UUID } from './helpers/accountIds.js';
import { sourceDetail, sourceMessage } from './helpers/l1SourceFixture.js';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { ingestDetail as ingestThroughContentRuntime } from '../src/runtime/api/domainIngestion.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { getDetail, getIndex } from '../src/l3a/storageService.js';
import type { SourceConversationParseResult } from '../src/l1/parsers/parsingResult.js';

useIndexStorage();

const CONVERSATION_ID = 'native_bridge';

function parseNativeReply(): SourceConversationParseResult {
    return parseGeminiRpcConversation(geminiDetailGen('G_DETAIL_NATIVE_TRANSPORT_01'), { providerId: 'gemini', targetConvId: CONVERSATION_ID });
}

// A source payload is not a normalized v2 Detail merely because it arrived over IPC.
function opaqueWireIsNotDomain(value: unknown): void {
    // @ts-expect-error Unvalidated native payloads cannot bypass L1 normalization.
    const detail: Parameters<typeof ingestDetail>[2] = value;
    void detail;
}
void opaqueWireIsNotDomain;

test('v2 native RPC parsing produces keyless facts, not a versioned Domain envelope', async () => {
    const candidate = parseNativeReply();
    assert.equal(candidate.conversationId, CONVERSATION_ID);
    assert.equal(candidate.conversation.index.title, 'Native title');
    assert.deepEqual(candidate.conversation.detail.messages.map(message => message.role), ['user', 'assistant']);
    assert.equal('key' in candidate.conversation.index, false);
    assert.equal('key' in candidate.conversation.detail, false);
    assert.equal('account' in candidate, false);
    assert.equal('transport' in candidate.conversation, false);
    assert.equal('domainEnvelopeVersion' in candidate, false);
    assert.equal(await getIndex({ accountId: ACCOUNT_UUID, conversationId: CONVERSATION_ID }), null,
        'pure L1 parsing must not persist a conversation');
});

test('malformed native payloads and wrong Provider context cannot be admitted as Detail', async () => {
    for (const key of ['G_DETAIL_NATIVE_TRANSPORT_EMPTY_01', 'G_DETAIL_NATIVE_TRANSPORT_NON_JSON_01', 'G_DETAIL_NATIVE_TRANSPORT_NULL_01'] as const) {
        assert.throws(() => parseGeminiRpcConversation(geminiDetailGen(key), { providerId: 'gemini' }));
    }
    for (const raw of [null, 42, {}]) {
        assert.throws(() => parseGeminiRpcConversation(raw as never, { providerId: 'gemini' }),
            /raw response text/);
    }
    assert.throws(() => parseGeminiRpcConversation(geminiDetailGen('G_DETAIL_NATIVE_TRANSPORT_EMPTY_BATCH_01'), { providerId: 'chatgpt' }),
        /requires providerId gemini/);
    assert.equal(await getDetail({ accountId: ACCOUNT_UUID, conversationId: CONVERSATION_ID }), null);
});

test('v2 Content ingestion rejects failed or malformed IPC replies without accepting Domain facts', async () => {
    const candidate = parseNativeReply();
    const key = { accountId: ACCOUNT_UUID, conversationId: candidate.conversationId };
    const expectedRequest = {
        action: 'domainIngest',
        operation: 'detail',
        accountId: ACCOUNT_UUID,
        conversationId: candidate.conversationId,
        detail: candidate.conversation.detail,
        indexFields: candidate.conversation.index,
    };
    const original = Object.getOwnPropertyDescriptor(chrome.runtime, 'sendMessage');
    try {
        for (const { reply, error } of [
            { reply: null, error: /Domain ingestion unavailable/ },
            { reply: { ok: false, error: 'worker offline' }, error: /worker offline/ },
            { reply: { ok: true }, error: /Invalid committed Detail ingestion result/ },
            { reply: { ok: true, result: { accepted: false, changed: true } }, error: /Invalid committed Detail ingestion result/ },
            { reply: { success: true, domainEnvelopeVersion: 3, data: candidate }, error: /Domain ingestion unavailable/ },
        ]) {
            // Only the browser IPC response is mocked. No L2 or Storage write occurs.
            Object.defineProperty(chrome.runtime, 'sendMessage', {
                configurable: true,
                value: async (message: unknown) => {
                    assert.deepEqual(message, expectedRequest);
                    return reply;
                },
            });
            await assert.rejects(ingestThroughContentRuntime(ACCOUNT_UUID, candidate.conversationId,
                candidate.conversation.detail, candidate.conversation.index), error);
            assert.equal(await getIndex(key), null);
            assert.equal(await getDetail(key), null);
        }
    } finally {
        if (original) Object.defineProperty(chrome.runtime, 'sendMessage', original);
        else Reflect.deleteProperty(chrome.runtime, 'sendMessage');
    }
});

test('v2 Content ingestion IPC binds native facts to the Account and preserves the message graph', async () => {
    const candidate = parseNativeReply();
    const result = await ingestThroughContentRuntime(ACCOUNT_UUID, candidate.conversationId,
        candidate.conversation.detail, candidate.conversation.index);
    assert.deepEqual(result, { accepted: true, changed: true });
    const identical = await ingestThroughContentRuntime(ACCOUNT_UUID, candidate.conversationId,
        candidate.conversation.detail, candidate.conversation.index);
    assert.deepEqual(identical, { accepted: true, changed: false },
        'replaying an identical native Detail is accepted but must not trigger Live Save');

    const key = { accountId: ACCOUNT_UUID, conversationId: CONVERSATION_ID };
    const index = await getIndex(key);
    const detail = await getDetail(key);
    assert.deepEqual(index?.key, key);
    assert.deepEqual(detail?.key, key);
    assert.deepEqual(detail?.messages.map(message => message.role), ['user', 'assistant']);
    assert.deepEqual(JSON.parse(JSON.stringify(detail?.messages)),
        JSON.parse(JSON.stringify(candidate.conversation.detail.messages)));
    assert.equal('transport' in detail!, false);
    assert.equal(await getDetail({ accountId: OTHER_ACCOUNT_UUID, conversationId: CONVERSATION_ID }), null);
});

test('identical Provider conversation IDs are isolated by the L2 Account identity', async () => {
    const first = parseNativeReply();
    const second = sourceDetail({
        id: 'c_' + CONVERSATION_ID,
        title: 'Other account title',
        messages: [sourceMessage('other-answer', 'Other account body', 'model')],
    });
    assert.equal(second.conversationId, first.conversationId);
    await ingestDetail(ACCOUNT_UUID, first.conversationId,
        first.conversation.detail, first.conversation.index);
    await ingestDetail(OTHER_ACCOUNT_UUID, second.conversationId,
        second.conversation.detail, second.conversation.index);

    const primary = await getDetail({ accountId: ACCOUNT_UUID, conversationId: CONVERSATION_ID });
    const other = await getDetail({ accountId: OTHER_ACCOUNT_UUID, conversationId: CONVERSATION_ID });
    assert.equal(primary?.key.accountId, ACCOUNT_UUID);
    assert.equal(other?.key.accountId, OTHER_ACCOUNT_UUID);
    assert.deepEqual(primary?.messages.map(message => message.role), ['user', 'assistant']);
    assert.deepEqual(other?.messages.map(message => message.role), ['assistant']);
    assert.equal((await getIndex({ accountId: OTHER_ACCOUNT_UUID, conversationId: CONVERSATION_ID }))?.title,
        'Other account title');
});

test('native attachment bytes remain source-only; L2 persists asset identity and references', async () => {
    const rawBytes = new Uint8Array([1, 2, 3]);
    const candidate = sourceDetail({
        id: 'c_native_asset',
        messages: [{
            ...sourceMessage('answer', 'Attached report', 'model'),
            attachmentCount: 1,
            attachments: [{ type: 'file', name: 'report.bin', dataBuffer: rawBytes }],
        }],
    });
    assert.equal(candidate.conversation.detail.assets.length, 1);
    assert.equal(candidate.conversation.detail.messages[0].attachmentIds?.length, 1);
    assert.equal('dataBuffer' in candidate.conversation.detail.assets[0], false);
    const asset = candidate.conversation.detail.assets[0];
    assert.ok(candidate.acquisitionHints[asset.id]?.dataBase64,
        'raw source bytes must remain available in the one-task acquisition context');

    await ingestDetail(ACCOUNT_UUID, candidate.conversationId,
        candidate.conversation.detail, candidate.conversation.index);
    const stored = await getDetail({ accountId: ACCOUNT_UUID, conversationId: candidate.conversationId });
    assert.ok(stored);
    assert.deepEqual(stored.assets.map(asset => asset.id),
        candidate.conversation.detail.assets.map(asset => asset.id));
    assert.deepEqual(stored.messages[0].attachmentIds,
        candidate.conversation.detail.messages[0].attachmentIds);
    assert.equal('dataBuffer' in stored.assets[0], false);
    assert.equal('dataBase64' in stored.assets[0], false);
    assert.equal('acquisitionHints' in stored, false);

    const key = { accountId: ACCOUNT_UUID, conversationId: candidate.conversationId };
    const sourceResources = createSourceResourceContext();
    try {
        sourceResources.retainParsed(key, candidate);
        const acquired = await sourceResources.acquire(key, asset);
        assert.deepEqual(acquired.bytes, rawBytes,
            'resource bytes remain readable for the accepted export task, without entering Domain');
    } finally {
        sourceResources.release();
    }
});
