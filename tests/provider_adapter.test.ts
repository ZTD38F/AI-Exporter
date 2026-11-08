import { geminiRpcPacket, GEMINI_DETAIL_CAPTURE } from './fixtures/providers/geminiRpcCapture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID, OTHER_ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { sourceDetail, sourceList } from './helpers/l1SourceFixture.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import credentials from '../src/l1/client/gemini/api/credentialManager.js';
import { listIndexes as getConversations } from '../src/l3a/storageService.js';
import { getDetail } from '../src/l3a/storageService.js';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
useIndexStorage();

test('adapter: prefixed request IDs use the canonical source ID for admission and task resources', async () => {
    const raw = geminiDetailGen('G_PROVIDER_ADAPTER_01');
    const parsed = parseGeminiRpcConversation(raw, { providerId: 'gemini', targetConvId: 'c_prefixed_detail' });
    assert.equal(parsed.conversationId, 'prefixed_detail');
    assert.equal(parsed.conversation.detail.assets.length, 1);
    const resources = createSourceResourceContext();
    let requestedId = '';
    const provider = new GeminiProvider({
        async getConversationList() { throw new Error('unexpected list request'); },
        async getConversationDetail(id) { requestedId = id; return parsed; },
    }, async () => 'u0', resources);
    try {
        assert.equal(await provider.fetchConversationDetail(ACCOUNT_UUID, 'c_prefixed_detail'), undefined);
        assert.equal(requestedId, 'c_prefixed_detail');
        const key = { accountId: ACCOUNT_UUID, conversationId: 'prefixed_detail' };
        const detail = await getDetail(key); assert.ok(detail);
        assert.deepEqual(detail.key, key);
        assert.deepEqual(detail.messages, parsed.conversation.detail.messages);
        assert.deepEqual((await getConversations(ACCOUNT_UUID)).map(index => index.key.conversationId), ['prefixed_detail']);
        assert.equal(await getDetail({ ...key, conversationId: 'c_prefixed_detail' }), null);
        const asset = detail.assets[0];
        assert.deepEqual((await provider.acquireResource(key, asset)).bytes, Uint8Array.of(1, 2, 3));
        await assert.rejects(resources.acquire({ ...key, conversationId: 'c_prefixed_detail' }, { id: asset.id, kind: asset.kind }), /locator/);
    } finally { resources.release(); }
});

test('adapter submits source Detail and returns completion without a Domain/transport payload', async () => {
    const parsed = parseGeminiRpcConversation(geminiRpcPacket('detail').responseBody, { providerId: 'gemini' });
    parsed.transport.decodedPayload = { source: 'wire' };
    const before = structuredClone(parsed);
    let request: unknown;
    const provider = new GeminiProvider({ getConversationList: async () => sourceList('G_SOURCE_EMPTY_01'),
        getConversationDetail: async (...args) => { request = args; return parsed; } }, async () => 'u1');
    const controller = new AbortController();
    assert.equal(await provider.fetchConversationDetail(ACCOUNT_UUID, parsed.conversationId, controller.signal), undefined);
    assert.equal((request as unknown[])[1], 'u1');
    assert.equal((request as unknown[])[3], controller.signal);
    assert.deepEqual(parsed, before);
    const stored = await getDetail({ accountId: ACCOUNT_UUID, conversationId: parsed.conversationId });
    assert.ok(stored); assert.equal(stored.messages.length, GEMINI_DETAIL_CAPTURE.messages);
    assert.equal(Reflect.get(stored, 'transport'), undefined);
    assert.equal((await getConversations(OTHER_ACCOUNT_UUID)).length, 0);
});
test('adapter commits a natural empty terminal before callback and exposes no aggregate fields', async () => {
    const provider = new GeminiProvider({ getConversationList: async () => sourceList('G_SOURCE_EMPTY_01'), getConversationDetail: async () => sourceDetail() }, async () => 'u0');
    let progress: unknown;
    assert.equal(await provider.listConversations({ accountId: ACCOUNT_UUID, streamId: 'recent', onPageCommitted: async info => { progress = info; return false; } }), 'source_end');
    assert.deepEqual(Object.keys(progress as object).sort(), ['indexChanges', 'page', 'scanHead', 'totalObserved']);
});
test('adapter readiness is account-bound and reports credential failures without manufacturing account names', async () => {
    const original = credentials.resolveCred;
    try {
        const provider = new GeminiProvider(undefined, async () => 'u0');
        credentials.resolveCred = async () => { throw new Error('credential failure'); };
        assert.deepEqual(await provider.checkReadiness(ACCOUNT_UUID), { ready: false, error: 'credential failure' });
        credentials.resolveCred = async () => { throw 'unknown failure'; };
        assert.deepEqual(await provider.checkReadiness(ACCOUNT_UUID), { ready: false, error: 'Gemini unavailable' });
        assert.equal((await provider.checkReadiness('u0')).ready, false);
    } finally { credentials.resolveCred = original; }
});
