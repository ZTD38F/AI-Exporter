import { fixtureKey, fixtureAccountFor } from './helpers/domainFixture.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { historicalFixture } from './helpers/nativeFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';

const metadata = { index: { key: fixtureKey(String('semantic'), 'other'),  title: 'Semantic input', titleSource: "derived" as const,    }, detail: { key: fixtureKey(String('semantic'), 'other'), quality: { status: 'unknown' } as const, assets: [] } };

test('AST: Document composition contains no body parsing or provider-format decisions', () => {
    for (const file of ['composeDomainDocument.ts', 'composeContent.ts']) {
        const source = readFileSync(join(__dirname, '../src/l3b/compose', file), 'utf8');
        assert.doesNotMatch(source, /parseMarkdown|parseGemini|preprocessGemini|structuredContent|geminiStructuredTo/);
        assert.doesNotMatch(source, /from\s+['"][^'"]*(?:api\/parser|provider\/gemini)[^'"]*['"]/);
    }
});

test('AST: Domain semantic nodes are composed without reparsing and raw Markdown-looking text remains literal', async () => {
    const domain: DomainConversationWithDetail = { index: { ...metadata.index }, detail: {   ...metadata.detail, messages: [{
        id: 'message', role: 'assistant', content: [
            { type: 'paragraph', children: [{ type: 'text', text: '**literal** $x$ ![not an image](file.png)' }] },
            { type: 'unknown', sourceType: 'semantic-extension', text: 'visible unknown' },
        ],
    }] } };
    const original = structuredClone(domain);
    const document = composeDomainDocument(validateParserDomain(domain), fixtureAccountFor(validateParserDomain(domain)));
    assert.deepEqual(document.messages[0].blocks[0], domain.detail.messages[0].content[0]);
    assert.deepEqual(document.messages[0].blocks[1], { type: 'unsupported', sourceType: 'semantic-extension', text: 'visible unknown' });
    assert.equal(collectDocumentResources(document).referencedIds.size, 0);
    assert.deepEqual(domain, original);
});

test('AST: separate reasoning presentation does not reinterpret the Domain body', async () => {
    const domain: DomainConversationWithDetail = { index: { ...metadata.index }, detail: {   ...metadata.detail, messages: [{
        role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text: '**literal body**' }] }],
        reasoning: [{ type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', text: 'formatted reasoning' }] }] }],
    }] } };
    const result = composeDomainDocument(validateParserDomain(domain), fixtureAccountFor(validateParserDomain(domain)));
    const [reasoning, body] = result.messages[0].blocks;
    assert.ok(reasoning.type === 'disclosure' && reasoning.blocks[0].type === 'paragraph');
    assert.equal(reasoning.blocks[0].children[0].type, 'strong');
    assert.deepEqual(body, domain.detail.messages[0].content[0]);
    assert.deepEqual(reasoning.blocks, domain.detail.messages[0].reasoning);
});

test('provider parsing diagnoses malformed entries at their source position without mutating input', async () => {
    const raw = { id: 'legacy', messages: [
        null as never,
        { role: 'assistant', content: { unsupported: 'visible fallback' } },
    ] };
    const original = structuredClone(raw);
    const result = historicalFixture(raw, { providerId: 'gemini' });
    assert.equal(result.conversation.detail.messages.length, 1);
    assert.deepEqual(raw, original);
    assert.equal(result.diagnostics.find(d => d.code === 'BAD_MESSAGE_SHAPE')?.path, 'messages[0]');
    assert.equal(result.conversation.detail.messages[0].content[0].type, 'unknown');
    assert.equal(result.diagnostics.filter(d => d.code === 'BAD_MESSAGE_SHAPE').length, 1);
});
