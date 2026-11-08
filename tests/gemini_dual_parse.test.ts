import { fixtureAccount } from './helpers/domainFixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeGeminiDetail } from '../src/l1/parsers/gemini/rpc/detailDecoder.js';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
import { auditGeminiEvidence, canonicalMessage, differences, readGeminiAuditInput, semanticContent } from './helpers/geminiDualParse.js';
import { runAudit } from '../scripts/check_gemini_dual_parse.js';
import type { DomainMessage, DomainAsset } from '../src/l2/conversationDetail.js';

const body = (content: DomainMessage['content']): DomainMessage => ({ role: 'assistant', content });
const paragraph = (text: string): DomainMessage => body([{ type: 'paragraph', children: [{ type: 'text', text }] }]);
const compare = (a: DomainMessage, b: DomainMessage, assets: DomainAsset[] = []) => differences(canonicalMessage(a, assets), canonicalMessage(b, assets));

function envelope(raw = geminiDetailGen('G_DUAL_AUDIT_01')) {
    return { success: true, source: 'batchexecute', data: parseGeminiRpcConversation(raw, { account: fixtureAccount('gemini'), providerId: 'gemini' }) };
}

test('same native response takes independent raw Markdown and structured branches; input is not mutated', () => {
    const evidence = decodeGeminiDetail(geminiDetailGen('G_DUAL_AUDIT_02'));
    const original = structuredClone(evidence);
    const result = auditGeminiEvidence(evidence);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].status, 'match');
    assert.deepEqual(evidence, original);
    const divergence = auditGeminiEvidence(decodeGeminiDetail(geminiDetailGen('G_DUAL_AUDIT_03'))).messages[0];
    assert.equal(divergence.status, 'different');
    assert.equal(divergence.classification, 'content_or_metadata');
    assert.equal(divergence.rawMarkdown, 'Independent raw Markdown');
    assert.ok(JSON.stringify(divergence.structured).includes('Hello'));
    assert.ok(JSON.stringify(divergence.markdown).includes('Independent raw Markdown'));
});

test('adapter rejection cannot pass by comparing fallback Markdown with itself', () => {
    const evidence = decodeGeminiDetail(geminiDetailGen('G_DUAL_AUDIT_04'));
    evidence.messages[1].structuredContent = { children: [{ nodeType: 'future-node' }] } as unknown as NonNullable<typeof evidence.messages[1]['structuredContent']>;
    const reply = auditGeminiEvidence(evidence).messages[0];
    assert.equal(reply.status, 'structured_unavailable');
    assert.equal(reply.structured, null);
    assert.equal(reply.canonicalStructured, null);
    assert.deepEqual(reply.differences, []);
    assert.ok(JSON.stringify(reply.reason).includes('adapter_rejected'));
    assert.ok(JSON.stringify(reply.markdown).includes('Hello'));
});

test('forcing Markdown retains native file-chip provenance without leaking native body text', () => {
    const evidence = decodeGeminiDetail(geminiDetailGen('G_DUAL_AUDIT_05'));
    evidence.messages[1].groundingCitationMarkers = ['[cite: 1]'];
    const reply = auditGeminiEvidence(evidence).messages[0];
    assert.equal(reply.status, 'different');
    assert.ok(JSON.stringify(reply.markdown.content).includes('Independent answer'));
    assert.ok(!JSON.stringify(reply.markdown.content).includes('Native answer'));
    assert.ok(!JSON.stringify(reply.markdown.content).includes('citationRef'));
    assert.ok(reply.markdown.citations?.some(citation => citation.title === 'test_config.json'));
});

test('wire decode rejection and absent native document are unavailable, never match', () => {
    for (const key of ['G_DUAL_AUDIT_06', 'G_DUAL_AUDIT_07'] as const) {
        const result = auditGeminiEvidence(decodeGeminiDetail(geminiDetailGen(key))).messages[0];
        assert.equal(result.status, 'structured_unavailable');
        assert.equal(result.structured, null);
    }
});

test('empty native document with nonempty Markdown is rejected, truly empty image response is comparable', () => {
    assert.equal(auditGeminiEvidence(decodeGeminiDetail(geminiDetailGen('G_DUAL_AUDIT_08'))).messages[0].status, 'structured_unavailable');
    const evidence = decodeGeminiDetail(geminiDetailGen('G_DUAL_AUDIT_09'));
    evidence.messages[1].structuredContent = { children: [] };
    evidence.messages[1].content = '';
    assert.equal(auditGeminiEvidence(evidence).messages[0].status, 'match');
});

test('prose whitespace, CRLF and adjacent text segmentation normalize; words and punctuation do not', () => {
    const segmented = body([{ type: 'paragraph', children: [{ type: 'text', text: 'a\r\n' }, { type: 'text', text: ' b' }] }]);
    assert.deepEqual(compare(segmented, paragraph('a b')), []);
    assert.notDeepEqual(compare(paragraph('ab'), paragraph('a b')), []);
    assert.notDeepEqual(compare(paragraph('hello!'), paragraph('hello')), []);
});

