import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mockAccount, givenReadonlyDomain, composeDomainDocument } from './helpers/l3bUnitHarness.js';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';

const account = Object.freeze({ ...mockAccount('chatgpt'), email: 'private@example.test', displayName: 'Private name' });
function input(): DomainConversationWithDetail {
    const key = { accountId: account.id, conversationId: 'same-native-id' };
    return { index: { key, title: 'Index title', titleSource: 'provider', createdAt: 1000, updatedAt: 2000 },
        detail: { key: { ...key }, savedAt: 9999999999999, quality: { status: 'partial' }, assets: [], messages: [
            { id: 'provider-z', role: 'assistant', model: 'Source model', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'First body' }] }] },
            { id: 'provider-a', role: 'user', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Second body' }] }] },
        ] } };
}

test('AST: projection uses matched Account and Index facts, preserving supplied partial body order', () => {
    const domain = givenReadonlyDomain(input()), before = JSON.stringify(domain);
    const document = composeDomainDocument(domain, account);
    assert.deepEqual(document.metadata, { id: 'same-native-id', provider: 'chatgpt', createdAt: 1000, updatedAt: 2000 });
    assert.equal(document.title, 'Index title');
    assert.deepEqual(document.messages.map(m => [m.role, m.modelLabel]), [['assistant', 'Source model'], ['user', undefined]]);
    assert.doesNotMatch(JSON.stringify(document), /private@example|Private name|provider-z|savedAt|quality|9999999999999/);
    assert.equal(JSON.stringify(domain), before);

    const otherAccount = mockAccount('chatgpt', '20000000-0000-4000-8000-000000000001');
    assert.throws(() => composeDomainDocument(domain, otherAccount), /Account\/key mismatch/);
    const other = input(); other.index.key.accountId = otherAccount.id; other.detail.key.accountId = otherAccount.id;
    other.detail.messages[0].content = [{ type: 'paragraph', children: [{ type: 'text', text: 'Other account body' }] }];
    const otherDocument = composeDomainDocument(givenReadonlyDomain(other), otherAccount);
    assert.equal(otherDocument.metadata.id, document.metadata.id, 'AST source ID is not a cross-account storage key');
    assert.deepEqual(otherDocument.messages[0].blocks, other.detail.messages[0].content);
    assert.deepEqual(document.messages[0].blocks, domain.detail.messages[0].content);
    domain.detail.key.conversationId = 'wrong-detail';
    assert.throws(() => composeDomainDocument(domain, account), /Account\/key mismatch/);
});

test('AST: missing Index title and times get reading defaults without borrowing savedAt', () => {
    const raw = input(); raw.index = { key: raw.index.key };
    const domain = givenReadonlyDomain(raw), before = JSON.stringify(domain);
    const document = composeDomainDocument(domain, account);
    assert.equal(document.title, 'Untitled conversation');
    assert.ok(!('updatedAt' in document.metadata));
    assert.deepEqual(document.metadata, { id: 'same-native-id', provider: 'chatgpt' });
    assert.equal(JSON.stringify(domain), before);
});

test('AST: Composer numbers sources once across messages and preserves absent URLs', () => {
    const raw = input();
    raw.detail.messages = [0, 1].map(() => ({ role: 'assistant', citations: [{ id: 'same' }, { id: 'named', title: 'Article', url: 'https://example.test/article' }],
        reasoning: [{ type: 'paragraph', children: [{ type: 'citationRef', citationId: 'same', label: '[99]' }] }],
        content: [{ type: 'paragraph', children: [{ type: 'citationRef', citationId: 'named', label: 'Read this' }, { type: 'citationRef', citationId: 'same' }] }],
    }));
    const document = composeDomainDocument(givenReadonlyDomain(raw), account);
    assert.deepEqual(document.messages.map(m => m.sources?.map(s => [s.id, s.number, s.label, s.href])), [
        [['same', 1, '', undefined], ['named', 2, 'Article', 'https://example.test/article']],
        [['same', 3, '', undefined], ['named', 4, 'Article', 'https://example.test/article']],
    ]);
    const reasoning = document.messages[1].blocks[0];
    assert.ok(JSON.stringify(reasoning).includes('"label":"[99]"'));

});

test('AST: only explicit media placements become AST content; resource absence never changes the AST', () => {
    const raw = input();
    raw.detail.assets = [{ id: 'photo', kind: 'image', name: 'Diagram.png' }, { id: 'file', kind: 'file', name: 'Report.pdf' }, { id: 'unowned', kind: 'image' }];
    raw.detail.messages = [
        { role: 'assistant', content: [] },
        { role: 'user', content: [{ type: 'paragraph', children: [{ type: 'image', assetId: 'photo' }] }], attachmentIds: ['photo', 'file'] },
    ];
    const document = composeDomainDocument(givenReadonlyDomain(raw), account), before = JSON.stringify(document);
    assert.deepEqual(document.messages[0].blocks, []);
    assert.equal(document.messages[1].blocks.length, 3, 'explicit attachment IDs follow content in source order');
    assert.ok(!before.includes('unowned') && !before.includes('placeholder'));
    assert.equal(JSON.stringify(document), before);
});

test('AST: code and reasoning preserve facts without renderer controls', () => {
    const raw = input(); raw.detail.messages[0].reasoning = [{ type: 'code', code: 'thought', language: 'text' }];
    raw.detail.messages[0].content = [{ type: 'code', code: 'answer', language: 'js', meta: 'Authored filename' }];
    const domain = givenReadonlyDomain(raw), document = composeDomainDocument(domain, account), before = JSON.stringify(document);
    assert.deepEqual(document.messages[0].blocks, [
        { type: 'disclosure', kind: 'reasoning', title: 'Thinking Process', blocks: [{ type: 'code', code: 'thought', language: 'text' }] },
        { type: 'code', code: 'answer', language: 'js', meta: 'Authored filename' },
    ]);
    assert.equal(JSON.stringify(document), before);
});

test('AST: Composer modules cannot reach persistence, acquisition or provider services', () => {
    for (const file of ['composeDomainDocument', 'composeContent', 'resourcePresentation']) {
        const source = readFileSync(`src/l3b/compose/${file}.ts`, 'utf8');
        for (const [, dependency] of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
            assert.doesNotMatch(dependency, /(?:^|\/)(?:storage|api|providers?|parsers|resources|renderers|export)(?:\/|$)/);
        }
        assert.doesNotMatch(source, /\bfetch\s*\(|chrome\.storage|\bdataBase64\b/);
    }
});
