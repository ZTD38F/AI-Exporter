import { fixtureKey } from './helpers/domainFixture.js';
import { historicalFixture, historicalFixtureDomain } from './helpers/nativeFixture.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';
import { messageAssets } from './helpers/domainAssets.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoricalConversation as Conversation } from './helpers/historicalConversation.js';
import type { ChatMessage } from './helpers/historicalConversation.js';
import type { DomainGeneratedMediaIdentity } from '../src/l2/conversationDetail.js';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
import { composeFixture } from './helpers/documentFixture.js';
import { supplementLegacyGeneratedMedia } from './helpers/recordFixture/generatedMediaReconciliation.js';

const metadata = { id: 'media-chat', title: 'Generated media', timestamp: 1700000000123 };
const requestId = 'abcd1234abcd1234';
const generation: import('./helpers/historicalConversation.js').GeneratedMediaIdentity = {
    chatId: metadata.id, providerRequestId: requestId, time: metadata.timestamp,
    prompt: 'Draw a cat', generationOrdinal: 0, imageCount: 1, imageOrdinal: 0,
};
const media = [{ filename: 'cat.png', isGenerated: true, generation }];

function legacy(messages: ChatMessage[]): Conversation {
    return { ...metadata, messages };
}

for (const [evidence, userFields, assistantFields] of [
    ['direct request', {}, { providerRequestId: `r_${requestId.toUpperCase()}` }],
    ['legacy user message ID', { id: `r_${requestId}` }, {}],
    ['legacy assistant message ID', {}, { id: `r_${requestId}` }],
    ['legacy turn ID', { turnId: `r_${requestId}` }, {}],
    ['prompt and same-second timestamp', { timestamp: 1700000000999 }, {}],
] as const) {
    test(`Domain construction resolves generated image using ${evidence}`, async () => {
        const conversation = legacy([
            { id: 'wrong-user', role: 'user', content: 'Earlier question', timestamp: 1699999900000 },
            { id: 'wrong-assistant', role: 'model', content: 'Earlier answer' },
            { role: 'user', content: 'Draw a cat', ...userFields },
            { role: 'model', content: 'Your cat', ...assistantFields },
            { role: 'user', content: 'Later question' },
            { role: 'assistant', content: 'Later answer' },
        ]);
        const original = structuredClone(conversation);
        const originalMedia = structuredClone(media);
        const { conversation: domain, resourceHints } = historicalFixture(conversation, { generatedMedia: media });
        assert.equal(domain.detail.messages.length, 6);
        assert.equal(domain.detail.messages[3].role, 'assistant');
        assert.equal(messageAssets(domain, 3)?.[0].name, 'cat.png');
        assert.deepEqual(domain.detail.messages[3].content, [{ type: 'paragraph', children: [{ type: 'text', text: 'Your cat' }] }]);
        assert.equal(domain.detail.messages.filter(m => m.attachmentIds?.length).length, 1);
        assert.deepEqual(conversation, original);
        assert.deepEqual(media, originalMedia);
        const compat = structuredClone(conversation);
        supplementLegacyGeneratedMedia(compat, metadata.id, media, { appendMarkdownRef: false });
        assert.deepEqual((await composeFixture(domain, resourceHints)).document, (await composeFixture(historicalFixture(compat, { providerId: 'gemini' }).conversation, resourceHints)).document);
    });
}

