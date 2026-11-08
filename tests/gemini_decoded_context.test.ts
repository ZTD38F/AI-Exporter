import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiRequest } from '../src/l1/parsers/gemini/rpc/request.js';
import { createDocumentReader } from '../src/l1/parsers/gemini/rpc/sourceAttachments.js';
import { parseGeminiCredential } from '../src/l1/parsers/gemini/credentials.js';

const body = (groups: unknown[]) => new URLSearchParams({ 'f.req': JSON.stringify(groups) }).toString();
const list = ['MaZiqc', JSON.stringify([100, null, [0, null, 1]])];
const detail = ['hNvQHb', JSON.stringify(['c_12345678abcd', 10, 'older', 1, [1], [4], null, 1])];
const deletion = ['GzXR5e', JSON.stringify(['c_12345678abcd'])];

test('one mixed batch decodes once and yields independent, concrete RPC contexts', () => {
    const request = body([[list, detail, deletion, ['unknown', 'broken']]]);
    const batch = new URLSearchParams(request).get('f.req');
    const parse = JSON.parse;
    let batchReads = 0;
    JSON.parse = (text, reviver) => { if (text === batch) batchReads++; return parse(text, reviver); };
    try {
        assert.deepEqual(parseGeminiRequest(request), {
            list: { streamId: 'recent', requestCursor: null },
            detail: { conversationId: '12345678abcd', requestCursor: 'older' },
            deletionId: 'c_12345678abcd',
        });
        assert.equal(batchReads, 1);
    } finally { JSON.parse = parse; }
});

test('duplicate RPC identity is rejected across groups without discarding unrelated valid calls', () => {
    assert.deepEqual(parseGeminiRequest(body([[list, deletion], [list, deletion, detail]])), {
        list: null, deletionId: null, detail: { conversationId: '12345678abcd', requestCursor: 'older' },
    });
    assert.deepEqual(parseGeminiRequest(body([[list, ['hNvQHb', 'broken'], deletion]])), {
        list: { streamId: 'recent', requestCursor: null }, detail: null, deletionId: 'c_12345678abcd',
    });
    for (const raw of [null, {}, '', 'f.req=broken', body([null])]) {
        assert.deepEqual(parseGeminiRequest(raw), { list: null, detail: null, deletionId: null });
    }
});

test('document queries share one lazy response scan and parsed sections, preserving ambiguous title rejection', () => {
    const section = 'Document source paragraph with sufficient content to count as a complete section. '.repeat(4);
    const content = Object.freeze(['doc1', Object.freeze([Object.freeze([section, 'https://example.com/doc'])])]);
    const one = '# Report\n\n' + 'first report body '.repeat(25);
    const two = '# Report\n\n' + 'another report body '.repeat(25);
    let scans = 0;
    const source = { get evidence() { scans++; return [content, one, two]; } };
    const reader = createDocumentReader(source);
    assert.equal(scans, 0, 'responses without document queries do no document work');
    const first = reader.byId('doc1');
    assert.deepEqual(first?.sections, [section]);
    assert.equal(reader.byId('c_doc1')?.sections, first?.sections, 'aliases reuse the same parsed node');
    assert.equal(reader.byId('missing'), null);
    assert.equal(reader.byTitle({ id: 'doc1', title: 'Report' }), '', 'two distinct bodies cannot establish one document');
    assert.equal(scans, 1);
    assert.equal(Object.hasOwn(content, 'contentMatch'), false);
});

test('credential boundary rejects wrong field types before bootstrap consumes them', () => {
    const parsed = parseGeminiCredential({ sid: 12, at: {}, bl: 'build', lastUsed: Infinity,
        accountSlot: ['u0'], accountId: 'local-account' });
    assert.equal(parsed.sid, undefined);
    assert.equal(parsed.at, undefined);
    assert.equal(parsed.bl, 'build');
    assert.equal(parsed.lastUsed, undefined);
    assert.equal(parsed.accountSlot, undefined);
    assert.equal(parsed.accountId, 'local-account');
    assert.throws(() => parseGeminiCredential({ sid: 'sid', accountObservation: { providerId: 'gemini' } }));
});
