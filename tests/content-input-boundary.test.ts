import { decodeGeminiStructuredPayload as decodeBody } from '../src/l1/parsers/gemini/rpc/structuredContent.js';
import { fixtureKey } from './helpers/domainFixture.js';
import { historicalFixture, historicalFixtureDomain } from './helpers/nativeFixture.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';
import { messageAssets } from './helpers/domainAssets.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BlockNode } from '../src/l2/content/blocks.js';
import { mapContentAssetReferences } from '../src/l2/content/assetReferences.js';
import { parseMarkdownToBlocks } from '../src/l1/parsers/shared/markdown/index.js';
import { parseGeminiBody } from '../src/l1/parsers/gemini/shared/contentAdapter.js';
import { composeFixture } from './helpers/documentFixture.js';
import type { HistoricalConversation as Conversation } from './helpers/historicalConversation.js';

const paragraph = (text: string): BlockNode[] => [{ type: 'paragraph', children: [{ type: 'text', text }] }];
const metadata = { id: 'content-input', title: 'Content boundary', timestamp: null };

test('Gemini chooses provider structure before Domain and does not reinterpret structured text as Markdown', () => {
    const domain = historicalFixtureDomain({ ...metadata, messages: [{
        role: 'model', content: 'raw **fallback**',
        structuredContent: { children: [{ nodeType: 18, text: '**literal structure**' }] },
    }] });
    assert.deepEqual(domain.detail.messages[0].content, paragraph('**literal structure**'));
});

