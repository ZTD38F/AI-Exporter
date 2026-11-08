/**
 * The provider model label is a DomainMessage fact. L3b carries that fact
 * once to every L4 projection; none of the formats must reparse source HTML
 * or reconstruct the retired ChatFormatter legacy message model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { readConversation } from '../src/l2/readConversation.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
import { serializeDomainJson } from '../src/l4/format/json/serializeDomainJson.js';

useIndexStorage();
const account = fixtureAccount('gemini');
const paragraph = (text: string) => ({ type: 'paragraph' as const, children: [{ type: 'text' as const, text }] });

test('native provider model names survive L2 -> L3b and Markdown, HTML, Typst/PDF payloads', async () => {
    const key = { accountId: account.id, conversationId: 'production-model' };
    await ingestDetail(key.accountId, key.conversationId, {
        savedAt: 100, quality: { status: 'complete' }, assets: [],
        messages: [
            { role: 'user', content: [paragraph('Question')] },
            { role: 'assistant', model: 'Gemini 2.5 Pro', content: [paragraph('Answer')] },
        ],
    }, { title: 'Model fidelity', titleSource: 'provider', updatedAt: 100 });
    const conversation = await readConversation(key);
    assert.ok(conversation);
    const before = structuredClone(conversation);
    const document = composeDomainDocument(conversation, account);
    assert.equal(document.messages[1].modelLabel, 'Gemini 2.5 Pro');
    assert.match(renderDocumentMarkdown(document, {}), /Gemini 2\.5 Pro/);
    const html = renderDocumentHtml(document, {}).html;
    assert.match(html, /gem-model-label/);
    assert.match(html, /Gemini 2\.5 Pro/);
    const typst = renderDocumentTypst(document, {});
    assert.equal(typst.messages[1].model, 'Gemini 2.5 Pro');
    const archive = JSON.parse(serializeDomainJson(conversation, account, {}));
    assert.equal(archive.conversation.detail.messages[1].model, 'Gemini 2.5 Pro');
    assert.deepEqual(conversation, before, 'presentation cannot mutate captured provider facts');
});

test('different authored models remain attached to their own messages in every v2 renderer', async () => {
    const key = { accountId: account.id, conversationId: 'multiple-models' };
    await ingestDetail(key.accountId, key.conversationId, {
        savedAt: 200, quality: { status: 'complete' }, assets: [],
        messages: [
            { role: 'assistant', model: 'Gemini Flash', content: [paragraph('Fast answer')] },
            { role: 'assistant', model: 'Gemini Pro', content: [paragraph('Detailed answer')] },
            { role: 'assistant', content: [paragraph('Unknown model response')] },
        ],
    }, { title: 'Two models', titleSource: 'provider', updatedAt: 200 });
    const conversation = await readConversation(key);
    assert.ok(conversation);
    const document = composeDomainDocument(conversation, account);
    assert.deepEqual(document.messages.map(message => message.modelLabel),
        ['Gemini Flash', 'Gemini Pro', undefined]);
    assert.deepEqual(renderDocumentTypst(document, {}).messages.map(message => message.model),
        ['Gemini Flash', 'Gemini Pro', undefined]);
    const markdown = renderDocumentMarkdown(document, {});
    for (const text of ['Gemini Flash', 'Gemini Pro', 'Fast answer', 'Detailed answer', 'Unknown model response']) {
        assert.ok(markdown.includes(text));
    }
    const html = renderDocumentHtml(document, {}).html;
    assert.match(html, /Gemini Flash/);
    assert.match(html, /Gemini Pro/);
});
