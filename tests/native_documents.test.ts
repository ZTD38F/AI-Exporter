import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { mergeConversationPages } from '../src/l1/parsers/gemini/rpc/mergePages.js';
import { decodeCandidateArtifacts } from '../src/l1/parsers/gemini/rpc/candidateArtifacts.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';

function packet(kind: number, body: string, suffix = 'report.md') {
    const row: unknown[] = ['c_native_chat_' + suffix, null, 'Source document', null, body];
    row[10] = kind;
    return row;
}
function capture(key: Parameters<typeof geminiDetailGen>[0]) {
    return parseGeminiRpcConversation(geminiDetailGen(key), { providerId: 'gemini', targetConvId: 'native_chat' });
}
for (const [kind, body, key, nextKey] of [
    [1, '# Report\n\nExact source body', 'G_NATIVE_DOCUMENT_01', 'G_NATIVE_DOCUMENT_02'],
    [2, "```python\nprint(\"ok\")\n```", 'G_NATIVE_DOCUMENT_03', 'G_NATIVE_DOCUMENT_04'],
    [3, '# Research\n\nReferences and findings', 'G_NATIVE_DOCUMENT_05', 'G_NATIVE_DOCUMENT_06'],
] as const) {
    test(`native document kind ${kind}: exact body without metadata or heuristic duplication`, () => {
        const parsed = capture(key);
        assert.equal(parsed.conversation.detail.assets.length, 1);
        assert.equal(parsed.conversation.detail.assets[0].document?.contentMarkdown, body);
        assert.deepEqual(parsed.evidence?.heuristicDocumentIds, []);
        assert.equal(parsed.conversation.detail.messages.length, 2);
        const merged = mergeConversationPages([parsed], undefined, true);
        assert.equal(merged.conversation.detail.quality.status, 'complete');
        assert.equal(merged.conversation.detail.savedAt, 1700000000000);
        assert.ok(merged.diagnostics.some(d => d.code === 'CONVERSATION_VERSION_MISMATCH'));
        assert.equal(mergeConversationPages([capture(nextKey)], 'token_loop', false).conversation.detail.quality.status, 'partial');
    });
}
test('native document decoding rejects unrelated identities, unknown kinds and malformed bodies', () => {
    const foreign = packet(3, 'Foreign'); foreign[0] = 'c_another_chat_report';
    const noBody = packet(3, '');
    const candidate: unknown[] = []; candidate[30] = [foreign, noBody, packet(26, 'code packet'), packet(99, 'unknown')];
    assert.deepEqual(decodeCandidateArtifacts(candidate, 'native_chat').nativeDocuments, []);
    assert.deepEqual(decodeCandidateArtifacts(candidate).nativeDocuments, []);
});
test('native documents stay bound to their answer when titles match', () => {
    const a = capture('G_NATIVE_DOCUMENT_07');
    const b = capture('G_NATIVE_DOCUMENT_08');
    assert.equal(a.conversation.detail.assets[0].document?.contentMarkdown, 'First body');
    assert.equal(b.conversation.detail.assets[0].document?.contentMarkdown, 'Second body');
    assert.notEqual(a.conversation.detail.assets[0].id, b.conversation.detail.assets[0].id);
});