for (const [ambiguity, messages] of [
    ['duplicate direct request', [
        { role: 'assistant', content: 'A', providerRequestId: requestId },
        { role: 'assistant', content: 'B', providerRequestId: requestId },
    ]],
    ['duplicate legacy request', [
        { role: 'user', content: 'Draw a cat', id: `r_${requestId}` }, { role: 'model', content: 'A' },
        { role: 'user', content: 'Draw a cat', id: `r_${requestId}` }, { role: 'model', content: 'B' },
    ]],
    ['duplicate prompt and time', [
        { role: 'user', content: 'Draw a cat', timestamp: metadata.timestamp }, { role: 'model', content: 'A' },
        { role: 'user', content: 'Draw a cat', timestamp: metadata.timestamp }, { role: 'model', content: 'B' },
    ]],
    ['multiple responses', [
        { role: 'user', content: 'Draw a cat', id: `r_${requestId}` },
        { role: 'model', content: 'A' }, { role: 'assistant', content: 'B' },
    ]],
    ['next user intervenes', [
        { role: 'user', content: 'Draw a cat', id: `r_${requestId}` },
        { role: 'user', content: 'Unrelated question' }, { role: 'assistant', content: 'Unrelated answer' },
    ]],
] as const) {
    test(`Ambiguous ${ambiguity} never assigns generated image to an existing message`, () => {
        const conversation = legacy(messages.map(m => ({ ...m })));
        const { conversation: domain, resourceHints } = historicalFixture(conversation, { generatedMedia: media });
        assert.ok(domain.detail.messages.slice(0, messages.length).every(m => !m.attachmentIds?.length));
        assert.equal(domain.detail.messages.length, messages.length + 1, 'unresolved media is retained separately');
        assert.equal(messageAssets(domain, domain.detail.messages.length - 1)?.[0].name, 'cat.png');
        assert.ok(domain.detail.messages.slice(0, messages.length).every(m => !('generation' in m)));
        assert.equal('generation' in (domain.detail.messages.at(-1) ?? {}), false);
    });
}

test('Domain construction reconciles flattened legacy turns before evidence is discarded', () => {
    const conversation: Conversation = { ...metadata, turns: [{ messages: [
        { role: 'user', content: 'Draw a cat', turnId: `r_${requestId}` }, { role: 'model', content: 'Answer' },
    ] }] };
    const { conversation: domain, resourceHints } = historicalFixture(conversation, { generatedMedia: media });
    assert.equal(messageAssets(domain, 1)?.[0].name, 'cat.png');
    assert.equal('turnId' in domain.detail.messages[0], false);
});

test('Domain construction deduplicates provider representations while Composer uses explicit media only', async () => {
    const first = { type: 'image', isGenerated: true, providerRequestId: requestId, imageOrdinal: 0, localName: 'online.jpg', sourceUri: 'data:image/png;base64,AQID' };
    const duplicate = { ...first, localName: 'offline.png', generation };
    const second = { ...first, imageOrdinal: 1, localName: 'second.jpg' };
    const conversation = legacy([{ role: 'assistant', content: '', attachments: [first], images: [duplicate, second] }]);
    const original = structuredClone(conversation);
    const { conversation: domain, resourceHints } = historicalFixture(conversation);
    assert.ok(messageAssets(domain, 0)?.every(asset => !Object.hasOwn(asset, 'path')));
    assert.deepEqual((await composeFixture(domain, resourceHints)).document, (await composeFixture(historicalFixture(conversation, { providerId: 'gemini' }).conversation, resourceHints)).document);
    assert.deepEqual(conversation, original);
    const explicitDomain: DomainConversationWithDetail = { index: { key: fixtureKey(String(metadata.id), 'gemini'),   titleSource: "derived",  title: metadata.title,  }, detail: { key: fixtureKey(String(metadata.id), 'gemini'), quality: { status: 'unknown' }, assets: ['one', 'two', 'three'].map(id => ({ id, kind: 'image', generation: { providerRequestId: generation.providerRequestId, time: generation.time ?? undefined, prompt: generation.prompt, generationOrdinal: generation.generationOrdinal, imageCount: generation.imageCount, imageOrdinal: generation.imageOrdinal } })), messages: [{ role: 'assistant', content: [], attachmentIds: ['one', 'two', 'three'] }] } };
    assert.equal(collectDocumentResources((await composeFixture(explicitDomain)).document).referencedIds.size, 3,
        'Composer must not collapse explicit attachments using provider IDs');
});

