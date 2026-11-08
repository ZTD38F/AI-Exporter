/**
 * V2 trust boundary: L2 owns Domain facts, L3b composes the single reading AST,
 * and L4 renders that AST (or archives the original Domain for JSON).
 * No v1 ChatFormatter, PDF request adapter, or parallel metadata DTO exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DomainConversation, DomainConversationWithDetail } from '../src/l2/conversation.js';
import { validateParserDomain, restoreDomainSnapshot } from '../src/l2/runtimeValidation.js';
import { fixtureAccount, fixtureAccountFor, fixtureKey } from './helpers/domainFixture.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
import { serializeDomainJson } from '../src/l4/format/json/serializeDomainJson.js';

/** Compile-time boundary checks; never invoked at runtime. */
function v2FormatTypeBoundaries(indexOnly: DomainConversation, raw: DomainConversationWithDetail): void {
    const account = fixtureAccount('independent');
    // @ts-expect-error L3b requires a Domain with Detail, not an Index-only view.
    composeDomainDocument(indexOnly, account);
    // @ts-expect-error L4 JSON also requires a complete Domain view.
    serializeDomainJson(indexOnly, account, {});
    // @ts-expect-error Markdown consumes a DocumentAst, not a raw L2 Domain.
    renderDocumentMarkdown(raw, {});
    // @ts-expect-error HTML consumes a DocumentAst, not a raw L2 Domain.
    renderDocumentHtml(raw, {});
    // @ts-expect-error Typst/PDF consumes a DocumentAst, not a raw L2 Domain.
    renderDocumentTypst(raw, {});
    // @ts-expect-error Request metadata cannot impersonate the L2 Domain archive input.
    serializeDomainJson({ id: 'request-metadata', conversation: raw }, account, {});
}
void v2FormatTypeBoundaries;

test('request metadata cannot impersonate Domain; v2 composition requires matching Account and keys', () => {
    const key = fixtureKey('pdf-source', 'independent');
    const raw: DomainConversationWithDetail = {
        index: { key, titleSource: 'derived', title: 'Title' },
        detail: {
            key, quality: { status: 'unknown' }, assets: [],
            messages: [{ role: 'assistant', content: [{ type: 'paragraph', children: [
                { type: 'text', text: 'Independent body' },
            ] }] }],
        },
    };
    assert.throws(
        () => restoreDomainSnapshot({ id: 'pdf-source', conversation: raw }),
        /Invalid Domain conversation/,
        'metadata wrappers are not L2 snapshots',
    );

    const trusted = validateParserDomain(raw);
    const account = fixtureAccountFor(trusted);
    const document = composeDomainDocument(trusted, account);
    assert.equal(document.messages.length, 1);
    assert.equal(document.messages[0].role, 'assistant');
    assert.match(JSON.stringify(renderDocumentTypst(document, {})), /Independent body/);

    assert.throws(
        () => composeDomainDocument(trusted, fixtureAccount('gemini')),
        /Composition Account\/key mismatch/,
    );
    assert.throws(
        () => serializeDomainJson(trusted, fixtureAccount('gemini'), {}),
        /JSON Account\/key mismatch/,
    );
    const mismatchedKeys = { ...trusted, detail: { ...trusted.detail, key: fixtureKey('other-source', 'independent') } };
    assert.throws(
        () => composeDomainDocument(mismatchedKeys, account),
        /Composition Account\/key mismatch/,
    );
    assert.throws(
        () => serializeDomainJson(mismatchedKeys, account, {}),
        /JSON Account\/key mismatch/,
    );
});

test('one admitted Domain preserves messages, reasoning and source facts in HTML, Markdown, JSON and PDF projection', () => {
    const key = fixtureKey('exports', 'independent');
    const raw: DomainConversationWithDetail = {
        index: { key, titleSource: 'derived', title: '<Independent>', createdAt: 100, updatedAt: 200 },
        detail: {
            key, savedAt: 200, assets: [], quality: { status: 'partial' },
            messages: [
                { id: 'q', role: 'user', content: [{ type: 'paragraph', children: [
                    { type: 'text', text: 'Question <safe>' },
                ] }] },
                { id: 'a', role: 'assistant', reasoning: [{ type: 'paragraph', children: [
                    { type: 'text', text: 'Reasoning evidence' },
                ] }], content: [{ type: 'code', language: 'ts', code: 'const value = 2;' }] },
            ],
        },
    };
    const conversation = validateParserDomain(raw);
    const account = fixtureAccountFor(conversation);
    const before = structuredClone(conversation);
    const document = composeDomainDocument(conversation, account);

    const { html } = renderDocumentHtml(document, {});
    const markdown = renderDocumentMarkdown(document, {});
    const archive = JSON.parse(serializeDomainJson(conversation, account, {}));
    const pdf = renderDocumentTypst(document, {});

    assert.equal(document.title, '<Independent>');
    assert.equal(document.metadata.id, 'exports');
    assert.equal(document.metadata.provider, 'independent');
    assert.equal(document.metadata.createdAt, 100);
    assert.equal(document.metadata.updatedAt, 200);
    assert.deepEqual(document.messages.map(message => message.role), ['user', 'assistant']);
    assert.equal(document.messages[1].blocks[0].type, 'disclosure', 'reasoning belongs to the shared AST');
    assert.equal(document.messages[1].blocks[1].type, 'code');

    assert.match(html, /Question &lt;safe&gt;/, 'HTML escapes source content');
    assert.match(html, /Reasoning evidence/);
    assert.match(html, /const value = 2;/);
    assert.match(markdown, /Question &lt;safe&gt;/, 'Markdown escapes embedded HTML syntax');
    assert.match(markdown, /Reasoning evidence/);
    assert.match(markdown, /const value = 2;/);
    assert.equal(pdf.messages.length, 2);
    assert.match(JSON.stringify(pdf.messages), /Reasoning evidence/);
    assert.match(JSON.stringify(pdf.messages), /const value = 2;/);

    assert.equal(archive.format, 'gemini-exporter-domain');
    assert.equal(archive.version, 1);
    assert.equal(archive.account.id, account.id);
    assert.equal(archive.conversation.detail.quality.status, 'partial');
    assert.deepEqual(archive.conversation.detail.messages.map((message: { role: string }) => message.role), ['user', 'assistant']);
    assert.equal(archive.conversation.index.title, '<Independent>');
    assert.deepEqual(archive.conversation, conversation, 'JSON preserves trusted Domain rather than serializing the reading AST');
    assert.deepEqual(archive.resources, {});
    assert.deepEqual(conversation, before, 'renderers cannot mutate admitted Domain facts');
});
