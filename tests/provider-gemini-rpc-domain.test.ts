import { geminiRpcPacket, GEMINI_DETAIL_CAPTURE } from './fixtures/providers/geminiRpcCapture.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { decodeGeminiDetail } from '../src/l1/parsers/gemini/rpc/detailDecoder.js';
import { assertDomainClosure } from '../src/l2/closure.js';
import { textOfBlocks } from './helpers/contentText.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';

const ID = 'c_native12345678';
const native = (data: string) => parseGeminiRpcConversation(data, { account: fixtureAccount('gemini'), providerId: 'gemini' });
const text = textOfBlocks;

test('raw RPC code keeps consecutive blank lines in source Content AST', () => {
    const code = 'import math\n\n\nclass Encoder:\n    def encode(self):\n        return 1\n\n\n\nprint(Encoder().encode())';
    const { conversation } = native(geminiDetailGen('G_RPC_DOMAIN_01'));
    const block = conversation.detail.messages[1].content.find(node => node.type === 'code');
    assert.ok(block?.type === 'code');
    assert.equal(block.code, code + '\n', 'preserve the source newline immediately before the closing fence');

});

test('raw RPC input constructs Domain content, reasoning and citations directly', () => {
    const result = native(geminiDetailGen('G_RPC_DOMAIN_02'));
    assert.equal(result.conversation.index.title, 'Authored title');
    assert.deepEqual(result.conversation.detail.messages.map(m => m.role), ['user', 'assistant']);
    const answer = result.conversation.detail.messages[1];
    assert.ok(answer.content[0].type === 'paragraph');
    assert.ok(answer.content[0].children.some(n => n.type === 'strong'));
    assert.ok(answer.content[0].children.some(n => n.type === 'citationRef'));
    assert.equal(text(answer.reasoning!), 'Check facts');
    assert.deepEqual(answer.citations, [{ id: 'citation-0', url: 'https://example.test/source', title: 'Source' }]);
    assertDomainClosure((result.conversation).detail);
});

test('native parsing imports no historical persisted detail parser', () => {
    assert.equal(native(geminiRpcPacket('detail').responseBody).conversation.detail.messages.length, GEMINI_DETAIL_CAPTURE.messages);
    const source = readFileSync(join(__dirname, '../src/l1/parsers/gemini/rpc/parseConversation.ts'), 'utf8');
    assert.doesNotMatch(source, /parseConversationRecord|parseConversation|parseLegacyConversation|types\/conversation|l3a/);
});

test('source request tokens survive intact in source evidence and Domain', () => {
    const raw = geminiDetailGen('G_RPC_DOMAIN_04');
    assert.equal(decodeGeminiDetail(raw).messages[0].rawProviderRequestId, 'r_AbCd12');
    assert.equal(Reflect.get(native(raw).conversation.detail.messages[0], 'provenance'), undefined);

});

test('wire chronology, primary answers and source dates remain explicit', () => {
    const { conversation } = native(geminiDetailGen('G_RPC_DOMAIN_05'));
    assert.deepEqual(conversation.detail.messages.map(m => text(m.content)), ['Older', 'Old answer', 'Newer', 'First']);
    assert.equal(conversation.index.createdAt, undefined);
    assert.equal(Reflect.get(conversation, 'updatedAt'), undefined, 'message dates do not establish the metadata version');
    assert.equal(conversation.detail.messages.at(-1)?.timestamp, 1700000010000);
    for (const field of ['chatTime', 'lastSeen', 'href', 'turns']) assert.equal(field in conversation, false);
});

test('missing timestamps and request evidence are never fabricated', () => {
    const { conversation } = native(geminiDetailGen('G_RPC_DOMAIN_06'));
    assert.equal(Reflect.get(conversation, 'updatedAt'), undefined);
    assert.equal(conversation.index.createdAt, undefined);
    assert.equal(Reflect.get(conversation, 'updatedAt'), undefined);
    for (const message of conversation.detail.messages) {
        assert.equal(message.timestamp, undefined);
        assert.equal(Object.hasOwn(message, 'provenance'), false);
    }
});

test('pagination and rejected turns yield partial coverage and side-channel diagnostics', () => {
    const result = native(geminiDetailGen('G_RPC_DOMAIN_07'));
    assert.equal(result.conversation.detail.quality.status, 'partial');
    assert.equal(result.transport.nextPageToken, 'tC_native_cursor');
    assert.equal(result.evidence?.rejectedTurns, 1);
    assert.ok(result.diagnostics.some(d => d.code === 'GEMINI_TURNS_REJECTED'));
    assert.ok(result.diagnostics.some(d => d.code === 'GEMINI_SCHEMA_DRIFT'));
    const json = JSON.stringify(result.conversation);
    for (const field of ['transport', 'nextPageToken', '_raw', '_debug', 'schemaDrift', 'turnsRejected', 'diagnostics']) assert.ok(!json.includes(`"${field}":`));
    assert.ok(!json.includes('tC_native_cursor'));
    assert.equal(native(geminiDetailGen('G_RPC_DOMAIN_08')).conversation.detail.quality.status, 'unknown');
});

