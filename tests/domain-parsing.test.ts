import { fixtureAccountFor } from './helpers/domainFixture.js';
import { historicalFixture } from './helpers/nativeFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDomainClosure } from '../src/l2/closure.js';
import type { ConversationRecordInput } from './helpers/recordFixture/conversationRecord.js';
import type { DomainFixture } from './helpers/domainFixture.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';

const parse = (data: ConversationRecordInput) => historicalFixture(data, { providerId: 'gemini' });

test('historical parsing requires explicit provider identity', () => {
    const data = { source: 'openai-import', messages: [{ role: 'model', model: 'Model A', content: '**Answer**' }] };
    const result = historicalFixture(data, { providerId: 'custom' });
    assert.equal(fixtureAccountFor(result.conversation).providerId, 'custom');
    assert.equal(result.conversation.detail.messages[0].model, 'Model A');
    for (const providerId of ['', '  ']) {
        assert.throws(() => historicalFixture(data, { providerId: providerId as never }), /providerId/);
    }
});

test('historical record fixtures retain provider inference inside the migration boundary', () => {
    for (const source of ['takeout', 'openai-import']) {
        const data = { id: 'chat', title: 'Title', timestamp: null, source, messages: [{ role: 'assistant' as const, content: '**Answer**' }] };
        const providerId = source === 'takeout' ? 'gemini' : 'openai';
        const result = historicalFixture(data, { providerId });
        assert.deepEqual(historicalFixture(data, { providerId }), result);
        assert.deepEqual(historicalFixture(data), result);
        assert.deepEqual(data.messages[0].content, '**Answer**');
    }
});

test('source provenance and explicit completeness survive JSON without leaking transport state', () => {
    const data = { id: 'chat', source: 'takeout', completeness: { status: 'complete' as const }, nextPageToken: null,
        messages: [{ id: 'answer', role: 'model', model: 'Model A', providerRequestId: 'request', content: 'Answer' }] };
    const original = structuredClone(data);
    const { conversation } = parse(data);
    assert.equal(Reflect.get(conversation, 'provenance'), undefined);
    assert.equal(conversation.detail.quality.status, 'complete');
    assert.deepEqual(JSON.parse(JSON.stringify(conversation)), conversation);
    assertDomainClosure((conversation).detail);
    assert.equal('nextPageToken' in conversation, false);
    assert.equal('source' in conversation, false);
    const document = composeDomainDocument(conversation, fixtureAccountFor(conversation));
    assert.equal(document.messages[0].modelLabel, 'Model A');
    assert.equal('provenance' in document, false);
    assert.equal('completeness' in document, false);
    assert.deepEqual(data, original);
});

test('positive truncation or paging evidence takes precedence over a complete claim', () => {
    for (const evidence of [{ truncated: true }, { isTruncated: true }, { nextPageToken: 'opaque-cursor' }]) {
        const data = { completeness: { status: 'complete' as const }, truncateReason: 'Source limit', ...evidence };
        const original = structuredClone(data);
        const { conversation } = parse(data);
        assert.equal(conversation.detail.quality.status, 'partial');
        assert.ok(!JSON.stringify(conversation).includes('opaque-cursor'));
        assert.deepEqual(data, original);
    }
});

test('absence of truncation is not evidence of complete coverage', () => {
    for (const data of [{}, { truncated: false, isTruncated: false, nextPageToken: null }, { nextPageToken: '  ', truncateReason: 'Unconfirmed' }]) {
        assert.equal(parse(data).conversation.detail.quality.status, 'unknown');
    }
    assert.deepEqual(parse({ completeness: { status: 'unknown' } }).conversation.detail.quality.status, 'unknown');
    assert.deepEqual(parse({ nextPageToken: 'cursor', completeness: { status: 'partial', reason: 'Selected range' } }).conversation.detail.quality.status,
        'partial');
    assert.deepEqual(parse({ completeness: { status: 'partial', reason: 'Only a selected range' } }).conversation.detail.quality.status,
        'partial');
});

test('Domain completeness is validated and copied independently from input evidence', () => {
    const data = { completeness: { status: 'partial' as const, reason: 'Missing older messages' } };
    const { conversation } = parse(data);
    conversation.detail.quality.status = 'complete';
    assert.equal(data.completeness.reason, 'Missing older messages');
    assert.throws(() => parse({ completeness: { status: 'finished' as never } }), /quality/);
    assert.equal(parse({ completeness: { status: 'partial', reason: 42 as never } }).conversation.detail.quality.status, 'partial');
});

test('legacy parser preserves source updatedAt but never treats local timestamp as source version', () => {
    for (const timestamp of [NaN, Infinity, -Infinity, '123', undefined, 1700000000123]) {
        const parsed = parse({ timestamp });
        assert.equal(parsed.conversation.index.updatedAt, undefined,
            'a legacy observation timestamp does not establish source activity');
        assert.equal(parsed.sourceVersion, undefined);
        assert.equal(Object.hasOwn(parsed.conversation, 'timestamp'), false);
        assert.deepEqual(JSON.parse(JSON.stringify(parsed.conversation)), parsed.conversation);
    }
    for (const updatedAt of [0, -1000, 1700000000123, '123']) {
        const parsed = parse({ updatedAt });
        const expected = Number(updatedAt);
        assert.equal(parsed.conversation.index.updatedAt, expected);
        assert.equal(parsed.sourceVersion, expected);
        assert.deepEqual(JSON.parse(JSON.stringify(parsed.conversation)), parsed.conversation);
    }
    for (const updatedAt of [NaN, Infinity, -Infinity, undefined]) {
        const parsed = parse({ updatedAt });
        assert.equal(parsed.conversation.index.updatedAt, undefined);
        assert.equal(parsed.sourceVersion, undefined);
    }
});

test('shared parse result keeps diagnostics and preparation evidence outside a closed Domain graph', () => {
    const data = { messages: [{ role: 'custom-role', content: '![picture](https://example.test/picture.png)',
        attachments: [{ localName: 'assets/archive.png', mimeType: 'image/png', url: 'https://example.test/picture.png' }] }] };
    const original = structuredClone(data);
    const result = parse(data);
    const semanticResult: DomainFixture = result;
    assert.ok(semanticResult.diagnostics.some(d => d.code === 'UNKNOWN_ROLE'));
    assert.equal(result.conversation.detail.assets.length, 1);
    assert.ok(Object.keys(result.resourceHints).includes(result.conversation.detail.assets[0].id));
    const json = JSON.stringify(result.conversation);
    for (const field of ['diagnostics', 'resourceHints', 'acquisitionHints', 'localName']) assert.ok(!json.includes(`"${field}":`));
    assertDomainClosure((JSON.parse(json)).detail);
    assert.deepEqual(data, original);
});
