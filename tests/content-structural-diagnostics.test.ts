import { fixtureKey, fixtureAccountFor } from './helpers/domainFixture.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDomainClosure } from '../src/l2/closure.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderTypstFixture } from './helpers/renderTypstFixture.js';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
test('nested resource references are checked before composition; unavailable bytes are backend diagnostics', () => {
    const domain: DomainConversationWithDetail = { index: { key: fixtureKey(String('conversation'), 'test'),   titleSource: "derived",   title: 'Nested' }, detail: { key: fixtureKey(String('conversation'), 'test'), quality: { status: 'unknown' }, assets: [], messages: [{ id: 'message', role: 'assistant', content: [{ type: 'list', ordered: false, items: [{ blocks: [{ type: 'quote', blocks: [{ type: 'image', assetId: 'missing', alt: 'Nested figure' }] }] }] }] }] } };
    assert.throws(() => assertDomainClosure((domain).detail), /Unregistered Domain asset 'missing' in messages\[0\]/);
    domain.detail.assets.push({ id: 'missing', kind: 'image' });
    const document = composeDomainDocument(validateParserDomain(domain), fixtureAccountFor(validateParserDomain(domain)));
    const html = renderDocumentHtml(document, {});
    assert.equal(html.diagnostics.filter(d => d.code === 'HTML_ASSET_UNRESOLVED').length, 1);
    assert.ok(html.html.includes('Nested figure'));
    const { payload: pdf, diagnostics } = renderTypstFixture(document);
    assert.equal(diagnostics.filter(d => d.code === 'TYPST_V8_IMAGE_MISSING').length, 1);
    const list = pdf.messages[0]?.blocks[0];
    assert.ok(list && list.type === 'list', 'nested content must remain a list');
    const quote = list.items[0]?.blocks[0];
    assert.ok(quote && quote.type === 'quote', 'the list must retain its quote');
    const placeholder = quote.blocks[0];
    assert.ok(placeholder && placeholder.type === 'unknown', 'unavailable nested image must stay visible');
    assert.equal(placeholder.sourceType, 'missing-image');
    assert.ok(
        placeholder.fallback === 'Nested figure'
            || placeholder.details?.some(node => node.type === 'text' && node.text === 'Nested figure'),
        'nested missing image must preserve its label in either fallback or caption details'
    );
});
