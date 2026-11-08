import { fixtureAccountFor, fixtureKey } from './helpers/domainFixture.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { fixtureResourceResults } from './helpers/documentFixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
import { closeSourceCitations } from '../src/l1/parsers/shared/resources/domainCitationAdapter.js';
import { historicalFixtureDomain, historicalFixture } from './helpers/nativeFixture.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
const prepareDomainResources = async (results: Awaited<ReturnType<typeof fixtureResourceResults>>) => Object.fromEntries(results.map(result => [result.resourceId, result.value.path]));
async function exportDomainMarkdown(domain: Parameters<typeof composeDomainDocument>[0], account: Parameters<typeof composeDomainDocument>[1], options: { resourceResults?: Awaited<ReturnType<typeof fixtureResourceResults>>; exportedAt?: number; locale?: 'en' | 'zh' } = {}) {
    return renderDocumentMarkdown(composeDomainDocument(domain, account), await prepareDomainResources(options.resourceResults ?? []), options);
}
async function exportDomainHtml(domain: Parameters<typeof composeDomainDocument>[0], account: Parameters<typeof composeDomainDocument>[1], options: { resourceResults?: Awaited<ReturnType<typeof fixtureResourceResults>>; exportedAt?: number; locale?: 'en' | 'zh' } = {}) {
    return renderDocumentHtml(composeDomainDocument(domain, account), await prepareDomainResources(options.resourceResults ?? []), options).html;
}

const raw = {
    id: 'direct', title: 'Draft', titles: { rpc: 'Authoritative title' }, timestamp: 1700000000000,
    messages: [
        { id: 'u', role: 'user' as const, content: '![photo](assets/photo.png)',
            attachments: [{ type: 'image', url: 'https://example.test/photo.png', localName: 'assets/photo.png', name: 'photo.png', isGenerated: true,
                generation: { chatId: 'direct', generationOrdinal: 1, imageOrdinal: 0 } }],
            images: [{ type: 'image', url: 'https://example.test/photo.png', localName: 'assets/photo.png', name: 'photo.png' }] },
        { id: 'a', role: 'model' as const, content: 'Answer **[1]** and [cite:2]. `[1]` stays code.', thoughts: 'Reasoning [1]',
            citations: [{ url: 'https://example.test/source', title: 'Source' }], groundingCitationMarkers: ['[cite:2]'],
            documents: [{ type: 'doc', id: 'doc', title: 'report.pdf', localName: 'files/report.pdf', mimeType: 'application/pdf', size: 1234567,
                sections: ['Introduction'], contentMarkdown: '# Report' }] },
    ],
};

function freeze<T>(value: T): T {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}

test('raw -> Domain resolves citations and one resource registry without mutating input', () => {
    const snapshot = structuredClone(raw);
    const domain = historicalFixtureDomain(freeze(structuredClone(raw)));
    assert.deepEqual(raw, snapshot);
    assert.equal(domain.index.title, 'Authoritative title');
    assert.equal(domain.detail.assets.length, 2);
    assert.equal(Reflect.get(domain.detail.assets[0], 'generated'), undefined);
    assert.equal(domain.detail.assets[0].generation?.generationOrdinal, 1);
    assert.deepEqual(domain.detail.assets[1].document?.contentMarkdown, '# Report\n\nIntroduction');
    assert.equal('groundingCitationMarkers' in domain.detail.messages[1], false);
    assert.deepEqual(domain.detail.messages[1].citations, [
        { id: 'citation-0', title: 'Source', url: 'https://example.test/source' }, { id: 'grounding-2' },
    ]);
    const ast = composeDomainDocument(domain, fixtureAccountFor(domain));
    assert.equal(ast.messages[0].blocks.length, 2, 'explicit attachment placement follows the inline content');
    const answer = ast.messages[1].blocks[1];
    assert.equal(answer.type, 'paragraph');
    if (answer.type !== 'paragraph') throw Error('expected paragraph');
    assert.deepEqual(answer.children[1], { type: 'strong', children: [{ type: 'citation', id: 'citation-0', label: '[1]', href: 'https://example.test/source' }] });
    assert.ok(answer.children.some(node => node.type === 'citation' && node.label === '[2]' && !node.href));
    assert.ok(answer.children.some(node => node.type === 'inlineCode' && node.code === '[1]'));
    const file = ast.messages[1].blocks[2];
    assert.equal(file.type, 'file');
    if (file.type === 'file') { assert.equal(file.mediaType, 'application/pdf'); assert.equal(file.byteLength, 1234567); }
});

