import { fixtureKey } from './helpers/domainFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptDetailFacts, validateParserDomain, restoreDomainSnapshot } from '../src/l2/runtimeValidation.js';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';

function valid(): DomainConversationWithDetail {
    return { index: { key: fixtureKey(String('independent'), 'future'),   titleSource: "derived",   title: 'Fixture' }, detail: { key: fixtureKey(String('independent'), 'future'), quality: { status: 'unknown' }, assets: [{ id: 'image', kind: 'image' }], messages: [{ role: 'assistant',
            citations: [{ id: 'cite', url: 'https://example.test' }],
            content: [{ type: 'paragraph', children: [{ type: 'image', assetId: 'image' }, { type: 'citationRef', citationId: 'cite' }] },
                { type: 'unknown', sourceType: 'future', text: 'preserved' }] }] } };
}
test('parser validation and recovery validate without redundant JSON copies', () => {
    const input = valid();
    const json = JSON.stringify(input);
    assert.equal(validateParserDomain(input).detail, input.detail);
    const restored = restoreDomainSnapshot(input);
    assert.deepEqual(restored, input);
    assert.equal(restored.detail.messages, input.detail.messages);
    assert.equal(JSON.stringify(input), json, 'validation leaves the producer graph untouched');
    assert.deepEqual(Object.getOwnPropertySymbols(restored), []);
    assert.equal(restored.detail.messages[0].citations, input.detail.messages[0].citations);
});
test('both entry points reject independent malformed graphs and nonportable values', () => {
    const negatives: unknown[] = [
        { index: { ...valid().index, title: 4 }, detail: {   ...valid().detail } }, { index: { ...valid().index }, detail: {   ...valid().detail, messages: {} } }, { index: { ...valid().index }, detail: {   ...valid().detail }, timestamp: Infinity },
        { index: { ...valid().index }, detail: {   ...valid().detail, quality: { status: 'fabricated' } } }, { index: { ...valid().index }, detail: {   ...valid().detail }, extra: true },
        { index: { ...valid().index }, detail: {   ...valid().detail, messages: [{ role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text: 1 }] }] }] } },
        { index: { ...valid().index }, detail: {   ...valid().detail, assets: [] } },
        { index: { ...valid().index }, detail: {   ...valid().detail, messages: [{ role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'citationRef', citationId: 'missing' }] }] }] } },
        { index: { ...valid().index }, detail: {   ...valid().detail, assets: [{ id: 'image', kind: 'image' }, { id: 'image', kind: 'image' }] } },
        { index: { ...valid().index }, detail: {   ...valid().detail, messages: [{ role: 'assistant', content: [], attachmentIds: ['image', 'image'] }] } },
        { index: { ...valid().index, title: () => 'bad' }, detail: {   ...valid().detail } }, { index: { ...valid().index }, detail: {   ...valid().detail }, timestamp: 1n },
    ];
    for (const quality of [{ status: 'complete', rejectedTurns: 1 }, { status: 'partial', rejectedTurns: -1 },
        { status: 'partial', rejectedTurns: 0 }, { status: 'partial', rejectedTurns: 1.5 }, { status: 'partial', truncation: ' ' },
        { status: 'partial', heuristicDocumentIds: ['missing'] }, { status: 'partial', heuristicDocumentIds: ['image', 'image'] },
        { status: 'partial', extra: true }]) negatives.push({ ...valid(), detail: {   ...valid().detail, quality } });
    negatives.push({ ...valid(), detail: {   ...valid().detail, completeness: 'unknown' } });
    negatives.push({ ...valid(), detail: {   ...valid().detail, assets: [{ id: 'image', kind: 'image', document: { hasFabricatedText: true } }] } });
    const cycle = valid(); cycle.detail.messages[0].content.push({ type: 'quote', blocks: cycle.detail.messages[0].content });
    negatives.push(cycle);
    for (const input of negatives) {
        assert.throws(() => restoreDomainSnapshot(input));
        // Deliberately corrupted producer output: runtime validation must protect the contract.
        assert.throws(() => validateParserDomain(input as DomainConversationWithDetail));
    }
});
test('storage rejects toJSON laundering, parser does not silently normalize it', () => {
    const value = { index: { ...valid().index }, detail: {   ...valid().detail }, toJSON: () => valid() };
    assert.throws(() => restoreDomainSnapshot(value));
    assert.throws(() => validateParserDomain(value));
});


