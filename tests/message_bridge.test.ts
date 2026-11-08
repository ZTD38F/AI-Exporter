import { geminiListPage, GEMINI_LIST_CAPTURE } from './fixtures/providers/geminiListCapture.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { useAccountRuntime, ACCOUNT_UUID, ACCOUNT_OBSERVATION } from './helpers/accountRuntime.js';
import { init, handleWindowMessage } from '../src/l1/sniffer/gemini/messageBridge.js';
import { listIndexes as getConversations } from '../src/l3a/storageService.js';
import { getDetail } from '../src/l3a/storageService.js';
import { getCoverage } from '../src/l2/coverageAdmission.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
useIndexStorage(); useAccountRuntime(); beforeEach(() => { init(); });
const list = geminiListPage(22).responseBody;
const detail = geminiDetailGen('G_MESSAGE_BRIDGE_DETAIL_01');
function event(type: string, extra: Record<string, unknown> = {}): MessageEvent {
    return { origin: location.origin, source: window, data: { type, payload: { slot: 'u0', requestAccountObservation: ACCOUNT_OBSERVATION, ...extra } } } as unknown as MessageEvent;
}
import { CrossWorldEvents } from '../src/l1/protocol/gemini/protocol.js';
function sourceCapture(text = list, extra: Record<string, unknown> = {}): MessageEvent {
    return event(CrossWorldEvents.NETWORK_BATCHEXECUTE, { text, url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute', requestedAt: Date.now(), truncated: false, ...extra });
}

test('unverified deletion emits no callback and never fetches verification', async () => {
    const emitted: unknown[] = [];
    init({ onConversationDeleted: (id, accountId) => emitted.push([id, accountId]) });
    const original = globalThis.fetch; globalThis.fetch = async () => { assert.fail('Sniffer must not acquire'); };
    try { await handleWindowMessage(event(CrossWorldEvents.CONVERSATION_DELETED, { id: 'bridge_chat_123' })); }
    finally { globalThis.fetch = original; }
    assert.deepEqual(emitted, []);
});
test('foreign window and foreign origin cannot submit captured facts', async () => {
    await handleWindowMessage({ ...sourceCapture(), source: {} } as MessageEvent);
    await handleWindowMessage({ ...sourceCapture(), origin: 'https://evil.test' });
    assert.equal((await getConversations(ACCOUNT_UUID)).length, 0);
});
for (const fields of [{ url: 'https://evil.test/batchexecute' }, { requestedAt: undefined }, { truncated: undefined }, { slot: 'other' }, { text: geminiListGen('G_MESSAGE_BRIDGE_OVERSIZED_BODY_01') }]) {
    test(`capture rejects malformed provenance ${Object.keys(fields)[0]}`, async () => {
        await handleWindowMessage(sourceCapture(list, fields)); assert.equal((await getConversations(ACCOUNT_UUID)).length, 0);
    });
}
test('list facts enter L2 directly; unknown request evidence never certifies Coverage', async () => {
    await handleWindowMessage(sourceCapture());
    assert.equal((await getConversations(ACCOUNT_UUID)).length, GEMINI_LIST_CAPTURE.lastPageRows);
    assert.equal((await getCoverage(ACCOUNT_UUID, 'recent'))?.range ?? null, null);
});
test('known natural list request can submit source evidence without a Sync dependency', async () => {
    await handleWindowMessage(sourceCapture(list, { listRequest: { streamId: 'recent', requestCursor: null } }));
    assert.ok((await getCoverage(ACCOUNT_UUID, 'recent'))?.range);
});
test('mismatched Detail request identity is rejected before admission or retention', async () => {
    await handleWindowMessage(sourceCapture(detail, { detailRequest: { conversationId: 'wrong_chat', requestCursor: null } }));
    assert.equal((await getConversations(ACCOUNT_UUID)).length, 0);
});
test('uncorrelated Detail remains usable unknown source facts and never requests missing pages', async () => {
    await handleWindowMessage(sourceCapture(detail));
    const stored = await getDetail({ accountId: ACCOUNT_UUID, conversationId: 'bridge_chat_123' });
    assert.ok(stored); assert.equal(stored.quality.status, 'unknown');
    assert.equal(stored.messages.length, 14);
});
test('task resource capture receives the same account/conversation binding as L2', async () => {
    const resources = createSourceResourceContext(); let observed: unknown;
    resources.retainParsed = (key, parsed) => { observed = [key, parsed.conversationId]; };
    init({ resources });
    try {
        await handleWindowMessage(sourceCapture(detail, { detailRequest: { conversationId: 'bridge_chat_123', requestCursor: null } }));
        assert.deepEqual(observed, [{ accountId: ACCOUNT_UUID, conversationId: 'bridge_chat_123' }, 'bridge_chat_123']);
    } finally { resources.release(); init(); }
});

test('RPC identifiers in a foreign body cannot dispatch captured list or detail facts', async () => {
    await handleWindowMessage(sourceCapture(geminiDetailGen('G_DISPATCH_DECOY_01')));
    assert.deepEqual(await getConversations(ACCOUNT_UUID), []);
});

test('mixed batch dispatch admits both list and matching detail through the shared response', async () => {
    await handleWindowMessage(sourceCapture(geminiDetailGen('G_DISPATCH_MIXED_01'), {
        detailRequest: { conversationId: 'boundary12345678', requestCursor: null },
    }));
    const indexes = await getConversations(ACCOUNT_UUID);
    assert.equal(indexes.length, 1);
    assert.equal(indexes[0].title, 'Dispatch title');
    const stored = await getDetail({ accountId: ACCOUNT_UUID, conversationId: 'boundary12345678' });
    assert.equal(stored?.messages.length, 2);
    assert.equal(stored?.savedAt, 1700000010000);
});