test('code indentation, trailing whitespace and line order stay significant; line endings normalize', () => {
    const code = (text: string) => body([{ type: 'code', code: text, language: 'python' }]);
    assert.deepEqual(compare(code('if x:\r\n    run()'), code('if x:\n    run()')), []);
    for (const changed of ['if x:\nrun()', 'if x:\n    run() ', '    run()\nif x:']) assert.notDeepEqual(compare(code('if x:\n    run()'), code(changed)), []);
});

test('formula text is compared literally; inline/display distinction remains a separate structural difference', () => {
    const display = body([{ type: 'math', source: 'x + y' }]);
    const inline = body([{ type: 'paragraph', children: [{ type: 'inlineMath', source: 'x + y' }] }]);
    const a = canonicalMessage(display, []), b = canonicalMessage(inline, []);
    assert.notDeepEqual(differences(a, b), []);
    assert.deepEqual(semanticContent(a), semanticContent(b));
    assert.notDeepEqual(compare(display, body([{ type: 'math', source: 'y + x' }])), []);
});

test('heading and bold wrappers are classified as structural, while preserving their full trees', () => {
    const a = canonicalMessage(body([{ type: 'heading', level: 2, children: [{ type: 'strong', children: [{ type: 'text', text: 'Title' }] }] }]), []);
    const b = canonicalMessage(paragraph('Title'), []);
    assert.notDeepEqual(differences(a, b), []);
    assert.deepEqual(semanticContent(a), semanticContent(b));
});

test('table cells and their order cannot collapse into matching concatenated text', () => {
    const table = (cells: string[]) => body([{ type: 'table', rows: [{ cells: cells.map(text => ({ children: [{ type: 'text', text }] })) }] }]);
    assert.notDeepEqual(compare(table(['a', 'bc']), table(['ab', 'c'])), []);
    assert.notDeepEqual(compare(table(['a', 'b']), table(['b', 'a'])), []);
    assert.notDeepEqual(semanticContent(canonicalMessage(table(['a', 'bc']), [])), semanticContent(canonicalMessage(table(['ab', 'c']), [])));
});

test('link destinations, file citations and resource identities remain significant', () => {
    const link = (href: string) => body([{ type: 'paragraph', children: [{ type: 'link', href, children: [{ type: 'text', text: 'same label' }] }] }]);
    assert.notDeepEqual(compare(link('https://example.com/a'), link('https://example.com/b')), []);
    const citation = (id: string, title: string): DomainMessage => ({ ...body([{ type: 'paragraph', children: [{ type: 'citationRef', citationId: id }] }]), citations: [{ id, title }] });
    assert.deepEqual(compare(citation('one', 'source.json'), citation('two', 'source.json')), []);
    assert.notDeepEqual(compare(citation('one', 'source.json'), citation('one', 'other.json')), []);
    const image = (id: string) => body([{ type: 'image', assetId: id }]);
    const assets: DomainAsset[] = [{ id: 'one', kind: 'image', sourceUri: 'https://example.com/a.png' }, { id: 'two', kind: 'image', sourceUri: 'https://example.com/a.png' }, { id: 'three', kind: 'image', sourceUri: 'https://example.com/b.png' }];
    assert.deepEqual(compare(image('one'), image('two'), assets), []);
    assert.notDeepEqual(compare(image('one'), image('three'), assets), []);
    assert.notDeepEqual(compare({ ...paragraph('same'), attachmentIds: ['one'] }, { ...paragraph('same'), attachmentIds: [] }, assets), []);
});

test('raw RPC framing and captured inner payload provenance are distinguished; DOM/cache is rejected', () => {
    const raw = readGeminiAuditInput(geminiDetailGen('G_DUAL_AUDIT_10'), 'raw_rpc');
    const captured = readGeminiAuditInput(JSON.stringify(envelope()), 'native_envelope');
    assert.equal(raw.provenance, 'raw_rpc');
    assert.equal(captured.provenance, 'captured_decoded_payload');
    assert.deepEqual(raw.evidence.messages, captured.evidence.messages);
    for (const source of ['dom', 'cache']) assert.throws(() => readGeminiAuditInput(JSON.stringify({ ...envelope(), source }), 'native_envelope'), /batchexecute/);
    assert.throws(() => readGeminiAuditInput(JSON.stringify({ success: true, source: 'batchexecute', data: {} }), 'native_envelope'), /envelope/);
});