test('both entry points share index identity and reference closure rules', () => {
    for (const id of ['', '   ', ' padded ']) {
        const value = valid(); value.index.key.conversationId = id;
        assert.throws(() => validateParserDomain(value), TypeError);
        assert.throws(() => restoreDomainSnapshot(value), TypeError);
    }
    const empty = valid();
    empty.detail.assets = []; empty.detail.messages = [];
    assert.equal(validateParserDomain(empty).detail, empty.detail);
    assert.deepEqual(restoreDomainSnapshot(empty), empty);
});

test('both entry points reject holes and undefined elements throughout nested Domain arrays', () => {
    const hole = <T>(): T[] => new Array<T>(1);
    const cases: Array<(value: DomainConversationWithDetail) => void> = [
        v => { v.detail.messages = hole(); },
        v => { v.detail.assets = hole(); },
        v => { v.detail.messages[0].content = hole(); },
        v => { v.detail.messages[0].reasoning = hole(); },
        v => { v.detail.messages[0].attachmentIds = hole(); },
        v => { v.detail.messages[0].citations = hole(); },
        v => { v.detail.messages[0].content = [{ type: 'paragraph', children: hole() }]; },
        v => { v.detail.messages[0].content = [{ type: 'paragraph', children: [{ type: 'strong', children: hole() }] }]; },
        v => { v.detail.messages[0].content = [{ type: 'list', ordered: false, items: hole() }]; },
        v => { v.detail.messages[0].content = [{ type: 'list', ordered: false, items: [{ blocks: hole() }] }]; },
        v => { v.detail.messages[0].content = [{ type: 'quote', blocks: hole() }]; },
        v => { v.detail.messages[0].content = [{ type: 'table', columns: hole(), rows: [] }]; },
        v => { v.detail.messages[0].content = [{ type: 'table', headerRows: hole(), rows: [] }]; },
        v => { v.detail.messages[0].content = [{ type: 'table', rows: hole() }]; },
        v => { v.detail.messages[0].content = [{ type: 'table', rows: [{ cells: hole() }] }]; },
        v => { v.detail.messages[0].content = [{ type: 'table', rows: [{ cells: [{ children: hole() }] }] }]; },
        v => { v.detail.messages[0].content = [{ type: 'image', assetId: 'image', caption: hole() }]; },
        v => { v.detail.messages[0].content = [{ type: 'file', assetId: 'image', description: hole() }]; },
    ];
    for (const [index, corrupt] of cases.entries()) {
        const value = valid(); corrupt(value);
        assert.throws(() => validateParserDomain(value), TypeError, `parser case ${index}`);
        assert.throws(() => restoreDomainSnapshot(value), TypeError, `storage case ${index}`);
        // JSON represents the same unusable positions as null, which must also fail.
        assert.throws(() => restoreDomainSnapshot(JSON.parse(JSON.stringify(value))), TypeError);
    }
    const undefinedNode = valid();
    Object.assign(undefinedNode.detail.messages[0].content, { 0: undefined });
    assert.throws(() => validateParserDomain(undefinedNode), TypeError);
    assert.throws(() => restoreDomainSnapshot(undefinedNode), TypeError);
});

