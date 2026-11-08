import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixtureAccount } from './helpers/domainFixture.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
import { renderTypstFixture } from './helpers/renderTypstFixture.js';
import { unavailableResourceText } from '../src/l4/format/shared/backendPresentation.js';

const account = Object.freeze({ ...fixtureAccount('chatgpt'), email: 'private@example.test', displayName: 'Private name' });
function input(): DomainConversationWithDetail {
    const key = { accountId: account.id, conversationId: 'same-native-id' };
    return { index: { key, title: 'Index title', titleSource: 'provider', createdAt: 1000, updatedAt: 2000 },
        detail: { key: { ...key }, savedAt: 9999999999999, quality: { status: 'partial' }, assets: [], messages: [
            { id: 'provider-z', role: 'assistant', model: 'Source model', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'First body' }] }] },
            { id: 'provider-a', role: 'user', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Second body' }] }] },
        ] } };
}

// Existing renderer/export coverage, separated from AST unit tests.
test('integration: exported metadata and message order', async () => {
    const domain = validateParserDomain(input());
    const markdown = renderDocumentMarkdown(composeDomainDocument(domain, account), {});
    assert.ok(markdown.includes('provider: "chatgpt"'));
    assert.ok(markdown.indexOf('First body') < markdown.indexOf('Second body'));
    assert.ok((renderDocumentHtml(composeDomainDocument(domain, account), {}).html).includes('Index title'));
    const document = composeDomainDocument(domain, account);
    const otherAccount = fixtureAccount('chatgpt', '20000000-0000-4000-8000-000000000001');
    const other = input(); other.index.key.accountId = otherAccount.id; other.detail.key.accountId = otherAccount.id;
    other.detail.messages[0].content = [{ type: 'paragraph', children: [{ type: 'text', text: 'Other account body' }] }];
    const otherDocument = composeDomainDocument(validateParserDomain(other), otherAccount);
    assert.ok(renderDocumentMarkdown(otherDocument, {}).includes('Other account body'));
    assert.ok(!renderDocumentMarkdown(document, {}).includes('Other account body'));
});

test('integration: renderers preserve Composer citation numbers', () => {
    const raw = input();
    raw.detail.messages = [0, 1].map(() => ({ role: 'assistant', citations: [{ id: 'same' }, { id: 'named', title: 'Article', url: 'https://example.test/article' }],
        reasoning: [{ type: 'paragraph', children: [{ type: 'citationRef', citationId: 'same', label: '[99]' }] }],
        content: [{ type: 'paragraph', children: [{ type: 'citationRef', citationId: 'named', label: 'Read this' }, { type: 'citationRef', citationId: 'same' }] }],
    }));
    const document = composeDomainDocument(validateParserDomain(raw), account);
    const markdown = renderDocumentMarkdown(document, {});
    assert.ok(markdown.includes('> [4] [Article](https://example.test/article)'));
    assert.ok(markdown.includes('Read this'));
    assert.ok(markdown.split('\n').includes('> [3]'), 'untitled offline source has one plain display number');
    assert.ok(!markdown.includes('[3] \\[3\\]'), 'untitled source number appears once');
    const html = renderDocumentHtml(document, {}, { locale: 'en' }).html;
    assert.ok(html.includes('>[4] Article</a>'));
    assert.ok(html.includes('gem-citation-chip">[3]</span>'));
    const pdf = renderDocumentTypst(document, {});
    const footer = pdf.messages[1].blocks.at(-1);
    assert.ok(footer?.type === 'note');
    assert.equal(footer.label, 'Sources');
    assert.deepEqual(footer.children, [{ type: 'text', text: '[3]' }, { type: 'lineBreak' },
        { type: 'link', url: 'https://example.test/article', children: [{ type: 'text', text: '[4] Article' }] }]);
});

test('integration: renderers express unavailable media', () => {
    const raw = input();
    raw.detail.assets = [{ id: 'photo', kind: 'image', name: 'Diagram.png' }, { id: 'file', kind: 'file', name: 'Report.pdf' }, { id: 'unowned', kind: 'image' }];
    raw.detail.messages = [
        { role: 'assistant', content: [] },
        { role: 'user', content: [{ type: 'paragraph', children: [{ type: 'image', assetId: 'photo' }] }], attachmentIds: ['photo', 'file'] },
    ];
    const document = composeDomainDocument(validateParserDomain(raw), account);
    for (const locale of ['en', 'zh'] as const) {
        const text = unavailableResourceText('image', 'Diagram.png', locale);
        assert.ok(renderDocumentHtml(document, {}, { locale }).html.includes(text));
        assert.ok(renderDocumentMarkdown(document, {}, { locale }).includes(text));
        assert.ok(JSON.stringify(renderDocumentTypst(document, {}, { locale })).includes(text));
    }
    const { payload: pdf, diagnostics } = renderTypstFixture(document, { photo: 'assets/photo.png' });
    assert.ok(pdf.messages[1].blocks.some(block => block.type === 'file'), 'PDF file card does not imply download failure');
    assert.deepEqual(diagnostics, []);

});

test('integration: renderer format defaults are fixed and do not bypass the AST', () => {
    const raw = input();
    raw.detail.messages[0].reasoning = [{ type: 'code', code: 'thought', language: 'text' }];
    raw.detail.messages[0].content = [{ type: 'code', code: 'answer', language: 'js', meta: 'Authored filename' }];
    const document = composeDomainDocument(validateParserDomain(raw), account);
    const html = renderDocumentHtml(document, {}).html;
    assert.ok(html.includes('<div class="gem-code-header">'), 'HTML always has code headers');
    assert.ok(html.includes('copyCode(this)'), 'HTML keeps its fixed copy control');
    assert.ok(html.includes('<details class="gem-thoughts">'), 'HTML disclosures default to collapsed');
    const markdown = renderDocumentMarkdown(document, {});
    assert.ok(markdown.includes('<details>') && markdown.includes('```js\nanswer'));
    assert.ok(markdown.includes('Authored filename'), 'authored code metadata remains readable');
    const pdf = renderDocumentTypst(document, {});
    const code = pdf.messages[0].blocks.find(block => block.type === 'code');
    assert.ok(code && code.type === 'code' && code.header.includes('Authored filename'));
    assert.equal(renderDocumentHtml(document, {}, { locale: 'zh' }).html.includes('Authored filename'), true);
});
