import { fixtureAccountFor } from './helpers/domainFixture.js';
import { fixtureKey } from './helpers/domainFixture.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { historicalFixture, historicalFixtureDomain } from './helpers/nativeFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoricalConversation as Conversation } from './helpers/historicalConversation.js';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
import type { BlockNode } from '../src/l2/content/blocks.js';
import { assertDomainClosure } from '../src/l2/closure.js';
import { composeFixture } from './helpers/documentFixture.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';
import { mapContentAssetReferences } from '../src/l2/content/assetReferences.js';
import { messageAssets } from './helpers/domainAssets.js';

const metadata = { id: 'closed', title: 'Closed Domain', timestamp: null };
const text = (value: string): BlockNode[] => [{ type: 'paragraph', children: [{ type: 'text', text: value }] }];
function references(blocks: BlockNode[]): string[] {
    const refs: string[] = [];
    mapContentAssetReferences(blocks, ref => { refs.push(ref); return ref; });
    return refs;
}

test('one registry resource spans messages, attachment aliases, body and reasoning', async () => {
    const generation = { chatId: metadata.id, providerRequestId: 'request-1234', generationOrdinal: 1, imageCount: 1, imageOrdinal: 0 };
    const input: Conversation = { ...metadata, messages: [
        { role: 'user', content: '![one](assets/online.png)', attachments: [{ type: 'image', localName: 'online.png', generation }] },
        { role: 'assistant', content: '> ![two](offline.png)', thoughts: '![three](https://example.test/image)',
            images: [{ type: 'image', localName: 'offline.png', sourceUrl: 'https://example.test/image', generation,
                isGenerated: true, dataBase64: 'AQID', width: 120, height: 80, mimeType: 'image/png' }] },
        { role: 'assistant', content: '![four](https://example.test/image)' },
    ] };
    const original = structuredClone(input);
    const { conversation: domain, resourceHints, acquisitionHints } = historicalFixture(input);
    assert.equal(domain.detail.assets.length, 1);
    const [asset] = domain.detail.assets;
    assert.deepEqual(domain.detail.messages.slice(0, 2).map(message => message.attachmentIds), [[asset.id], [asset.id]]);
    assert.equal(domain.detail.messages[2].attachmentIds, undefined, 'a content reference does not imply a new explicit attachment');
    assert.deepEqual(domain.detail.messages.flatMap(message => references(message.content)), [asset.id, asset.id, asset.id]);
    assert.deepEqual(references(domain.detail.messages[1].reasoning!), [asset.id]);
    assert.deepEqual(asset.generation, Object.fromEntries(Object.entries(generation).filter(([key]) => key !== 'chatId' && key !== 'turnId')));
    assert.equal(Reflect.get(asset, 'generated'), undefined);
    assert.deepEqual(Reflect.get(asset, 'dimensions'), undefined);
    assert.equal(asset.mediaType, 'image/png');
    assert.equal(acquisitionHints[asset.id].dataBase64, 'AQID');
    assert.equal(Object.hasOwn(asset, 'dataBase64'), false);
    const restored: DomainConversationWithDetail = JSON.parse(JSON.stringify(domain));
    assert.deepEqual(restored, domain);
    const result = await composeFixture(domain);
    assert.deepEqual((await composeFixture(restored)).document, result.document);
    assert.ok(Array.isArray(result.document.messages), 'Composer returns the direct AST without diagnostics');
    assert.deepEqual(input, original);
    assert.deepEqual(domain, restored, 'export must not mutate Domain');
});

