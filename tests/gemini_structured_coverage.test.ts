import type { GeminiStructuredDocument } from '../src/l1/parsers/gemini/rpc/structuredContent.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeGeminiAnnotation, decodeGeminiStructuredPayload, inspectStructuredContent } from '../src/l1/parsers/gemini/rpc/structuredContent.js';
import { extractResponseImageEvidence, type ImageAttachment } from '../src/l1/parsers/gemini/rpc/sourceAttachments.js';
import { decodeTurn } from '../src/l1/parsers/gemini/rpc/extractors.js';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
import { parseGeminiBody } from '../src/l1/parsers/gemini/shared/contentAdapter.js';
import type { Diagnostic } from '../src/shared/diagnostics/diagnostic.js';

// Captured Tier 2 report, 2026-10-15. Only turn[3][12], no account/transport metadata.
const report: unknown = JSON.parse(readFileSync('tests/fixtures/provider/structured_rpc/live-range-coder.json', 'utf8'));
const fallback = 'MARKDOWN_FALLBACK_SENTINEL';
const textNode = (text: string, flag: number): unknown[] => [null, [null, 0, text, [[0, text.length, [[null, null, null, null, flag]]]]]];
const parse = (key: Parameters<typeof geminiDetailGen>[0]) =>
    parseGeminiRpcConversation(geminiDetailGen(key), { account: fixtureAccount('gemini'), providerId: 'gemini' });

test('captured long report uses structured data through native RPC, not equivalent Markdown fallback', () => {
    const result = parse('G_STRUCTURED_COVERAGE_01');
    const answer = result.conversation.detail.messages.find(message => message.role === 'assistant');
    assert.ok(answer);
    const serialized = JSON.stringify(answer.content);
    assert.ok(!serialized.includes(fallback));
    assert.ok(serialized.includes('fractions.Fraction'));
    assert.ok(serialized.includes('"type":"inlineCode","code":"run_length"'));
    assert.ok(serialized.includes('run\\\\_length'), 'corrected structured math source survives');
    assert.ok(answer.content.some(block => block.type === 'list'));
    assert.ok(answer.content.some(block => block.type === 'math'));
    assert.ok(answer.content.some(block => block.type === 'code'));
    assert.ok(!result.diagnostics.some(d => d.code === 'GEMINI_STRUCTURED_FALLBACK'));
});

test('wire style 3 means inline code, independently of content and container', () => {
    for (const source of ['fractions.Fraction', '范围_😀', 'a*b $c$ \\literal']) {
        assert.deepEqual(decodeGeminiAnnotation([0, source.length, [[null, null, null, null, 3]]]), { start: 0, end: source.length, type: 7 });
        const leaf = textNode(source, 3);
        for (const node of [leaf,
            Object.assign(Array(12).fill(null), { 11: [[[[leaf]]]] }),
            Object.assign(Array(13).fill(null), { 12: [[[[leaf]]], 4] }),
            Object.assign(Array(11).fill(null), { 10: [[[null, [[[leaf]]]]]] }),
        ]) {
            const decoded = decodeGeminiStructuredPayload([[[node]]]);
            assert.ok(decoded);
            const content = parseGeminiBody(fallback, decoded);
            assert.ok(JSON.stringify(content).includes(JSON.stringify({ type: 'inlineCode', code: source })));
            assert.ok(!JSON.stringify(content).includes(fallback));
        }
    }
});

test('source IDs share one validated grammar for object and wire annotations', () => {
    const sourceIds = ['spp_alpha', 'spp_beta-2'];
    assert.deepEqual(decodeGeminiAnnotation({ start: 0, end: 6, type: 'source', sourceIds }), {
        start: 0, end: 6, type: 'source', sourceIds,
    });
    assert.deepEqual(decodeGeminiAnnotation([0, 6, [null, null, null, [null, sourceIds]]]), {
        start: 0, end: 6, type: 'source', sourceIds,
    });
    for (const invalid of [[], ['spp_alpha', 'wrong'], ['spp_alpha', 2], [null]]) {
        assert.equal(decodeGeminiAnnotation({ start: 0, end: 6, type: 'source', sourceIds: invalid }), null);
        assert.equal(decodeGeminiAnnotation([0, 6, [null, null, null, [null, invalid]]]), null);
    }
    assert.equal(decodeGeminiAnnotation([0, 6, [null, null, null, [null, sourceIds], ['unvalidated']]]), null);
});