test('metadata-only pages preserve title evidence without claiming a complete conversation', () => {
    const result = native(geminiDetailGen('G_RPC_DOMAIN_09'));
    assert.equal(result.conversation.index.title, 'Metadata title');
    assert.equal(result.conversationId, ID.replace(/^c_/, ''));
    assert.equal(result.conversation.index.titleSource, 'provider');
    assert.equal(decodeGeminiDetail(geminiDetailGen('G_RPC_DOMAIN_10')).metadataConversation?.title, 'Metadata title');
    assert.equal(result.conversation.detail.messages.length, 0);
    assert.equal(result.conversation.detail.quality.status, 'unknown');
    assert.ok(result.diagnostics.some(d => d.code === 'GEMINI_SCHEMA_DRIFT'));
});

test('source candidates round-trip as keyless JSON without transport or credentials in the graph', () => {
    const result = native(geminiRpcPacket('detail').responseBody);
    const restored = JSON.parse(JSON.stringify(result.conversation));
    assert.deepEqual(restored, result.conversation);
    assertDomainClosure(restored.detail);
    assert.equal('key' in restored.index, false); assert.equal('key' in restored.detail, false);
    assert.equal('account' in result, false); assert.equal('transport' in restored, false);
});

test('sanitized existing wire evidence retains structured content and closed image references', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });
    const raw = geminiDetailGen('G_RPC_DOMAIN_CAPTURED_STACK_01');
    const result = native(raw);
    assert.ok(result.conversation.detail.assets.some(a => a.kind === 'image'));
    assertDomainClosure((result.conversation).detail);
    const asset = result.conversation.detail.assets.find(asset => asset.kind === 'image')!;
    assert.ok(result.conversation.detail.messages[1].attachmentIds?.includes(asset.id));
    assert.equal(decodeGeminiDetail(raw).messages[1].images?.[0].title, '贝尔不等式实验示意图');
    assert.deepEqual(JSON.parse(JSON.stringify(result.conversation)), result.conversation);
    for (const asset of result.conversation.detail.assets) assert.equal('sourceEvidence' in asset, false);

});

test('generated resources retain their authored request token independently of archive paths', () => {
    const raw = geminiDetailGen('G_RPC_DOMAIN_12');
    const result = native(raw);
    const generated = result.conversation.detail.assets.find(asset => asset.generation);
    assert.ok(generated);
    assert.equal(generated.generation?.providerRequestId, 'r_Ab12');
    assert.equal('resourceHints' in result, false);
    for (const field of ['localName', 'subDir', 'rawProviderRequestId']) assert.equal(field in generated, false);
    assertDomainClosure((result.conversation).detail);
});

test('raw format validation rejects wrong providers and malformed envelopes', () => {
    assert.throws(() => parseGeminiRpcConversation(geminiRpcPacket('detail').responseBody, { account: fixtureAccount('openai'), providerId: 'openai' }), /providerId gemini/);
    assert.throws(() => parseGeminiRpcConversation({} as never, { account: fixtureAccount('gemini'), providerId: 'gemini' }), /raw response text/);
    for (const key of ['G_RPC_DOMAIN_20', 'G_RPC_DOMAIN_21', 'G_RPC_DOMAIN_14'] as const) assert.throws(() => native(geminiDetailGen(key)), /detail parse fail/);
    const empty = parseGeminiRpcConversation(geminiDetailGen('G_RPC_DOMAIN_15'), { account: fixtureAccount('gemini'), providerId: 'gemini', targetConvId: ID });
    assert.equal(empty.conversationId, ID.replace(/^c_/, ''));
    assert.equal(empty.conversation.detail.messages.length, 0);
});

test('source extraction has no export paths and retains unsanitized source filenames', () => {
    const raw = geminiDetailGen('G_RPC_DOMAIN_16');
    const evidence = decodeGeminiDetail(raw);
    const source = evidence.messages[1].images![0];
    assert.equal(source.fileName, 'source:photo?.png');
    for (const message of evidence.messages) {
        for (const resource of [...message.images ?? [], ...message.documents ?? [], ...message.attachments ?? []]) {
            assert.equal('localName' in resource, false);
            assert.equal('resolvedUrl' in resource, false);
        }
    }
    const bare = decodeGeminiDetail(geminiDetailGen('G_RPC_DOMAIN_17'));
    assert.equal(bare.messages[1].images![0].fileName, undefined);
    assert.equal(native(raw).conversation.detail.assets.find(a => a.generation)?.name, 'source:photo?.png');
});

test('raw decoding never substitutes conversation or request IDs for absent message identities', () => {
    const raw = geminiDetailGen('G_RPC_DOMAIN_18');
    const result = native(raw);
    assert.equal(result.conversation.detail.messages.length, 4);
    for (const message of result.conversation.detail.messages) assert.equal(message.id, undefined);
    assertDomainClosure(result.conversation.detail);
    assert.deepEqual(JSON.parse(JSON.stringify(result.conversation)), result.conversation);
    assert.equal(decodeGeminiDetail(raw).messages[0].id, '');
    const request = geminiDetailGen('G_RPC_DOMAIN_19');
    assert.equal(decodeGeminiDetail(request).messages[0].providerRequestId, 'r_Ab12');
});
