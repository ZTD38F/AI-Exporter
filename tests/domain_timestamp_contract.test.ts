import { fixtureKey, fixtureAccount, fixtureAccountFor } from './helpers/domainFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTimestamp } from '../src/l1/parsers/shared/time.js';
import { validateParserDomain, restoreDomainSnapshot } from '../src/l2/runtimeValidation.js';
import { mergeConversationPages } from '../src/l1/parsers/gemini/rpc/mergePages.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
const exportDomainMarkdown = (domain: Parameters<typeof composeDomainDocument>[0], account: Parameters<typeof composeDomainDocument>[1]) => renderDocumentMarkdown(composeDomainDocument(domain, account), {});
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
const base = (): DomainConversationWithDetail => ({ index: { key: fixtureKey(String('chat'), 'custom'),   titleSource: "derived",   title: 'Times' }, detail: { key: fixtureKey(String('chat'), 'custom'), quality: { status: 'unknown' }, assets: [], messages: [] } });
test('conversation times are independent finite epoch milliseconds and unknown facts are absent', () => {
    assert.equal(normalizeTimestamp(0), 0);
    assert.equal(normalizeTimestamp(null), undefined);
    assert.equal(normalizeTimestamp('1700000000123'), 1700000000123);
    assert.equal(normalizeTimestamp('2026-10-06T00:00:00Z'), Date.parse('2026-10-06T00:00:00Z'));
    for (const invalid of [0.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1])
        assert.equal(normalizeTimestamp(invalid), undefined);
    for (const invalid of [null, NaN, Infinity, '', 'bad-date', true, {}]) {
        assert.equal(normalizeTimestamp(invalid), undefined);
        if (invalid !== undefined) assert.throws(() => validateParserDomain({ index: { ...base().index, createdAt: invalid as never }, detail: {   ...base().detail } }));
    }
    assert.deepEqual(restoreDomainSnapshot(base()), base());
});
test('current snapshots reject historical aliases and representations', () => {
    for (const key of ['updatedAt', 'timestamp', 'chatTime', 'lastSeen', 'href', 'titles', 'provenance']) {
        assert.throws(() => restoreDomainSnapshot({ index: { ...base().index }, detail: {   ...base().detail }, [key]: key === 'timestamp' ? null : 'old' }));
    }
    const old = { index: { ...base().index, createdAt: '2026-10-06T00:00:00Z', updatedAt: null }, detail: {   ...base().detail, completeness: { status: 'partial', reason: 'Selected' } }, timestamp: 123, href: 'https://example.test/chat' };
    assert.throws(() => restoreDomainSnapshot(old));
});
test('message dates do not fabricate conversation creation or update facts during pagination', () => {
    const conversation = validateParserDomain({ index: { ...base().index }, detail: {   ...base().detail, messages: [{ role: 'user', timestamp: 1700000000000, content: [] }] } });
    const { key: _indexKey, ...index } = conversation.index;
    const { key: _detailKey, ...detail } = conversation.detail;
    const merged = mergeConversationPages([{ conversationId: conversation.index.key.conversationId, conversation: { index, detail }, acquisitionHints: {}, diagnostics: [] }]);
    assert.equal(merged.conversation.index.createdAt, undefined);
    assert.equal(merged.sourceVersion, undefined);
    assert.equal(merged.conversation.detail.messages[0].timestamp, 1700000000000);
});
test('Markdown preserves independently known creation/update facts and omits unknown times', async () => {
    const dated = validateParserDomain({ index: { ...base().index, createdAt: 0 }, detail: {   ...base().detail } });
    const markdown = await exportDomainMarkdown({ ...dated, index: { ...dated.index, updatedAt: 1000 } }, fixtureAccountFor({ ...dated, index: { ...dated.index, updatedAt: 1000 } }));
    assert.ok(markdown.includes('1970-01-01T00:00:00.000Z'));
    assert.ok(markdown.includes('1970-01-01T00:00:01.000Z'));
    const undated = await exportDomainMarkdown(validateParserDomain(base()), fixtureAccountFor(validateParserDomain(base())));
    assert.equal(undated.includes('date:'), false);
    assert.equal(undated.includes('updated:'), false);
});

test('L2 admission protects the L3b Unix-ms contract from fractional and unsafe source times', () => {
    for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
        for (const field of ['createdAt', 'updatedAt']) {
            assert.throws(() => validateParserDomain({ ...base(), index: { ...base().index, [field]: value } }), TypeError);
        }
        assert.throws(() => validateParserDomain({ ...base(), detail: { ...base().detail,
            messages: [{ role: 'assistant', timestamp: value, content: [] }] } }), TypeError);
        assert.throws(() => validateParserDomain({ ...base(), detail: { ...base().detail, savedAt: value } }), TypeError);
        assert.throws(() => restoreDomainSnapshot({ ...base(), detail: { ...base().detail, savedAt: value } }), TypeError);
        assert.throws(() => validateParserDomain({ ...base(), detail: { ...base().detail,
            assets: [{ id: 'image', kind: 'image', generation: { time: value } }] } }), TypeError);
    }
    const admitted = validateParserDomain({ ...base(), index: { ...base().index, createdAt: 0 },
        detail: { ...base().detail, messages: [{ role: 'assistant', timestamp: 0, content: [] }] } });
    const document = require('../src/l3b/compose/composeDomainDocument.js').composeDomainDocument(admitted, fixtureAccountFor(admitted));
    assert.equal(document.metadata.createdAt, 0); assert.equal(document.messages[0].timestamp, 0);
});