test('unknown nested annotation retains replay evidence outside Domain content', () => {
    const result = parse('G_STRUCTURED_COVERAGE_02');
    assert.ok(JSON.stringify(result.conversation.detail.messages[1].content).includes(fallback));
    const diagnostic = result.diagnostics.find(d => d.code === 'GEMINI_STRUCTURED_FALLBACK');
    assert.equal(diagnostic?.severity, 'warning');
    const leaf = textNode('PRIVATE_SOURCE_TEXT', 999);
    const list = Object.assign(Array(12).fill(null), { 11: [[[[leaf]]]] });
    const rawDocument = [[[textNode('known', 3), list]]];
    assert.deepEqual(diagnostic?.details, { reason: 'decode_rejected',
        issue: { kind: 'annotation', styleFlag: 999, rawValue: [0, 19, [[null, null, null, null, 999]]],
            path: '/0/0/1/11/0/0/0/0/1/3/0' },
        rawDocument, documentSource: 'turn[3][12]', candidateIndex: 0, fallbackMarkdown: fallback });
    assert.ok(diagnostic?.sourceRef?.providerMessageId);
    assert.ok(JSON.stringify(diagnostic).includes('PRIVATE_SOURCE_TEXT'));
    assert.ok(!JSON.stringify(result.conversation).includes('PRIVATE_SOURCE_TEXT'));
    assert.equal(decodeGeminiStructuredPayload(rawDocument), null, 'saved evidence reproduces rejection');
});

test('unknown wire fields, absent payload, and uncorrelated candidate have distinct outcomes', () => {
    const unknown = Object.assign(Array(14).fill(null), { 13: ['PRIVATE_FILE_REFERENCE'] });
    assert.deepEqual(inspectStructuredContent({
        turnDocument: [[[unknown]]], candidateIndex: 0
    }), {
        status: 'decode_rejected', issue: { kind: 'node', fields: [13], rawValue: unknown, path: '/0/0/0' },
        rawDocument: [[[unknown]]],
    });
    const missing = parse('G_STRUCTURED_COVERAGE_03').diagnostics.find(d => d.code === 'GEMINI_STRUCTURED_FALLBACK');
    assert.deepEqual(missing?.details, { reason: 'missing' });
    assert.equal(missing?.severity, 'info');
    const rawTurn: unknown[] = [null, null, null, Object.assign(Array(13).fill(null), { 12: report })];
    const turn = decodeTurn(rawTurn);
    // An uncorrelated document alone does not establish ownership of a message.
    assert.equal(turn, null);
    assert.equal(inspectStructuredContent({
        turnDocument: report, candidateIndex: 1
    }).status, 'candidate_unmatched');
    assert.equal(inspectStructuredContent({
        turnDocument: report, candidateIndex: 0
    }).status, 'decoded');
    assert.equal(inspectStructuredContent({
        turnDocument: null, candidateIndex: 1
    }).status, 'missing');
    // Unsupported Turn documents must not be treated as absent or successfully decoded.
    assert.deepEqual(inspectStructuredContent({
        turnDocument: { unsupported: true }, candidateIndex: 0
    }), { status: 'decode_rejected', issue: { kind: 'payload', rawValue: { unsupported: true }, path: '' },
        rawDocument: { unsupported: true } });
});

test('unknown field 6 retains its full payload and parent document through JSON export', () => {
    const rejectedNode = [null, null, null, null, null, null,
        { label: 'Synthetic shop', url: 'https://example.com/shop', nested: ['营业时间', 23, true] }];
    const rawDocument = [[[textNode('known', 3), rejectedNode]]];
    const extraction = inspectStructuredContent({ turnDocument: rawDocument, candidateIndex: 0 });
    assert.deepEqual(JSON.parse(JSON.stringify(extraction)), { status: 'decode_rejected',
        issue: { kind: 'node', fields: [6], rawValue: rejectedNode, path: '/0/0/1' }, rawDocument });
    assert.equal(decodeGeminiStructuredPayload(rawDocument), null);
    const supported = { children: [{ nodeType: 18, text: 'supported' }] };
    assert.deepEqual(inspectStructuredContent({ turnDocument: supported, candidateIndex: 0 }),
        { status: 'decoded', document: supported }, 'successful decoding adds no raw evidence');
});

test('adapter rejection remains visible and preserves complete Markdown body', () => {
    const diagnostics: Diagnostic[] = [];
    const malformed: GeminiStructuredDocument = { children: [{ nodeType: 18, text: 'abc', annotations: [{ start: 0, end: 99, type: 7 }] }] };
    const content = parseGeminiBody(fallback, malformed, { diagnostics, sourceRef: { providerId: 'gemini', providerMessageId: 'rc_bad' } });
    assert.ok(JSON.stringify(content).includes(fallback));
    assert.deepEqual(diagnostics[0].details, { reason: 'adapter_rejected',
        structuredDocumentJson: JSON.stringify(malformed), fallbackMarkdown: fallback });
    const replay: GeminiStructuredDocument = JSON.parse(JSON.stringify(malformed));
    const replayDiagnostics: Diagnostic[] = [];
    assert.deepEqual(parseGeminiBody(fallback, replay, { diagnostics: replayDiagnostics,
        sourceRef: { providerId: 'gemini' } }), content);
    assert.equal(replayDiagnostics[0].code, 'GEMINI_STRUCTURED_FALLBACK');
    assert.equal(diagnostics[0].sourceRef?.providerMessageId, 'rc_bad');
});