test('body-only URI resources are unique across messages and reasoning, including local aliases and data URIs', async () => {
    for (const [first, second] of [
        ['https://example.test/shared.png', 'https://example.test/shared.png'],
        ['data:image/png;base64,AQID', 'data:image/png;base64,AQID'],
        ['assets/a%20b.png', './a b.png'],
    ]) {
        const domain = historicalFixtureDomain({ ...metadata, messages: [
            { role: 'user', content: `![body](${first})` },
            { role: 'assistant', content: `![body](<${second}>)`, thoughts: `![reason](<${second}>)` },
        ] });
        assert.equal(domain.detail.assets.length, 1);
        assert.equal(domain.detail.messages.every(message => message.attachmentIds === undefined), true);
        assert.deepEqual(references(domain.detail.messages[1].reasoning!), [domain.detail.assets[0].id]);
        assert.deepEqual(references(domain.detail.messages[1].content), [domain.detail.assets[0].id]);
        assert.deepEqual((await composeFixture(JSON.parse(JSON.stringify(domain)))).document,
            (await composeFixture(domain)).document);
    }
});

test('document aliases merge across messages without losing metadata or byte payloads', async () => {
    const document = { type: 'doc', id: 'report', title: 'Report', createdAt: 123, contentMarkdown: '# Report',
        chipUrl: 'https://example.test/chip', sections: ['Intro', 'Intro'], links: [{ title: 'Source', url: 'https://example.test' }],
        candidates: ['https://example.test/report'], hasFabricatedText: false };
    const input: Conversation = { ...metadata, messages: [
        { role: 'assistant', content: '', attachments: [{ ...document, dataBuffer: new Uint8Array([1, 2, 3]) }] },
        { role: 'assistant', content: '', documents: [document] },
    ] };
    const original = structuredClone(input);
    const { conversation: domain, resourceHints, acquisitionHints } = historicalFixture(input);
    const [asset] = domain.detail.assets;
    assert.equal(domain.detail.assets.length, 1);
    assert.equal(asset.kind, 'file');
    assert.equal(asset.name, 'Report');
    assert.equal(acquisitionHints[asset.id].dataBase64, 'AQID');
    assert.equal(Object.hasOwn(asset, 'dataBase64'), false);
    const expectedDocument = { id: document.id, contentMarkdown: '# Report\n\nIntro\n\nIntro\n\n[Source](https://example.test)' };
    assert.deepEqual(asset.document, expectedDocument);
    assert.equal(messageAssets(domain, 0)[0], messageAssets(domain, 1)[0]);
    const restored: DomainConversationWithDetail = JSON.parse(JSON.stringify(domain));
    assert.deepEqual(restored, domain);
    assert.deepEqual((await composeFixture(restored)).document, (await composeFixture(domain)).document);
    assert.deepEqual(input, original);
});

test('reordering messages preserves identities established by resource source or generation evidence', () => {
    const input: Conversation = { ...metadata, messages: [
        { role: 'user', content: '![inline](https://example.test/inline)' },
        { role: 'assistant', content: '', attachments: [{ type: 'image', localName: 'one.png', providerRequestId: 'request-1234', imageOrdinal: 0 }] },
        { role: 'assistant', content: '', documents: [{ type: 'doc', id: 'report', contentMarkdown: '# Report' }] },
    ] };
    const first = historicalFixtureDomain(input);
    const reversed = historicalFixtureDomain({ ...input, messages: [...input.messages!].reverse() });
    assert.deepEqual(first.detail.assets.map(asset => asset.id).sort(), reversed.detail.assets.map(asset => asset.id).sort());
});

test('missing evidence, unknown ordinals and conflicting documents never collapse distinct resources', () => {
    const domain = historicalFixtureDomain({ ...metadata, messages: [
        { role: 'user', content: '', attachments: [{ type: 'file' }, { type: 'file', name: 'same.txt' }] },
        { role: 'assistant', content: '', attachments: [{ type: 'file' }, { type: 'file', name: 'same.txt' },
            { type: 'image', providerRequestId: 'request-1234' }, { type: 'image', providerRequestId: 'request-1234' }],
            documents: [{ type: 'doc', id: 'a', url: 'https://example.test/shared' }, { type: 'doc', id: 'b', url: 'https://example.test/shared' }] },
    ] });
    assert.equal(domain.detail.assets.length, 8);
    assert.equal(new Set(domain.detail.assets.map(asset => asset.id)).size, 8);
    assertDomainClosure((JSON.parse(JSON.stringify(domain))).detail);
});