test('Domain JSON round-trip gives the same AST and HTML/Markdown, including resource identities', async () => {
    const domain = freeze(historicalFixtureDomain(structuredClone(raw)));
    const restored = JSON.parse(JSON.stringify(domain));
    assert.deepEqual(composeDomainDocument(domain, fixtureAccountFor(domain)), composeDomainDocument(restored, fixtureAccountFor(restored)));
    assert.deepEqual(await prepareDomainResources(await fixtureResourceResults(domain)), await prepareDomainResources(await fixtureResourceResults(restored)));
    const options = { exportedAt: Date.parse('2026-10-06T00:00:00Z'), locale: 'en' as const, resourceResults: await fixtureResourceResults(domain, historicalFixture(raw).resourceHints) };
    assert.equal(await exportDomainMarkdown(domain, fixtureAccountFor(domain), options), await exportDomainMarkdown(restored, fixtureAccountFor(restored), options));
    assert.equal(await exportDomainHtml(domain, fixtureAccountFor(domain), options), await exportDomainHtml(restored, fixtureAccountFor(restored), options));
});

test('AST: composer trusts literal Domain content and does not reinterpret Markdown or marker syntax', () => {
    const domain: DomainConversationWithDetail = { index: { key: fixtureKey(String('literal'), 'custom'),   titleSource: "derived",   title: 'Literal' }, detail: { key: fixtureKey(String('literal'), 'custom'), quality: { status: 'unknown' }, assets: [], messages: [
        { role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text: '**literal** [1] [cite:2] ![pic](url)' }] }],
            citations: [{ id: 'source', url: 'https://example.test' }] },
    ] } };
    const ast = composeDomainDocument(validateParserDomain(domain), fixtureAccountFor(validateParserDomain(domain)));
    assert.equal(ast.metadata.provider, 'custom');
    assert.ok(!('documentLanguage' in ast));
    assert.deepEqual(ast.messages[0].blocks, domain.detail.messages[0].content);
});

test('AST: reasoning and explicit attachments retain each source placement and dangling citations fail closed', () => {
    const domain: DomainConversationWithDetail = { index: { key: fixtureKey(String('placement'), 'custom'),    }, detail: { key: fixtureKey(String('placement'), 'custom'), quality: { status: 'unknown' }, assets: [{ id: 'shared', kind: 'image', name: 'diagram.png' }], messages: [
            { role: 'assistant', content: [], reasoning: [{ type: 'image', assetId: 'shared' }], attachmentIds: ['shared'] },
            { role: 'user', content: [], attachmentIds: ['shared'] },
        ] } };
    const ast = composeDomainDocument(validateParserDomain(domain), fixtureAccountFor(validateParserDomain(domain)));
    assert.equal(ast.messages[0].blocks.length, 2, 'explicit attachment remains after reasoning');
    assert.equal(ast.messages[1].blocks.length, 1);
    const broken = structuredClone(domain);
    broken.detail.messages[0].content = [{ type: 'paragraph', children: [{ type: 'citationRef', citationId: 'unknown' }] }];
    assert.throws(() => composeDomainDocument(validateParserDomain(broken), fixtureAccountFor(validateParserDomain(broken))), /Unregistered Domain citation/);
});

test('direct export dependency closure cannot load Canonical conversation normalization/composition', () => {
    // Traverse runtime relative imports: type-only legacy parser diagnostics do not add a representation.
    const visited = new Set<string>();
    const visit = (file: string): void => {
        if (visited.has(file)) return;
        visited.add(file);
        assert.ok(!/canonical\/(?:conversation|normaliz\w+|renderCanonical\w+|messageInput|assetInput)\.ts$/.test(file), file);
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(/(?:import|export)\s+(?!type\b)[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g)) {
            if (!match[1].startsWith('.')) continue;
            const dependency = path.resolve(path.dirname(file), match[1].replace(/\.js$/, '.ts'));
            if (fs.existsSync(dependency)) visit(dependency);
        }
    };
    visit(path.resolve(__dirname, '../src/l3b/compose/composeDomainDocument.ts'));
    visit(path.resolve(__dirname, '../src/l4/format/html/renderHtml.ts'));
    visit(path.resolve(__dirname, '../src/l4/format/markdown/renderMarkdown.ts'));
});

