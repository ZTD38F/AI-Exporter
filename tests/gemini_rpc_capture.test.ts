import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiRpcPacket, geminiDetailIdentityVariant, GEMINI_DETAIL_CAPTURE as expected } from './fixtures/providers/geminiRpcCapture.js';
import { editCapturedRpc } from './fixtures/providers/geminiCaptureWire.js';
import { geminiListPage, geminiListRow, geminiListVariant } from './fixtures/providers/geminiListCapture.js';
import { parseGeminiRequest } from '../src/l1/parsers/gemini/rpc/request.js';
import { decodeGeminiDetail } from '../src/l1/parsers/gemini/rpc/detailDecoder.js';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { parseList } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { assertDomainClosure } from '../src/l2/closure.js';

test('captured Detail request binds all seven chronological turns to one conversation', () => {
    const packet = geminiRpcPacket('detail');
    assert.equal(packet.status, 200);
    assert.deepEqual(parseGeminiRequest(packet.requestBody).detail, { conversationId: expected.conversationId, requestCursor: null });
    const evidence = decodeGeminiDetail(packet.responseBody);
    assert.equal(evidence.messages.length, 14);
    assert.equal(evidence.messages[0].rawProviderRequestId, expected.firstRequestId);
    assert.equal(evidence.messages[0].timestamp, expected.firstTimestamp);
    assert.equal(evidence.messages.at(-1)?.timestamp, expected.lastTimestamp);
    const parsed = parseGeminiRpcConversation(packet.responseBody, { providerId: 'gemini' });
    assert.equal(parsed.conversationId, expected.conversationId);
    assert.equal(parsed.transport.nextPageToken, null);
    assert.deepEqual(parsed.diagnostics, []);
    assert.deepEqual(parsed.conversation.detail.messages.map(m => m.role), Array.from({ length: 7 }, () => ['user', 'assistant']).flat());
    assertDomainClosure(parsed.conversation.detail);
});

test('captured empty Pinned response is valid source end for its own request stream', () => {
    const packet = geminiRpcPacket('pinned');
    assert.equal(packet.status, 200);
    assert.deepEqual(parseGeminiRequest(packet.requestBody).list, { streamId: 'pinned', requestCursor: null });
    const parsed = parseList(packet.responseBody);
    assert.deepEqual(parsed.conversations, []);
    assert.equal(parsed.pageEvidence.valid, true);
    assert.equal(parsed.nextPageToken, null);
    assert.equal(parsed.failure, undefined);
});

test('explicit List state variants preserve captured row slots and isolate mutations', () => {
    const baseline = geminiListPage().responseBody;
    const row = geminiListRow('state', 'Renamed conversation', 1700000000);
    assert.equal(row.length, 25);
    editCapturedRpc(baseline, 'MaZiqc', inner => {
        const original = (inner[2] as unknown[][])[0];
        for (let index = 0; index < original.length; index++) {
            if (![0, 1, 5].includes(index)) assert.deepEqual(row[index], original[index]);
        }
    });
    const variant = geminiListVariant([row], 'tC_state');
    const parsed = parseList(variant);
    assert.equal(parsed.conversations[0].id, 'state');
    assert.equal(parsed.conversations[0].title, 'Renamed conversation');
    assert.equal(parsed.conversations[0].updatedAt, 1700000000000);
    assert.equal(parsed.nextPageToken, 'tC_state');
    row[0] = 'c_mutated';
    assert.equal(parseList(variant).conversations[0].id, 'state');
    assert.equal(geminiListPage().responseBody, baseline);
    for (const body of [variant, geminiRpcPacket('detail').responseBody, geminiRpcPacket('pinned').responseBody]) {
        const lines = body.split('\n');
        for (let i = 2; i < lines.length - 1; i += 2) assert.equal(Number(lines[i]), lines[i + 1].length + 2);
    }
});

test('identity-only Detail variants retain every captured turn and native framing', () => {
    const baseline = geminiRpcPacket('detail').responseBody;
    const derived = geminiDetailIdentityVariant('isolated_account_chat');
    const restored = editCapturedRpc(derived, 'hNvQHb', inner => {
        const restore = (value: unknown): unknown => value === 'c_isolated_account_chat'
            ? 'c_' + expected.conversationId : Array.isArray(value) ? value.map(restore) : value;
        inner.splice(0, inner.length, ...inner.map(restore));
    });
    assert.equal(restored, baseline);
    assert.equal(geminiRpcPacket('detail').responseBody, baseline);
    const evidence = decodeGeminiDetail(derived);
    assert.equal(evidence.messages.length, expected.messages);
    assert.equal(evidence.messages[0].timestamp, expected.firstTimestamp);
    assert.equal(evidence.messages.at(-1)?.timestamp, expected.lastTimestamp);
    assert.equal(parseGeminiRpcConversation(derived, { providerId: 'gemini' }).conversationId, 'isolated_account_chat');
});