test('downstream binding respects Domain identity even when two URIs have the same basename', async () => {
    const domain: DomainConversationWithDetail = { index: { key: fixtureKey(String(metadata.id), 'custom'),   titleSource: "derived",  title: metadata.title,  }, detail: { key: fixtureKey(String(metadata.id), 'custom'), quality: { status: 'unknown' }, assets: [
        { id: 'one', kind: 'image', name: 'Attachment', sourceUri: 'https://one.test/shared.png' },
        { id: 'two', kind: 'image', sourceUri: 'https://two.test/shared.png' },
    ], messages: [{ role: 'assistant', content: [{ type: 'image', assetId: 'two', alt: 'Inline' }], attachmentIds: ['one'] }] } };
    const result = await composeFixture(domain);
    assert.equal(collectDocumentResources(result.document).referencedIds.size, 2);
    assert.deepEqual(domain.detail.assets.map(asset => asset.sourceUri), ['https://one.test/shared.png', 'https://two.test/shared.png']);
    assert.equal(result.document.messages[0].blocks[0].type, 'image');
    assert.equal(result.document.messages[0].blocks[0].type === 'image' && result.document.messages[0].blocks[0].resourceId, 'two');
});

test('resource IDs never collide with export numbering or acquisition URI aliases', async () => {
    const domain: DomainConversationWithDetail = { index: { key: fixtureKey(String(metadata.id), 'custom'),   titleSource: "derived",  title: metadata.title,  }, detail: { key: fixtureKey(String(metadata.id), 'custom'), quality: { status: 'unknown' }, assets: [
        { id: 'msg-0-a1', kind: 'image', name: 'First', sourceUri: 'https://first.test/image' },
        { id: 'second', kind: 'image', name: 'Second', sourceUri: 'msg-0-a1' },
    ], messages: [{ role: 'assistant', attachmentIds: ['msg-0-a1', 'second'],
        content: [{ type: 'image', assetId: 'msg-0-a1' }, { type: 'image', assetId: 'second' }] }] } };
    const result = await composeFixture(domain);
    assert.deepEqual(result.document.messages[0].blocks.map(block => 'resourceId' in block ? block.resourceId : undefined), ['msg-0-a1', 'second', 'msg-0-a1', 'second']);
});

test('resource metadata and audio/video kinds survive neutral downstream adaptation', async () => {
    const domain: DomainConversationWithDetail = { index: { key: fixtureKey(String(metadata.id), 'custom'),   titleSource: "derived",  title: metadata.title,  }, detail: { key: fixtureKey(String(metadata.id), 'custom'), quality: { status: 'unknown' }, assets: [
        { id: 'audio', kind: 'audio', name: 'Audio' }, { id: 'video', kind: 'video', name: 'Video' },
        { id: 'image', kind: 'image', name: 'Shared', mediaType: 'image/png',
            sourceUri: 'https://example.test/image' },
    ], messages: [{ role: 'assistant', attachmentIds: ['audio', 'video'], content: [{ type: 'image', assetId: 'image' }] }] } };
    const result = await composeFixture(domain);
    const [image, audio, video] = result.document.messages[0].blocks;
    assert.ok(image.type === 'image');
    assert.equal(image.resourceId, 'image');
    assert.equal(image.alt, 'Shared');
    assert.ok(audio.type === 'file' && video.type === 'file');
    assert.equal(audio.kind, 'audio');
    assert.equal(video.kind, 'video');
    assert.equal(domain.detail.assets[2].mediaType, 'image/png');
    assert.equal(Reflect.get(domain.detail.assets[2], 'dimensions'), undefined);
});