test('Gemini structured attachments expose decoded image facts and ignore UI-chip metadata', () => {
    const search = {
        attachmentType: 36,
        title: 'Source image',
        Kc: 'https://lh3.googleusercontent.com/structured-image-source',
        imageWidth: 640,
        imageHeight: 480,
        customFields: { flags: [null, true, 3, 'source'], nested: { value: 'retained' } },
    };
    const chip = {
        attachmentType: 22,
        message: 'Related questions',
        items: [{ label: 'What next?', query: 'Explain more' }],
    };
    const decoded = decodeGeminiStructuredPayload({ children: [
        { nodeType: 0, Xj: [search] },
        { nodeType: 0, Xj: [chip] },
    ] });
    assert.ok(decoded);
    const [imageNode, chipNode] = decoded.children;
    assert.equal(imageNode.nodeType, 0);
    assert.equal(chipNode.nodeType, 0);
    if (imageNode.nodeType !== 0 || chipNode.nodeType !== 0) throw new Error('Expected attachment nodes');
    const typedImages: ImageAttachment[] | undefined = imageNode.images;
    assert.equal(typedImages?.[0].sourceUrl, search.Kc);
    assert.deepEqual(chipNode.images, []);
    const images = extractResponseImageEvidence([], [], '', decoded).structuredImages;
    assert.equal(images.length, 1, 'search result retains its image, UI chip contributes no image');
    assert.equal(images[0].title, 'Source image');
    assert.equal(images[0].width, 640);
    assert.equal(images[0].height, 480);
});

test('Gemini structured attachments reject non-JSON nested metadata at ingress', () => {
    const raw = (entry: unknown) => ({ children: [{ nodeType: 0, Xj: [entry] }] });
    assert.equal(decodeGeminiStructuredPayload(raw({ attachmentType: 36, nested: { extra: undefined } })), null);
    assert.equal(decodeGeminiStructuredPayload(raw({ attachmentType: 36, values: [1, () => 2] })), null);
    assert.equal(decodeGeminiStructuredPayload(raw({ attachmentType: 36, width: Number.POSITIVE_INFINITY })), null);
    assert.deepEqual(decodeGeminiStructuredPayload({ children: [{ nodeType: 0 }] })?.children, [{ nodeType: 0 }]);
});

test('captured Imagen envelope retains resource panels and closes exactly one native image asset', () => {
    const panel: unknown = JSON.parse(readFileSync('tests/fixtures/provider/structured_rpc/live-imagen-panel.json', 'utf8'));
    const decoded = decodeGeminiStructuredPayload(panel);
    assert.ok(decoded);
    assert.equal(decoded.children.length, 1);
    assert.equal(decoded.children[0].nodeType, 0);
    assert.ok(decoded.children[0].nodeType === 0 && decoded.children[0].images?.some(image => image.isGenerated), 'generated image facts are decoded at attachment ingress');
    const result = parseGeminiRpcConversation(geminiDetailGen('G_STRUCTURED_COVERAGE_04'), { account: fixtureAccount('gemini'), providerId: 'gemini' });
    assert.equal(result.conversation.detail.assets.length, 1);
    assert.equal(result.conversation.detail.assets[0].kind, 'image');
    assert.equal(result.conversation.detail.assets[0].name, 'fixture.jpg');
    assert.ok(!result.diagnostics.some(d => d.code === 'GEMINI_STRUCTURED_FALLBACK'));
    assert.ok(!JSON.stringify(result.conversation.detail.messages[1].content).includes('fixture metadata'));
});

test('unproven Imagen envelopes and incomplete/ambiguous panels still reject', () => {
    const panel = JSON.parse(readFileSync('tests/fixtures/provider/structured_rpc/live-imagen-panel.json', 'utf8')) as unknown[][];
    panel[1] = ['unrecognized metadata'];
    assert.equal(decodeGeminiStructuredPayload(panel), null);
    const node: unknown[] = Array(10).fill(null);
    node[9] = [[[[], ['http://googleusercontent.com/image_generation_content/0_fixture']]]];
    assert.equal(decodeGeminiStructuredPayload([[[node]]]), null, 'no inferred image without a proven image file');
    const valid = JSON.parse(readFileSync('tests/fixtures/provider/structured_rpc/live-imagen-panel.json', 'utf8'));
    valid[0][0][0][8] = 'unknown body';
    assert.equal(decodeGeminiStructuredPayload(valid), null, 'do not hide another populated wire field');
});
