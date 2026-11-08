import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as equal from '../src/l2/domainEquality.js';
import type { DomainConversationDetail, DomainMessage, DomainAsset } from '../src/l2/conversationDetail.js';
import type { DomainConversationIndex } from '../src/l2/conversationIndex.js';
import type { BlockNode } from '../src/l2/content/blocks.js';
import { fixtureKey } from './helpers/domainFixture.js';

const key = fixtureKey('typed-equality');
const sampleIndex = (): DomainConversationIndex => ({
    key: { ...key }, title: 'Hi', titleSource: 'provider', createdAt: 10, updatedAt: 20, activityAt: 25,
});
const sampleBlocks = (): BlockNode[] => [
    { type: 'paragraph', children: [
        { type: 'strong', children: [{ type: 'text', text: 'hello' }] },
        { type: 'emphasis', children: [{ type: 'strikethrough', children: [{ type: 'citationRef', citationId: 'source', label: '[1]' }] }] },
        { type: 'link', href: 'https://example.test', children: [{ type: 'inlineCode', code: 'echo' }] },
        { type: 'image', assetId: 'image', alt: 'inline', title: 'icon' },
        { type: 'inlineMath', source: 'x^2' }, { type: 'lineBreak', kind: 'hard' },
    ] },
    { type: 'heading', level: 2, children: [{ type: 'text', text: 'title' }] },
    { type: 'list', ordered: true, start: 3, items: [{ blocks: [{ type: 'quote', blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'quoted' }] }] }] }] },
    { type: 'code', code: 'print(1)', language: 'py', meta: 'fixture' },
    { type: 'math', source: 'y=2' },
    { type: 'table', caption: [{ type: 'text', text: 'caption' }], columns: [{ align: 'left' }],
        headerRows: [{ cells: [{ children: [{ type: 'text', text: 'header' }], colSpan: 1 }] }],
        rows: [{ cells: [{ children: [{ type: 'text', text: 'body' }], rowSpan: 2 }] }] },
    { type: 'image', assetId: 'image', alt: 'block', caption: [{ type: 'text', text: 'caption' }] },
    { type: 'file', assetId: 'file', label: 'download', description: [{ type: 'text', text: 'file description' }] },
    { type: 'thematicBreak' }, { type: 'unknown', sourceType: 'future', text: 'raw fallback' },
];
const sampleAssets = (): DomainAsset[] => [
    { id: 'image', kind: 'image', name: 'photo', mediaType: 'image/png', byteLength: 123,
        sourceUri: 'https://example.test/i.png',
        generation: { providerRequestId: 'request', time: 123, prompt: 'p',
            generationOrdinal: 1, imageCount: 3, imageOrdinal: 0 } },
    { id: 'file', kind: 'file', document: { id: 'doc', contentMarkdown: '# markdown' } },
];
const sampleDetail = (): DomainConversationDetail => ({
    key: { ...key }, savedAt: 100, quality: { status: 'complete' }, assets: sampleAssets(),
    messages: [{ role: 'assistant', id: 'm1', model: 'gemini', timestamp: 123, content: sampleBlocks(),
        citations: [{ id: 'source', title: 'reference', url: 'https://example.test' }],
        attachmentIds: ['image', 'file'], reasoning: [{ type: 'paragraph', children: [{ type: 'text', text: 'thought' }] }] }],
});

test('typed Domain equality ignores object insertion order but checks all Index fields', () => {
    const a = sampleIndex();
    const b: DomainConversationIndex = { activityAt: 25, updatedAt: 20, createdAt: 10,
        titleSource: 'provider', title: 'Hi', key: { conversationId: key.conversationId, accountId: key.accountId } };
    assert.equal(equal.index(a, b), true);
    assert.equal(equal.index(a, { ...b, activityAt: 26 }), false);
    assert.equal(equal.index(a, { ...b, key: { ...key, conversationId: 'other' } }), false);
    assert.equal(equal.index(a, { ...b, title: undefined }), false, 'present optional field differs from nonempty value');
    assert.equal(equal.index(a, null), false);
    assert.equal(equal.index(null, undefined), false);
});