test('reasoning is parsed at the producer boundary and Domain reasoning text stays literal downstream', async () => {
    const parsed = historicalFixtureDomain({ ...metadata, messages: [{ role: 'assistant', content: 'Body',
        thoughts: '<p>**strong**</p><p>![image](https://example.test/image)</p>' }] });
    assert.ok(parsed.detail.messages[0].reasoning?.[0].type === 'paragraph');
    assert.equal(parsed.detail.messages[0].reasoning[0].children[0].type, 'strong');
    assert.equal(parsed.detail.assets.length, 1);
    const literal: DomainConversationWithDetail = { index: { key: fixtureKey(String(metadata.id), 'custom'),   titleSource: "derived",  title: metadata.title,  }, detail: { key: fixtureKey(String(metadata.id), 'custom'), quality: { status: 'unknown' }, assets: [], messages: [{
        role: 'assistant', content: text('Body'), reasoning: text('**literal** <b>HTML</b> ![image](url) $x$'),
    }] } };
    const original = structuredClone(literal);
    const result = await composeFixture(literal);
    const [thought] = result.document.messages[0].blocks;
    assert.ok(thought.type === 'disclosure');
    assert.deepEqual(thought.blocks, literal.detail.messages[0].reasoning);
    assert.equal(collectDocumentResources(result.document).referencedIds.size, 0);
    assert.deepEqual(literal, original);
});

for (const providerId of ['openai', 'anthropic', 'custom-provider']) {
    test(`Composer trusts Domain provider ${providerId} for conversation and diagnostics`, async () => {
        const domain = historicalFixtureDomain({ ...metadata, source: 'openai-import', messages: [{ role: 'assistant', content: '![missing](missing.png)' }] }, { providerId });
        assert.equal(fixtureAccountFor(domain).providerId, providerId);
        const result = await composeFixture(domain);
        assert.equal(result.document.metadata.provider, providerId);
        const parsed = historicalFixture({ ...metadata, messages: [{ role: 'tool', content: 42 }] }, { providerId });
        assert.equal(fixtureAccountFor(parsed.conversation).providerId, providerId);
        assert.ok(parsed.diagnostics.some(d => d.code === 'UNKNOWN_ROLE'));
        assert.ok(parsed.diagnostics.some(d => d.code === 'UNKNOWN_MESSAGE_CONTENT'));
    });
}

test('provider identity is assigned only by producers, with OpenAI and Takeout correctly distinguished', () => {
    assert.equal(fixtureAccountFor(historicalFixtureDomain({ ...metadata, source: 'openai-import' })).providerId, 'openai');
    assert.equal(fixtureAccountFor(historicalFixtureDomain({ ...metadata, source: 'takeout' })).providerId, 'gemini');
    assert.throws(() => historicalFixtureDomain(metadata, { providerId: '' }), /providerId/);
});

test('Domain closure rejects invalid provider, repeated registry/message IDs and dangling references', async () => {
    const domain: DomainConversationWithDetail = { index: { key: fixtureKey(String(metadata.id), 'custom'),   titleSource: "derived",  title: metadata.title,  }, detail: { key: fixtureKey(String(metadata.id), 'custom'), quality: { status: 'unknown' }, assets: [{ id: 'asset', kind: 'file' }], messages: [{ role: 'assistant', content: [], attachmentIds: ['asset'] }] } };
    assertDomainClosure((domain).detail);
    const invalid: DomainConversationWithDetail[] = [
        { index: { ...domain.index, key: { ...domain.index.key, accountId: 'invalid' } }, detail: { ...domain.detail } },
        { index: { ...domain.index }, detail: {   ...domain.detail, assets: [domain.detail.assets[0], { ...domain.detail.assets[0] }] } },
        { index: { ...domain.index }, detail: {   ...domain.detail, messages: [{ ...domain.detail.messages[0], attachmentIds: ['asset', 'asset'] }] } },
        { index: { ...domain.index }, detail: {   ...domain.detail, messages: [{ ...domain.detail.messages[0], attachmentIds: ['unknown'] }] } },
        { index: { ...domain.index }, detail: {   ...domain.detail, messages: [{ role: 'assistant', content: [{ type: 'image', assetId: 'unknown' }] }] } },
        { index: { ...domain.index }, detail: {   ...domain.detail, messages: [{ role: 'assistant', content: [], reasoning: [{ type: 'file', assetId: 'unknown' }] }] } },
        { index: { ...domain.index }, detail: {   ...domain.detail, messages: [{ role: 'assistant', content: [], reasoning: 'raw string' as never }] } },
    ];
    for (const input of invalid) {
        assert.throws(() => validateParserDomain(input as never), TypeError);
        await assert.rejects(composeFixture(input), TypeError);
    }
});