for (const structured of [
    { children: [{ nodeType: 99, text: 'unsupported' }] },
    { children: [{ nodeType: 20, items: [{ children: [{ nodeType: 99 }] }] }] },
    { children: [{ nodeType: 18, text: 'bad', annotations: [null] }] },
    { children: [{ nodeType: 18, text: 'bad', annotations: { length: 1 } }] },
    { children: [{ nodeType: 18, text: 'bad', annotations: [{ start: 0, end: 100, type: 0 }] }] },
    { children: [{ nodeType: 17, rows: [{ cells: null }] }] },
    { children: [] },
]) {
    test(`malformed or unsupported structured input preserves its full Markdown fallback: ${JSON.stringify(structured)}`, () => {
        assert.deepEqual(parseGeminiBody('# Visible\n\n**answer**', decodeBody(structured) ?? undefined), [
            { type: 'heading', level: 1, children: [{ type: 'text', text: 'Visible' }] },
            { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', text: 'answer' }] }] },
        ]);
    });
}

test('generic Markdown parses images through the caller-provided asset resolver', () => {
    const ctx = { diagnostics: [], sourceRef: { providerId: 'other', locator: 'content' },
        resolveImage: (ref: string, alt: string) => ({ type: 'image' as const, assetId: `resolved:${ref}`, alt }),
    };
    assert.deepEqual(parseMarkdownToBlocks('![diagram](image.png)', '', ctx), [{
        type: 'paragraph', children: [{ type: 'image', assetId: 'resolved:image.png', alt: 'diagram' }],
    }]);
});

for (const [content, expectedVisible] of [
    ['![local](assets/image.png)\n\n> ![linked](https://example.test/image.png)', 'local'],
    ['![data](data:image/png;base64,AQID)\n\n![missing](unknown.png)', 'data'],
    ['<h2>Takeout title</h2><p>中文 <strong>answer</strong></p><ul><li>one</li><li>two</li></ul>', 'Takeout title'],
    ['# Title\n\n1. **first**\n2. second\n\n> [source](https://example.test) [1]\n\n```ts\nconst x = 1;\n```\n\n$$x^2$$\n\n|a|b|\n|---|---|\n|1|2|', 'Title'],
]) {
    test(`legacy content survives Document composition and serialization: ${content.slice(0, 35)}`, async () => {
        const legacy: Conversation = { ...metadata, messages: [{ role: 'assistant', content,
            attachments: [{ type: 'image', localName: 'assets/image.png', url: 'https://example.test/image.png' }],
            citations: [{ url: 'https://example.test/source', title: 'Source' }], thoughts: 'Reasoning **detail**',
        }] };
        const { conversation: domain, resourceHints } = historicalFixture(legacy);
        const before = structuredClone(domain);
        const semantic = await composeFixture(domain, resourceHints);
        assert.equal(semantic.document.messages.length, 1);
        assert.ok(semantic.document.messages[0].blocks.length > 0, 'visible input must produce display blocks');
        assert.ok(JSON.stringify(semantic.document.messages[0].blocks).includes(expectedVisible),
            `source evidence "${expectedVisible}" must survive native parsing and composition`);
        assert.deepEqual(domain, before, 'asset/citation reconciliation must not mutate Domain');
        assert.deepEqual((await composeFixture(structuredClone(domain), resourceHints)).document, semantic.document,
            'serialized Domain must retain the same semantic document');
    });
}

test('semantic asset binding visits nested captions, descriptions and cells while retaining unchanged nodes', () => {
    const blocks: BlockNode[] = [{ type: 'list', ordered: true, items: [{ blocks: [{
        type: 'table', caption: [{ type: 'image', assetId: 'caption' }],
        rows: [{ cells: [{ children: [{ type: 'link', href: 'https://example.test', children: [{ type: 'image', assetId: 'cell' }] }] }] }],
    }, { type: 'image', assetId: 'block', caption: [{ type: 'image', assetId: 'image-caption' }] },
    { type: 'file', assetId: 'file', description: [{ type: 'image', assetId: 'description' }] }] }] }];
    assert.equal(mapContentAssetReferences(blocks, ref => ref), blocks);
    const original = structuredClone(blocks);
    const seen: string[] = [];
    const mapped = mapContentAssetReferences(blocks, ref => { seen.push(ref); return `bound:${ref}`; });
    assert.deepEqual(new Set(seen), new Set(['caption', 'cell', 'block', 'image-caption', 'file', 'description']));
    assert.deepEqual(blocks, original);
    assert.notEqual(mapped, blocks);
});

test('Domain body is structured-only, including empty bodies, without raw provider fields', () => {
    const domain = historicalFixtureDomain({ ...metadata, messages: [
        { role: 'assistant', content: '', structuredContent: { children: [] } },
        { role: 'user', content: 'Question' },
    ] });
    assert.deepEqual(domain.detail.messages.map(message => message.content), [[], paragraph('Question')]);
    for (const message of domain.detail.messages) {
        assert.equal('structuredContent' in message, false);
        assert.equal('contentAst' in message, false);
    }
});

test('existing OpenAI imports parse generic Markdown and Takeout imports interpret HTML before Domain', () => {
    const openai = historicalFixtureDomain({ ...metadata, source: 'openai-import', messages: [{
        role: 'assistant', content: '# Imported\n\n**answer**',
    }] });
    assert.deepEqual(openai.detail.messages[0].content, [
        { type: 'heading', level: 1, children: [{ type: 'text', text: 'Imported' }] },
        { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', text: 'answer' }] }] },
    ]);
    const takeout = historicalFixtureDomain({ ...metadata, source: 'takeout', turns: [{
        modelContent: '<h2>Imported</h2><p>中文 <strong>answer</strong></p>',
    }] });
    assert.deepEqual(takeout.detail.messages[0].content, [
        { type: 'heading', level: 2, children: [{ type: 'text', text: 'Imported' }] },
        { type: 'paragraph', children: [{ type: 'text', text: '中文 ' }, { type: 'strong', children: [{ type: 'text', text: 'answer' }] }] },
    ]);
});

test('source gate rejects leaked provider syntax while trusted AST retains literal semantics', async () => {
    const message = { role: 'assistant' as const, content: paragraph('**literal** [1]'),
        reasoning: paragraph('Reasoning'), citations: [{ id: 'citation-0', url: 'https://example.test/source' }],
    };
    const expected = await composeFixture({ index: { key: fixtureKey(String(metadata.id), 'gemini'),   titleSource: "derived",  title: metadata.title,  }, detail: { key: fixtureKey(String(metadata.id), 'gemini'), quality: { status: 'unknown' }, assets: [], messages: [message] } });
    const leaked = { ...message, structuredContent: { children: [{ nodeType: 18, text: 'wrong raw body' }] },
        thoughts: 'wrong reasoning', sources: ['https://wrong.example.test'],
    };
    await assert.rejects(composeFixture({ index: { key: fixtureKey(String(metadata.id), 'gemini'),   titleSource: "derived",  title: metadata.title,  }, detail: { key: fixtureKey(String(metadata.id), 'gemini'), quality: { status: 'unknown' }, assets: [], messages: [leaked] } }), /Invalid persisted Domain contract: messages/);
    const body = expected.document.messages[0].blocks.find(block => block.type === 'paragraph');
    assert.ok(body?.type === 'paragraph' && body.children.some(node => node.type === 'text' && node.text.includes('**literal**')));
});

for (const document of [
    { id: 'document', type: 'file', fileName: 'report.txt', localName: 'files/report.txt', sections: ['section'] },
    { type: 'file', fileName: 'inline-report.txt', contentMarkdown: '# Report', sections: ['section'] },
    { type: 'file', fileName: 'missing-report.txt', sections: ['section'] },
]) {
    test(`structured-only search images retain document/asset ordering and metadata: ${document.fileName}`, async () => {
        const structuredContent = JSON.parse(readFileSync(join(__dirname, 'fixtures/provider/structured_rpc/b-stack-structured.json'), 'utf8'));
        const legacy: Conversation = { ...metadata, messages: [{
            id: 'message', role: 'model', content: 'fallback', structuredContent, documents: [document],
        }] };
        const original = structuredClone(legacy);
        const { conversation: domain, resourceHints } = historicalFixture(legacy);
        assert.equal('structuredContent' in domain.detail.messages[0], false);
        assert.deepEqual(messageAssets(domain, 0)?.[0].document?.contentMarkdown, document.contentMarkdown ? `${document.contentMarkdown}\n\nsection` : 'section');
        const semantic = await composeFixture(domain, resourceHints);
        assert.ok(semantic.document.messages[0].blocks.length > 0, 'structured source must produce document content');
        assert.equal(collectDocumentResources(semantic.document).imageIds.size, 1,
            'the structured source image must survive document composition');
        assert.deepEqual((await composeFixture(JSON.parse(JSON.stringify(domain)), resourceHints)).document, semantic.document,
            'persisted Domain must preserve the document and its resource references');
        assert.deepEqual(domain.detail.assets.map(asset => asset.name), [document.fileName, '贝尔测试实验示意图.png']);
        assert.deepEqual(legacy, original);
    });
}