test('typed Domain equality deeply compares every AST branch and resource metadata', () => {
    const a = sampleDetail();
    const b = structuredClone(a);
    const reverseKeys = sampleDetail();
    reverseKeys.messages[0] = { content: reverseKeys.messages[0].content, reasoning: reverseKeys.messages[0].reasoning,
        attachmentIds: reverseKeys.messages[0].attachmentIds, citations: reverseKeys.messages[0].citations,
        timestamp: reverseKeys.messages[0].timestamp, model: reverseKeys.messages[0].model,
        id: reverseKeys.messages[0].id, role: reverseKeys.messages[0].role };
    reverseKeys.assets[0] = { sourceUri: reverseKeys.assets[0].sourceUri, generation: reverseKeys.assets[0].generation,
        byteLength: reverseKeys.assets[0].byteLength, mediaType: reverseKeys.assets[0].mediaType,
        name: reverseKeys.assets[0].name, kind: reverseKeys.assets[0].kind, id: reverseKeys.assets[0].id };
    assert.equal(equal.detail(a, b), true);
    assert.equal(equal.material(a, b), true);
    // The reversed object explicitly includes the same optional fields, preserving its exact own-key set.
    assert.equal(equal.detail(a, reverseKeys), true);
    const changed = structuredClone(a);
    changed.messages[0].content[5] = { type: 'list', ordered: false, items: [] };
    assert.equal(equal.detail(a, changed), false);
    const changedAssets = structuredClone(a);
    changedAssets.assets[0].generation!.imageOrdinal = 1;
    assert.equal(equal.material(a, changedAssets), false);
    const changedCitation = structuredClone(a);
    changedCitation.messages[0].citations![0].title = 'other';
    assert.equal(equal.material(a, changedCitation), false);
    const changedReasoning = structuredClone(a);
    changedReasoning.messages[0].reasoning![0] = { type: 'paragraph', children: [{ type: 'text', text: 'edited' }] };
    assert.equal(equal.material(a, changedReasoning), false);
    assert.equal(equal.detail(a, null), false);
});

test('typed equality keeps source-version-only commits separate from material Live Save changes', () => {
    const a = sampleDetail(), b = structuredClone(a);
    b.savedAt = 101;
    assert.equal(equal.material(a, b), true);
    assert.equal(equal.detail(a, b), false);
    b.quality.status = 'partial';
    assert.equal(equal.material(a, b), false);
});

test('typed equality distinguishes array order and optional field presence', () => {
    const a = sampleDetail(), b = structuredClone(a);
    b.messages[0].attachmentIds!.reverse();
    assert.equal(equal.material(a, b), false);
    const c = structuredClone(a);
    c.messages[0].model = undefined;
    assert.equal(equal.material(a, c), false);
    const d = structuredClone(a);
    delete d.messages[0].model;
    assert.equal(equal.material(a, d), false);
    const e = structuredClone(a);
    e.messages[0].content = e.messages[0].content.slice().reverse();
    assert.equal(equal.material(a, e), false);
});

test('Domain equality does not confuse changed nested AST node variants', () => {
    const body = sampleDetail();
    for (const replacement of [
        { type: 'text' as const, text: 'new' },
        { type: 'lineBreak' as const, kind: 'soft' as const },
        { type: 'inlineMath' as const, source: 'z' },
    ]) {
        const altered = structuredClone(body);
        const first = altered.messages[0].content[0];
        if (first.type !== 'paragraph') throw new Error('bad fixture');
        first.children[0] = replacement;
        assert.equal(equal.material(body, altered), false);
    }
});

test('source turn completion changes are persisted and notify Live Save even with unchanged text', () => {
    const a = sampleDetail(), b = structuredClone(a);
    a.quality.sourceTurn = 'unfinished';
    b.quality.sourceTurn = 'finished';
    assert.equal(equal.detail(a, b), false);
    assert.equal(equal.material(a, b), false);
});