test('Domain consumers never parse provider syntax or reconcile acquisition aliases', () => {
    for (const file of ['src/l2/closure.ts', 'src/l3b/compose/composeDomainDocument.ts',
        'src/l3b/compose/composeContent.ts']) {
        const source = readFileSync(join(__dirname, '..', file), 'utf8');
        assert.doesNotMatch(source, /parseGemini|parseImported|parseSourceReasoning|preprocessGemini|convertHtmlToMarkdown|structuredBodyAttachments|resolveSourceAttachment/);
        assert.doesNotMatch(source, /from\s+['"][^'"]*(?:provider\/|api\/parser)[^'"]*['"]/);
    }
    const domain = historicalFixtureDomain({ ...metadata, messages: [{ role: 'assistant', content: '', attachments: [{
        type: 'image', subDir: 'export-destination', localName: 'source.png', isGenerated: true,
    }] }] });
    assert.deepEqual(Object.keys(domain.detail.assets[0]).sort(), ['id', 'kind']);
    assert.equal(domain.detail.assets[0].sourceUri, undefined);
    assert.equal('attachments' in domain.detail.messages[0], false);
});

test('existing raw corpus preserves Domain, AST and all backend outputs across JSON round trips', async () => {
    const fixtureDir = join(__dirname, 'fixtures/provider');
    const inputs: Conversation[] = [];
    for (const file of ['conversation-sample.json', 'conversation-turns.json']) {
        const input: Conversation = JSON.parse(readFileSync(join(fixtureDir, file), 'utf8'));
        // The Domain producer rejects malformed raw message bodies; compatibility fallback has its own tests.
        if (input.messages) input.messages = input.messages.filter(message => typeof message.content === 'string');
        inputs.push(input);
    }
    for (const file of readdirSync(join(fixtureDir, 'structured_rpc'))) {
        const structure: { children?: unknown[] } = JSON.parse(readFileSync(join(fixtureDir, 'structured_rpc', file), 'utf8'));
        if (structure.children) inputs.push({ ...metadata, id: file, messages: [{ id: 'm', role: 'model', content: 'Markdown fallback', structuredContent: structure }] });
    }
    const corpus: { corpusSets: Record<string, { documents?: Array<{ id: string; content?: string; markdown?: string; text?: string }> }> } =
        JSON.parse(readFileSync(join(__dirname, 'fixtures/parser_migration_corpus.json'), 'utf8'));
    for (const group of Object.values(corpus.corpusSets)) {
        for (const document of group.documents ?? []) {
            const content = document.content || document.markdown || document.text;
            if (typeof content === 'string') inputs.push({ ...metadata, id: document.id, messages: [{ id: 'm', role: 'model', content }] });
        }
    }
    assert.ok(inputs.length > 100);
    for (const input of inputs) {
        const original = structuredClone(input);
        const { conversation: domain, resourceHints, acquisitionHints } = historicalFixture(input);
        const semantic = await composeFixture(domain, resourceHints);
        const restored = await composeFixture(JSON.parse(JSON.stringify(domain)), resourceHints);
        const parsed = historicalFixture(input, { providerId: 'gemini' });
        const direct = await composeFixture(parsed.conversation, parsed.resourceHints);
        assert.deepEqual(domain, parsed.conversation, input.id);
        assert.deepEqual(direct.document, semantic.document, input.id);
        assert.deepEqual(restored, semantic, input.id);
        assert.deepEqual(renderDocumentHtml(semantic.document, semantic.resources), renderDocumentHtml(restored.document, restored.resources), input.id);
        assert.equal(renderDocumentMarkdown(semantic.document, semantic.resources), renderDocumentMarkdown(restored.document, restored.resources), input.id);
        assert.deepEqual(renderDocumentTypst(semantic.document, semantic.resources), renderDocumentTypst(restored.document, restored.resources), input.id);
        assert.deepEqual(input, original, input.id);
    }
});