test('provider citation binding covers rich captions/descriptions and ignores code/math markers', () => {
    const bound = closeSourceCitations({ role: 'assistant', citations: [{ id: 'source', url: 'https://example.test/source' }], content: [
        { type: 'image', assetId: 'image', caption: [{ type: 'strong', children: [{ type: 'text', text: 'caption [1]' }] }] },
        { type: 'file', assetId: 'file', description: [{ type: 'text', text: 'description [1]' }] },
        { type: 'table', caption: [{ type: 'text', text: 'table [1]' }], rows: [] },
        { type: 'code', code: '[1]' }, { type: 'math', source: '[1]' },
    ] });
    const serialized = JSON.stringify(bound.content);
    assert.equal((serialized.match(/"citationRef"/g) ?? []).length, 3);
    assert.ok(serialized.includes('"citationId":"source"'));
    assert.deepEqual(bound.content.slice(3), [{ type: 'code', code: '[1]' }, { type: 'math', source: '[1]' }]);
});

test('prepared paths retain archive namespaces, hash inline bytes and omit failed/remote resources', async () => {
    const domain: DomainConversationWithDetail = { index: { key: fixtureKey(String('resources'), 'custom'),    }, detail: { key: fixtureKey(String('resources'), 'custom'), quality: { status: 'unknown' }, messages: [], assets: [
        { id: 'path', kind: 'file',  },
        { id: 'bytes', kind: 'image', mediaType: 'image/png' },
        { id: 'uri', kind: 'image' },
        { id: 'failed', kind: 'file' },
        { id: 'remote', kind: 'image', sourceUri: 'https://example.test/image.png' },
    ] } };
    const prepared = await prepareDomainResources(await fixtureResourceResults(freeze(domain), { path: { archivePath: 'files/report.pdf' }, failed: { unresolvedReference: 'files/missing.pdf' } }, { bytes: { dataBase64: 'AQID' }, uri: { url: 'data:image/png;base64,AQID' } }));
    assert.equal(prepared.path, 'files/report.pdf');
    assert.match(prepared.bytes, /^assets\/sha256\/\w{2}\/\w{2}\/\w{64}\.png$/);
    assert.equal(prepared.bytes, prepared.uri);
    assert.equal(prepared.failed, undefined);
    assert.equal(prepared.remote, undefined);
});


test('citation numbering is conversation-wide in body, reasoning and Sources, including references without URLs', async () => {
    const domain = validateParserDomain({ index: { key: fixtureKey(String('citations'), 'custom'),   titleSource: "derived",   title: 'Citations' }, detail: { key: fixtureKey(String('citations'), 'custom'), quality: { status: 'complete' }, assets: [], messages: [
        { id: 'first', role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'citationRef', citationId: 'same', label: '[17]' }] }], citations: [{ id: 'same', url: 'https://example.test/one', title: 'First source' }] },
        { id: 'second', role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'citationRef', citationId: 'same' }] }], reasoning: [{ type: 'paragraph', children: [{ type: 'citationRef', citationId: 'same', label: '[91]' }] }], citations: [{ id: 'same', title: 'Offline source' }] },
    ] } });
    const document = composeDomainDocument(domain, fixtureAccountFor(domain));
    const first = document.messages[0].blocks[0];
    assert.ok(first.type === 'paragraph');
    assert.deepEqual(first.children, [{ type: 'citation', id: 'same', label: '[17]', href: 'https://example.test/one' }]);
    const second = document.messages[1].blocks[1];
    assert.ok(second.type === 'paragraph');
    assert.deepEqual(second.children, [{ type: 'citation', id: 'same', label: '[2]' }]);
    const reasoning = document.messages[1].blocks[0];
    assert.ok(reasoning.type === 'disclosure');
    assert.deepEqual(reasoning.blocks, [{ type: 'paragraph', children: [{ type: 'citation', id: 'same', label: '[91]' }] }]);
    assert.equal(document.messages[0].sources?.[0].number, 1);
    assert.equal(document.messages[1].sources?.[0].number, 2);
    const markdown = await exportDomainMarkdown(domain, fixtureAccountFor(domain));
    assert.ok(markdown.includes('[2]'));
    assert.ok(markdown.includes('Offline source'));
});
