import { fixtureAccount, fixtureKey } from './helpers/domainFixture.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeDomainJson } from '../src/l4/format/json/serializeDomainJson.js';
import type { DomainFixture } from './helpers/domainFixture.js';
import { assertDomainClosure } from '../src/l2/closure.js';
const native: DomainFixture = { account: fixtureAccount('test-provider'),
    conversation: validateParserDomain({ index: { key: fixtureKey(String('opaque-id'), 'test-provider'),   titleSource: "derived",   title: 'Portable archive', createdAt: 0 }, detail: { key: fixtureKey(String('opaque-id'), 'test-provider'), quality: { status: 'partial' }, assets: [
            { id: 'image', kind: 'image', name: 'image.png', mediaType: 'image/png', sourceUri: 'https://example.test/image.png' },
            { id: 'file', kind: 'file', name: 'report.pdf', mediaType: 'application/pdf', byteLength: 42 } ], messages: [{ id: 'system', role: 'system', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Instruction' }] }] },
            { id: 'answer', role: 'assistant', timestamp: 0, model: 'Source model',
                content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Answer' }, { type: 'image', assetId: 'image' }, { type: 'citationRef', citationId: 'source' }] }],
                reasoning: [{ type: 'paragraph', children: [{ type: 'text', text: 'Reasoning' }] }],
                attachmentIds: ['file'], citations: [{ id: 'source', title: 'Evidence', url: 'https://example.test/source' }] }] } }),
    diagnostics: [{ severity: 'warning', code: 'TEST_WARNING', message: 'Separate problem record' }],
    resourceHints: { image: { archivePath: 'assets/image.png' }, file: { archivePath: 'files/report.pdf' } },
    acquisitionHints: { image: { url: 'https://example.test/image.png' } },
};
const bindings = { image: 'assets/image.png', file: 'files/report.pdf' };
test('Archive v1 preserves trusted Domain and Account with flat Packaging bindings', () => {
    const before = structuredClone(native);
    const archive = JSON.parse(serializeDomainJson(native.conversation, native.account, bindings));
    assert.deepEqual(Object.keys(archive), ['format', 'version', 'account', 'conversation', 'resources']);
    assert.equal(archive.format, 'gemini-exporter-domain'); assert.equal(archive.version, 1);
    assert.deepEqual(archive.account, native.account);
    assert.deepEqual(archive.conversation, native.conversation); assertDomainClosure(archive.conversation.detail);
    assert.deepEqual(archive.resources, bindings);
    assert.deepEqual(native, before);
});
test('no resource bytes still preserves all Asset facts and only Detail savedAt', () => {
    const conversation = { ...native.conversation, detail: { ...native.conversation.detail, savedAt: 123 } };
    const archive = JSON.parse(serializeDomainJson(conversation, native.account, {}));
    assert.deepEqual(archive.resources, {});
    assert.equal(archive.savedAt, undefined);
    assert.equal(archive.conversation.detail.savedAt, 123);
    assert.deepEqual(archive.conversation.detail.assets, native.conversation.detail.assets);
});
test('Archive refuses mismatched accounts and mismatched conversation keys', () => {
    assert.throws(() => serializeDomainJson(native.conversation, fixtureAccount('other'), {}), /mismatch/);
    const conversation = { ...native.conversation, detail: { ...native.conversation.detail,
        key: { ...native.conversation.detail.key, conversationId: 'other' } } };
    assert.throws(() => serializeDomainJson(conversation, native.account, {}), /mismatch/);
});
test('Account profiles and default source identity are retained verbatim', () => {
    const account = { ...native.account, providerAccountId: 'default', email: 'user@example.test', displayName: 'Name' };
    assert.deepEqual(JSON.parse(serializeDomainJson(native.conversation, account, {})).account, account);
});
test('non-encodable input throws rather than returning a successful archive', () => {
    const conversation = structuredClone(native.conversation);
    Object.assign(conversation, { cycle: conversation });
    assert.throws(() => serializeDomainJson(conversation, native.account, {}), /circular/i);
});
