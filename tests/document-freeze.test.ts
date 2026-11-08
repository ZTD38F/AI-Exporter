import { fixtureKey, fixtureAccountFor } from './helpers/domainFixture.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { historicalFixture } from './helpers/nativeFixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
import type { DocumentAst, DisplayInline, DisplayBlock } from '../src/l3b/ast/ast.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { fileBadge } from '../src/l4/format/shared/backendPresentation.js';
import { renderMathHtml } from '../src/l4/format/html/htmlMath.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';

function domain(): DomainConversationWithDetail {
    return { index: { key: fixtureKey(String('freeze'), 'custom'),   titleSource: "derived",   title: 'Boundary' }, detail: { key: fixtureKey(String('freeze'), 'custom'), quality: { status: 'unknown' }, assets: [], messages: [
        { id: 'same unsafe / " identity', role: 'user', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Question '.repeat(40) }] }] },
        { id: 'answer', role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Answer' }] }] },
    ] } };
}
function freeze(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    Object.values(value).forEach(freeze); Object.freeze(value);
}

test('HTML owns DOM identities and does not derive document language from UI locale', () => {
    const document = composeDomainDocument(validateParserDomain(domain()), fixtureAccountFor(validateParserDomain(domain())));
    assert.ok(document.messages.every(message => !('anchor' in message) && !('modelLabel' in message)));
    for (const locale of ['en', 'zh'] as const) {
        const html = renderDocumentHtml(document, {}, { locale }).html;
        assert.match(html, /<html>/);
        assert.match(html, /id="turn-user-0"/);
        assert.match(html, /id="prompt-turn-user-0"/);
        assert.match(html, /id="turn-model-1"/);
    }
    assert.ok(!('documentLanguage' in document));
    assert.match(renderDocumentHtml(document, {}, { locale: 'zh' }).html, /<html>/);
});

test('file badges use only supplied media type or kind, including misleading labels', () => {
    const file: Extract<DisplayBlock, { type: 'file' }> = { type: 'file', resourceId: 'f', label: 'misleading.pdf', kind: 'file' };
    assert.equal(fileBadge(file), 'FILE');
    assert.equal(fileBadge({ ...file, label: 'renamed.exe', mediaType: 'application/x-zip' }), 'ZIP');
    const document = composeDomainDocument(validateParserDomain(domain()), fixtureAccountFor(validateParserDomain(domain())));
    document.messages[0].blocks = [file, { ...file, mediaType: 'text/plain' }];
    const html = renderDocumentHtml(document, { f: 'assets/f' }).html;
    assert.match(html, /gem-att-badge">FILE<\/span>/);
    assert.match(html, /gem-att-badge">TXT<\/span>/);
    const pdf = renderDocumentTypst(document, {});
    assert.deepEqual(pdf.messages[0].blocks.map(block => block.type === 'file' && block.kind), ['FILE', 'TXT']);
});

test('Composer preserves Unix-ms Index timestamps; only renderers format UTC dates', () => {
    const input = domain();
    input.index.createdAt = Date.parse('2026-10-04T00:00:00Z');
    input.index.updatedAt = Date.parse('2026-10-06T23:30:00-07:00');
    const accepted = validateParserDomain(input);
    const document = composeDomainDocument(accepted, fixtureAccountFor(accepted));
    assert.equal(document.metadata.createdAt, input.index.createdAt);
    assert.equal(document.metadata.updatedAt, input.index.updatedAt);
    assert.ok(!('header' in document));
    assert.ok(renderDocumentHtml(document, {}).html.includes('2026-10-07'));
    assert.ok(renderDocumentTypst(document, {}).metadata.includes('2026-10-07'));
    const withoutUpdate = validateParserDomain({ ...input, index: { ...input.index, updatedAt: undefined } });
    const created = composeDomainDocument(withoutUpdate, fixtureAccountFor(withoutUpdate));
    assert.equal(created.metadata.updatedAt, undefined);
    assert.ok(renderDocumentHtml(created, {}).html.includes('2026-10-04'));
    assert.ok(renderDocumentTypst(created, {}).metadata.includes('2026-10-04'));
    const noTimes = validateParserDomain({ ...input, index: { ...input.index, createdAt: undefined, updatedAt: undefined } });
    const missing = composeDomainDocument(noTimes, fixtureAccountFor(noTimes));
    assert.ok(!('createdAt' in missing.metadata) && !('updatedAt' in missing.metadata));
    assert.ok(!renderDocumentHtml(missing, {}).html.includes('1970-01-01'));
});

test('provider parsing retains model identity and normalizes source dates only at L1', () => {
    const source = { id: 'c', title: 'T', updatedAt: '2026-10-06T23:30:00-07:00', createdAt: '2026-10-04', messages: [{ id: 'a', role: 'model', author: { model: 'provider only' }, content: '' }] };
    const first = historicalFixture(source, { providerId: 'gemini' });
    const document = composeDomainDocument(first.conversation, fixtureAccountFor(first.conversation));
    assert.equal(document.metadata.updatedAt, Date.parse('2026-10-06T23:30:00-07:00'));
    assert.ok(renderDocumentHtml(document, {}).html.includes('2026-10-07'));
    source.updatedAt = 'invalid';
    const second = historicalFixture(source, { providerId: 'gemini' });
    const fallback = composeDomainDocument(second.conversation, fixtureAccountFor(second.conversation));
    assert.equal(fallback.metadata.updatedAt, undefined);
    assert.equal(fallback.metadata.createdAt, Date.parse('2026-10-04T00:00:00Z'));
    assert.equal(fallback.messages[0].modelLabel, 'provider only');
    assert.equal(renderDocumentTypst(fallback, {}).messages[0].model, 'provider only');
});

test('parser removes math delimiters; HTML renders source verbatim and preserves malformed source', () => {
    const parsed = historicalFixture({ id: 'math', messages: [{ role: 'model', content: '$x^2$\n\n$$\ny^2\n$$' }] }, { providerId: 'gemini' });
    const document = composeDomainDocument(parsed.conversation, fixtureAccountFor(parsed.conversation));
    assert.deepEqual(document.messages[0].blocks, [
        { type: 'paragraph', children: [{ type: 'inlineMath', source: 'x^2' }] }, { type: 'math', source: 'y^2' },
    ]);
    assert.equal(renderDocumentHtml(document, {}).diagnostics.length, 0);
    for (const source of ['$x^2$', '$$y^2$$', '  $z^2$  ']) {
        const result = renderMathHtml(source, true, 'Formula');
        assert.equal(result.diagnostic?.code, 'HTML_MATH_RENDER_FAILED');
        assert.ok(result.html.includes(`<code>${source}</code>`));
    }
});

test('PDF renders prepared AST images; one frozen rich JSON AST serves all backends', async () => {
    const input = domain();
    const inline = (id: string) => ({ type: 'image' as const, assetId: id, alt: id });
    const rendered = ['main', 'inline', 'heading', 'header', 'cell', 'nested'];
    const rich = ['image-caption', 'table-caption', 'description', 'body-ending', 'details'];
    input.detail.assets = [...rendered, ...rich].map(id => ({ id, kind: 'image', sourceUri: `https://example.test/${id}` }));
    input.detail.assets.push({ id: 'file', kind: 'file' });
    input.detail.messages[1].content = [
        { type: 'image', assetId: 'main', caption: [inline('image-caption')] },
        { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'link', href: '/', children: [inline('inline')] }] }] },
        { type: 'heading', level: 2, children: [inline('heading')] },
        { type: 'table', caption: [inline('table-caption')], headerRows: [{ cells: [{ children: [inline('header')] }] }], rows: [{ cells: [{ children: [inline('cell')] }] }] },
        { type: 'quote', blocks: [{ type: 'list', ordered: false, items: [{ blocks: [{ type: 'quote', blocks: [{ type: 'paragraph', children: [inline('nested')] }] }] }] }] },
        { type: 'file', assetId: 'file', description: [inline('description'), inline('inline')] },
    ];
    freeze(input);
    const document: DocumentAst = JSON.parse(JSON.stringify(composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input)))));
    const detail: DisplayInline = { type: 'image', resourceId: 'details', alt: 'details' };
    document.messages[1].blocks.push({ type: 'image', resourceId: 'details', alt: 'Details image', caption: [detail] });
    document.messages[1].blocks.push({ type: 'paragraph', children: [{ type: 'image', resourceId: 'body-ending', alt: 'body-ending' }] });
    freeze(document);
    const before = JSON.stringify(document);
    const imageIds = collectDocumentResources(document).imageIds;
    assert.deepEqual([...imageIds].sort(), [...rendered, ...rich].sort());
    assert.equal(collectDocumentResources(document).imageIds.size, rendered.length + rich.length);
    const bindings = Object.fromEntries([...collectDocumentResources(document).referencedIds].map(id => [id, `assets/${id}.png`]));
    assert.ok(renderDocumentHtml(document, bindings).html.includes('src="assets/image-caption.png"'));
    assert.ok(renderDocumentMarkdown(document, bindings).includes('assets/image-caption.png'));
    const pdf = renderDocumentTypst(document, Object.fromEntries([...imageIds].map(id => [id, bindings[id]])));
    assert.deepEqual(pdf.messages[1].blocks[0].type === 'image' && pdf.messages[1].blocks[0].caption, [{ type: 'image', asset: bindings['image-caption'], alt: 'image-caption' }]);
    assert.deepEqual(pdf.messages[1].blocks[3].type === 'table' && pdf.messages[1].blocks[3].caption, [{ type: 'image', asset: bindings['table-caption'], alt: 'table-caption' }]);
    assert.deepEqual(pdf.messages[1].blocks[5].type === 'file' && pdf.messages[1].blocks[5].description, ['description', 'inline'].map(id => ({ type: 'image', asset: bindings[id], alt: id })));
    assert.deepEqual(pdf.messages[1].blocks[6].type === 'image' && pdf.messages[1].blocks[6].caption, [{ type: 'image', asset: bindings.details, alt: 'details' }]);
    assert.ok(JSON.stringify(pdf.messages[1].blocks[7]).includes(bindings['body-ending']));
    assert.equal(JSON.stringify(document), before);
});
