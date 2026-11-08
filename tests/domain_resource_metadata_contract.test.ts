import { fixtureKey } from './helpers/domainFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { closeDomainResources } from '../src/l1/parsers/shared/resources/domainResourceAdapter.js';
import type { DomainAsset } from '../src/l2/conversationDetail.js';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
const base = (assets: DomainAsset[] = []): DomainConversationWithDetail => ({ index: { key: fixtureKey(String('chat'), 'custom'),   titleSource: "derived",   title: 'Resources' }, detail: { key: fixtureKey(String('chat'), 'custom'), quality: { status: 'unknown' }, assets, messages: [] } });
test('source metadata stays outside Domain and canonical report body retains authored sections and links', () => {
    const result = closeDomainResources('custom', [], [{ input: { attachments: [{ type: 'file', id: 'report', url: 'https://example.test/report', createdAt: 1, chipUrl: 'https://example.test/chip', width: 100, height: 80, source: 'source', sections: ['# Report', 'Evidence'], links: [{ title: 'Reference', url: 'https://example.test/reference' }], candidates: ['https://example.test/download'] }] } }]);
    const asset = result.assets[0];
    assert.equal(asset.sourceUri, 'https://example.test/report');
    for (const key of ['origin', 'dimensions', 'source', 'generated']) assert.equal(Object.hasOwn(asset, key), false);
    assert.ok(asset.document?.contentMarkdown?.includes('# Report'));
    assert.ok(asset.document?.contentMarkdown?.includes('[Reference](https://example.test/reference)'));
    for (const key of ['createdAt', 'chipUrl', 'sections', 'links', 'candidates']) assert.equal(Object.hasOwn(asset.document ?? {}, key), false);
    assert.deepEqual(result.acquisitionHints[asset.id].candidates, ['https://example.test/download']);
    validateParserDomain(base([asset]));
});
test('new schema rejects every removed asset and generation field', () => {
    const valid: DomainAsset = { id: 'asset', kind: 'image', sourceUri: 'original', generation: { providerRequestId: 'request', time: 123, generationOrdinal: 0 } };
    for (const [key, value] of Object.entries({ source: { uri: 'old' }, origin: 'rpc', dimensions: { width: 1 }, generated: true })) {
        assert.throws(() => validateParserDomain(base([{ ...valid, [key]: value }])));
    }
    for (const key of ['chatId', 'turnId']) assert.throws(() => validateParserDomain(base([{ ...valid, generation: { providerRequestId: 'request', [key]: 'old' } }])));
    for (const key of ['createdAt', 'chipUrl', 'sections', 'links', 'candidates']) assert.throws(() => validateParserDomain(base([{ ...valid, document: { contentMarkdown: 'body', [key]: 'old' } }])));
    assert.throws(() => validateParserDomain(base([{ ...valid, generation: { time: null as never } }])));
});


test('canonical report body keeps independent sections and links', () => {
    const result = closeDomainResources('custom', [], [{ input: { attachments: [{ type: 'file', contentMarkdown: '# Canonical', sections: ['# Canonical', 'Unique section'], links: [{ title: 'Evidence', url: 'https://example.test/evidence' }] }] } }]);
    assert.equal(result.assets[0].document?.contentMarkdown, '# Canonical\n\nUnique section\n\n[Evidence](https://example.test/evidence)');
});

test('L2 never admits ephemeral signed resource locators or invalid byte counts', () => {
    for (const sourceUri of [
        '', 'data:image/png;base64,AQID', 'blob:https://example.test/a',
        'https://example.test/image?X-Amz-Date=20261019T120000Z&X-Amz-Signature=abc',
        'https://example.test/image?X-Goog-Credential=abc&X-Goog-Signature=abc',
        'https://example.test/file?Expires=123&Signature=abc&Key-Pair-Id=key',
        'https://example.test/image?token=temporary',
        'archive/images/photo.png?token=temporary',
    ]) assert.throws(() => validateParserDomain(base([{ id: 'image', kind: 'image', sourceUri }])), TypeError, sourceUri);
    for (const byteLength of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
        assert.throws(() => validateParserDomain(base([{ id: 'image', kind: 'image', byteLength }])), TypeError);
    validateParserDomain(base([{ id: 'image', kind: 'image', sourceUri: 'https://example.test/image?id=stable', byteLength: 0 }]));
    validateParserDomain(base([{ id: 'image', kind: 'image', sourceUri: 'provider-stable-resource-id' }]));
    validateParserDomain(base([{ id: 'image', kind: 'image', sourceUri: 'archive/photo.png' }]));
});