test('Explicit message attachment ownership is authoritative downstream', async () => {
    const domain: DomainConversationWithDetail = { index: { key: fixtureKey(String(metadata.id), 'gemini'),   titleSource: "derived",  title: metadata.title,  }, detail: { key: fixtureKey(String(metadata.id), 'gemini'), quality: { status: 'unknown' }, assets: [{ id: 'cat', kind: 'image', name: 'cat.png', generation: { providerRequestId: generation.providerRequestId, time: generation.time ?? undefined, prompt: generation.prompt, generationOrdinal: generation.generationOrdinal, imageCount: generation.imageCount, imageOrdinal: generation.imageOrdinal } }], messages: [
        { id: requestId, role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'First' }] }] },
        { role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Second' }] }], attachmentIds: ['cat'] },
    ] } };
    const original = structuredClone(domain);
    const result = await composeFixture(domain);
    assert.equal(result.document.messages[0].blocks.some(b => b.type === 'image'), false);
    assert.equal(result.document.messages[1].blocks.some(b => b.type === 'image'), true);
    assert.deepEqual(domain, original);
});

test('Unknown or foreign evidence never borrows an arbitrary assistant response', () => {
    const domain = historicalFixtureDomain(legacy([{ role: 'assistant', content: 'Existing' }]), { generatedMedia: [
        { filename: 'unknown.png', isGenerated: true },
        { filename: 'foreign.png', isGenerated: true, generation: { ...generation, chatId: 'foreign-chat' } },
    ] });
    assert.equal(domain.detail.messages.length, 3);
    assert.deepEqual(messageAssets(domain, 0), []);
    assert.equal(messageAssets(domain, 1)?.[0].name, 'unknown.png');
    assert.equal(messageAssets(domain, 2)?.[0].name, 'foreign.png');
});

test('Conflicting response request evidence cannot be overridden by prompt/time fallback', () => {
    const domain = historicalFixtureDomain(legacy([
        { role: 'user', content: 'Draw a cat', timestamp: metadata.timestamp },
        { role: 'assistant', content: 'Another event', providerRequestId: 'different-request' },
    ]), { generatedMedia: media });
    assert.deepEqual(messageAssets(domain, 1), []);
    assert.equal(domain.detail.messages.length, 3);
});

test('Detached generated media without messages remains a separate resolved attachment', () => {
    const domain = historicalFixtureDomain(legacy([]), { generatedMedia: media });
    assert.equal(domain.detail.messages.length, 1);
    assert.equal(domain.detail.messages[0].role, 'assistant');
    assert.equal(messageAssets(domain, 0)?.[0].name, 'cat.png');
});

test('Unknown multi-image ordinals cannot suppress detached media using request identity', async () => {
    const multiGeneration = { ...generation, imageCount: 2, imageOrdinal: undefined };
    const conversation = legacy([{ role: 'assistant', content: 'Two cats', providerRequestId: requestId,
        generation: multiGeneration,
        images: [{ type: 'image', isGenerated: true, providerRequestId: requestId, imageOrdinal: 0, fileName: 'online.jpg', url: 'https://example.test/online.jpg' }],
    }]);
    const original = structuredClone(conversation);
    const domain = historicalFixtureDomain(conversation, { generatedMedia: [
        { filename: 'offline-a.png', isGenerated: true, generation: multiGeneration },
        { filename: 'offline-b.png', isGenerated: true, generation: multiGeneration },
    ] });
    assert.equal(domain.detail.messages.length, 1);
    assert.deepEqual(messageAssets(domain, 0)?.map(a => a.name), ['offline-a.png', 'offline-b.png', 'online.jpg']);
    assert.equal('generation' in (domain.detail.messages[0] ?? {}), false);
    assert.equal(collectDocumentResources((await composeFixture(domain)).document).referencedIds.size, 3);
    assert.deepEqual(conversation, original);
});