test('parser and recovery reject nonintegral, out-of-range, and over-wide table grids before composition', () => {
    const withTable = (table: import('../src/l2/content/blocks.js').TableBlock) => {
        const value = valid(); value.detail.messages[0].content = [table]; return value;
    };
    const invalidTables: import('../src/l2/content/blocks.js').TableBlock[] = [];
    for (const span of [0, -1, 1.5, 4294967296, Number.MAX_VALUE]) {
        invalidTables.push({ type: 'table', rows: [{ cells: [{ children: [], colSpan: span }] }] });
        invalidTables.push({ type: 'table', rows: [{ cells: [{ children: [], rowSpan: span }] }] });
    }
    invalidTables.push(
        { type: 'table', rows: [{ cells: [{ children: [], colSpan: 1001 }] }] },
        { type: 'table', rows: [{ cells: [{ children: [], rowSpan: 65535 }] }] },
        { type: 'table', columns: Array.from({ length: 1001 }, () => ({})), rows: [] },
        { type: 'table', rows: [{ cells: [{ children: [], colSpan: 1000 }, { children: [] }] }] },
        // Individually valid rows can overflow once the header's rowspan occupies columns.
        { type: 'table', headerRows: [{ cells: [{ children: [], colSpan: 1000, rowSpan: 2 }] }], rows: [{ cells: [{ children: [] }] }] },
    );
    for (const table of invalidTables) {
        const value = withTable(table);
        assert.throws(() => validateParserDomain(value), TypeError);
        assert.throws(() => restoreDomainSnapshot(value), TypeError);
        // Nested tables use the same boundary rules.
        value.detail.messages[0].content = [{ type: 'quote', blocks: [table] }];
        assert.throws(() => validateParserDomain(value), TypeError);
    }
    for (const table of [
        { type: 'table' as const, rows: [] },
        { type: 'table' as const, rows: [{ cells: [] }] },
        { type: 'table' as const, rows: [{ cells: [{ children: [], colSpan: 1000, rowSpan: 65534 }] }] },
    ]) {
        const value = withTable(table);
        assert.equal(validateParserDomain(value).detail, value.detail);
        assert.deepEqual(restoreDomainSnapshot(value), value);
    }
});


test('trusted parser bodies are reused internally but copied IPC facts must pass full validation', () => {
    const parsed = validateParserDomain(valid());
    assert.equal(acceptDetailFacts(parsed.detail.key, parsed.detail), parsed.detail);
    const received = structuredClone(parsed.detail);
    received.assets = [];
    assert.throws(() => acceptDetailFacts(parsed.detail.key, received), TypeError);
    assert.throws(() => acceptDetailFacts({ ...parsed.detail.key, conversationId: 'other' }, parsed.detail), TypeError);
});

test('Domain parser rejects unsafe or fractional savedAt timestamps', () => {
    const source = valid();
    for (const savedAt of [0.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
        assert.throws(() => validateParserDomain({ ...source, detail: { ...source.detail, savedAt } }), TypeError);
    }
    assert.equal(validateParserDomain({ ...source, detail: { ...source.detail, savedAt: 0 } }).detail.savedAt, 0);
});


test('snapshot recovery uses canonical Index output and preserves untouched Detail graphs', () => {
    const source = valid();
    const index = { ...source.index, createdAt: undefined, activityAt: undefined };
    const raw = { ...source, index };
    const restored = restoreDomainSnapshot(raw);
    assert.equal(Object.hasOwn(restored.index, 'createdAt'), false);
    assert.equal(Object.hasOwn(restored.index, 'activityAt'), false);
    assert.equal(Object.hasOwn(raw.index, 'createdAt'), true, 'recovery does not mutate the transport');
    assert.equal(restored.detail, source.detail);
    assert.equal(restored.detail.messages, source.detail.messages);
});

test('canonicalization never launders extra undefined fields into a trusted graph', () => {
    const source = valid();
    for (const detail of [
        { ...source.detail, unexpected: undefined },
        { ...source.detail, messages: [{ ...source.detail.messages[0], unexpected: undefined }] },
        { ...source.detail, messages: [{ ...source.detail.messages[0], content: [{ type: 'paragraph', children: [], unexpected: undefined }] }] },
    ]) assert.throws(() => restoreDomainSnapshot({ index: source.index, detail }), TypeError);
});