test('offline reports retain source hash and every diff; incomplete pagination, missing turns, errors and empty sources fail', () => {
    const root = mkdtempSync(join(tmpdir(), 'gemini-dual-'));
    const input = join(root, 'native'), output = join(root, 'report');
    mkdirSync(input);
    try {
        const file = join(input, 'sample.json');
        writeFileSync(file, JSON.stringify(envelope()));
        assert.equal(runAudit(input, output).passed, true);
        const mismatch = envelope();
        mismatch.data.conversation.detail.messages.push({ role: 'assistant', content: [] });
        writeFileSync(file, JSON.stringify(mismatch));
        let result = runAudit(input, output);
        assert.equal(result.passed, false);
        assert.equal(result.counts.incomplete, 1);
        assert.equal(result.counts.expectedAssistant, 2);
        writeFileSync(file, JSON.stringify(envelope(geminiDetailGen('G_DUAL_AUDIT_11'))));
        result = runAudit(input, output);
        assert.equal(result.counts.different, 1);
        const report = JSON.parse(readFileSync(join(output, 'sample.json.audit.json'), 'utf8'));
        assert.match(report.sha256, /^[a-f0-9]{64}$/);
        assert.ok(report.messages[0].differences.length > 0);
        assert.equal(readFileSync(join(output, report.sourceFile), 'utf8'), readFileSync(file, 'utf8'));
        const evidence = decodeGeminiDetail(geminiDetailGen('G_DUAL_AUDIT_12'));
        evidence.nextPageToken = 'tC_next';
        assert.equal(auditGeminiEvidence(evidence).complete, false);
        evidence.nextPageToken = null;
        evidence.turnsRejected = 1;
        assert.equal(auditGeminiEvidence(evidence).complete, false);
        writeFileSync(file, '{}');
        assert.equal(runAudit(input, output).counts.errors, 1);
        writeFileSync(file, JSON.stringify(envelope(geminiDetailGen('G_DUAL_AUDIT_13'))));
        assert.equal(runAudit(input, output).counts.structuredUnavailable, 1);
        writeFileSync(file, JSON.stringify({ ...envelope(), data: {   ...envelope().data, transport: { decodedPayload: [] } } }));
        assert.equal(runAudit(input, output).passed, false);
        assert.throws(() => runAudit(input, input), /outside/);
        assert.throws(() => runAudit(input, join(input, 'report')), /outside/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v2 fetch capture keeps raw framing and validates identity/cursor closure before differential audit', () => {
    const raw = geminiDetailGen('G_DUAL_AUDIT_14');
    const source = { schemaVersion: 1, source: 'raw_rpc_pages', conversationId: 'dualaudit',
        pages: [{ requestCursor: null, text: raw }] };
    const read = (value: unknown) => readGeminiAuditInput(JSON.stringify(value), 'native_envelope');
    const captured = read(source);
    assert.equal(captured.provenance, 'captured_raw_rpc_pages');
    assert.equal(auditGeminiEvidence(captured.evidence).messages[0].status, 'match');
    assert.throws(() => read({ ...source, conversationId: 'other' }), /identity|Invalid/);
    assert.throws(() => read({ ...source, pages: [] }), /Missing/);
    assert.throws(() => read({ ...source, pages: [{ requestCursor: 'missing-first', text: raw }] }), /cursor chain/);
    assert.throws(() => read({ ...source, pages: [...source.pages, ...source.pages] }), /cursor chain/);
    assert.throws(() => read({ ...source, pages: [{ requestCursor: null, text: 'bad response' }] }), /Invalid|parse|invalid/);
});

test('v2 native page audit requires every requested cursor and merges oldest-to-newest without duplicate turns', () => {
    const page = (name: string, next: string | null) => {
        const raw = JSON.parse(geminiDetailGen('G_DUAL_AUDIT_15'));
        const inner = JSON.parse(raw[0][2]);
        inner[0][0][0][1] = `r_${name}`;
        inner[0][0][3][0][0][0] = `rc_${name}`;
        inner[1] = next;
        raw[0][2] = JSON.stringify(inner);
        return JSON.stringify(raw);
    };
    const newest = page('new', 'tC_older'); const oldest = page('old', null);
    assert.equal(decodeGeminiDetail(newest).nextPageToken, 'tC_older');
    const source = {schemaVersion:1,source:'raw_rpc_pages',conversationId:'dualaudit',pages:[
        {requestCursor:null,text:newest},{requestCursor:'tC_older',text:oldest},
    ]};
    const read = (value: unknown) => readGeminiAuditInput(JSON.stringify(value), 'native_envelope');
    const result = read(source);
    assert.equal(result.evidence.messages.length,4);
    assert.deepEqual(result.evidence.messages.map(message => message.id),[
        ...decodeGeminiDetail(oldest).messages.map(message => message.id),
        ...decodeGeminiDetail(newest).messages.map(message => message.id),
    ]);
    assert.throws(() => read({...source,pages:source.pages.slice(0,1)}), /incomplete/);
    assert.throws(() => read({...source,pages:[source.pages[0],{...source.pages[1],requestCursor:'tC_wrong'}]}), /cursor chain/);
});
