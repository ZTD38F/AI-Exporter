import { createDocumentReader } from '../src/l1/parsers/gemini/rpc/sourceAttachments.js';
import type { GeminiMessageEvidence } from '../src/l1/parsers/gemini/rpc/detailEvidence.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseList } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
import { decodeGeminiDetail, findTurnsDeep } from '../src/l1/parsers/gemini/rpc/detailDecoder.js';
import { robustFirstPayload, extractModelCandidates, decodeTurn, extractCandidateText, extractThoughts, extractCitations } from '../src/l1/parsers/gemini/rpc/extractors.js';
import { extractInnerPayload, extractNextPageToken } from '../src/l1/parsers/gemini/rpc/payload.js';
import { extractImages, extractUserFiles, extractDocumentsMeta } from './helpers/recordFixture/attachments.js';
import { decodeGeminiStructuredPayload, type GeminiStructuredDocument } from '../src/l1/parsers/gemini/rpc/structuredContent.js';
import { decodeGeminiTurn, decodeGeminiUserResources, decodeGeminiCandidateResources } from '../src/l1/parsers/gemini/rpc/turnResources.js';
import { structuredBodyAttachments } from '../src/l1/parsers/gemini/shared/contentAdapter.js';
import { extractResponseImageEvidence } from '../src/l1/parsers/gemini/rpc/sourceAttachments.js';

// Synthetic boundary probes based on existing gemini_parser/parse_observability
// fixtures; they characterize current behavior, not new wire compatibility.
// The final test reuses sanitized Tier-2 wire evidence from PR #705.
const ID = 'c_boundary12345678';
function turn(prompt = 'Boundary user prompt', seconds: number | null = 1700000000, candidates: unknown[] = [['rc_boundary', [['Boundary model answer'], 'en']]]): unknown[] {
    return [[ID, 'r_AB12'], seconds === null ? null : [seconds, 500000000], [[prompt]], [candidates]];
}

test('wire framing: complete chunks survive a malformed chunk and an unfinished tail', () => {
    const first = ['wrb.fr', 'MaZiqc', '[["quoted [bracket] and \\"escape\\""]]'];
    const second = ['wrb.fr', 'hNvQHb', '[]'];
    const input = geminiListGen('G_BOUNDARY_FRAMING_MIXED_01');
    assert.deepEqual(robustFirstPayload(input), [first, second]);
    assert.deepEqual(robustFirstPayload('[["closed string"'), [['closed string']]);
    assert.equal(robustFirstPayload('[["unfinished'), null);
    assert.equal(robustFirstPayload('{"not":"an array"}'), null);
});

test('inner payload decoding does not yet validate the decoded shape', () => {
    for (const [inner, key] of [
        [null, 'G_BOUNDARY_DETAIL_INNER_NULL_01'],
        [[], 'G_BOUNDARY_DETAIL_INNER_ARRAY_01'],
        [{ unexpected: true }, 'G_BOUNDARY_DETAIL_INNER_OBJECT_01'],
        [42, 'G_BOUNDARY_DETAIL_INNER_NUMBER_01'],
        ['scalar', 'G_BOUNDARY_DETAIL_INNER_SCALAR_01'],
    ] as const) {
        const innerStr = JSON.stringify(inner);
        const top: unknown = JSON.parse(geminiDetailGen(key));
        assert.deepEqual(extractInnerPayload(top, { rpcId: 'hNvQHb' }), {
            inner, innerStr, isStandardWrb: true, bardError: null
        });
    }
    const brokenTop: unknown = JSON.parse(geminiDetailGen('G_BOUNDARY_DETAIL_INNER_BROKEN_01'));
    assert.deepEqual(extractInnerPayload(brokenTop, { rpcId: 'hNvQHb' }), {
        inner: null, innerStr: '[broken', isStandardWrb: true, bardError: null
    });
});

test('list: official timestamp and count slots win while extra fields survive only in raw evidence', () => {
    const row = [ID, 'Boundary title - Gemini', [1690000000], [1680000000], 2, [1700000000, 500000000], null, { extra: true }, null, 7];
    const inner = [null, [row], null, null, 'tC_fallback_cursor', { future: true }];
    const parsed = parseList(geminiListGen('G_BOUNDARY_LIST_SLOTS_01'));
    assert.deepEqual(parsed.conversations, [{
        id: 'boundary12345678', title: 'Boundary title - Gemini', titleSource: 'provider',
        createdAt: 1680000000000, updatedAt: 1700000000500
    }]);
    assert.equal(parsed.nextPageToken, 'tC_fallback_cursor');
    assert.deepEqual(parsed._raw, inner);
});

test('list: null rows, truncated rows and malformed titles retain current defaults', () => {
    const ids = ['c_missingtitle123', 'c_nulltitle123456', 'c_objecttitle1234', 'c_blanktitle12345'];
    const parsed = parseList(geminiListGen('G_BOUNDARY_LIST_01'));
    assert.deepEqual(parsed.conversations.map(c => [c.id, c.title, c.titleSource, c.updatedAt, c.messageCount]), [
        [ids[0].slice(2), '', 'provider', undefined, undefined],
        [ids[1].slice(2), '', 'provider', undefined, undefined],
        [ids[2].slice(2), '', 'provider', undefined, undefined],
        [ids[3].slice(2), '', 'provider', undefined, undefined]
    ]);
    assert.equal(parseList(geminiListGen('G_BOUNDARY_LIST_02')).conversations[0].title, 'Secondary title');
});

test('missing or malformed envelopes distinguish list diagnostics from detail failures', () => {
    for (const text of [
        geminiListGen('G_BOUNDARY_LIST_EMPTY_TEXT_01'),
        geminiListGen('G_BOUNDARY_LIST_INVALID_JSON_01'),
        geminiListGen('G_BOUNDARY_LIST_EMPTY_JSON_01'),
        geminiListGen('G_BOUNDARY_LIST_BAD_DETAIL_01'),
        geminiListGen('G_BOUNDARY_LIST_BAD_INNER_01'),
    ]) {
        const list = parseList(text);
        assert.deepEqual(list.conversations, []);
        assert.equal(list.nextPageToken, null);
        assert.equal(list._debug!.error, 'NO_INNER_STR');
    }
    for (const text of [
        geminiDetailGen('G_BOUNDARY_DETAIL_EMPTY_TEXT_01'),
        geminiDetailGen('G_BOUNDARY_DETAIL_EMPTY_JSON_01'),
        geminiDetailGen('G_BOUNDARY_DETAIL_RPC_NULL_01'),
        geminiDetailGen('G_BOUNDARY_DETAIL_RPC_FALSE_01'),
    ]) assert.throws(() => decodeGeminiDetail(text), /detail parse fail: invalid/);
    const empty = decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_DETAIL_RPC_EMPTY_01'), ID);
    assert.equal(empty.id, ID);
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.titleSource, 'default');
    assert.equal(Object.hasOwn(empty, 'timestamp'), false);
    assert.equal(empty.schemaDrift, undefined);
    assert.equal(empty._debug!.turnsLen, 0);
    const emptyList = parseList(geminiListGen('G_BOUNDARY_LIST_03'));
    assert.deepEqual(emptyList.conversations, []);
    assert.equal(emptyList.nextPageToken, 'tC_empty_page');
    assert.equal(emptyList._debug, undefined);
});

test('detail: reverse wire ordering, candidates and authoritative timestamps remain stable', () => {
    const parsed = decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_DETAIL_01'));
    assert.equal(parsed.id, ID);
    assert.deepEqual(parsed.messages.map(m => [m.role, m.content]), [
        ['user', 'Oldest prompt'], ['model', 'Old answer'], ['user', 'Newest prompt'], ['model', 'First variant']
    ]);
    assert.equal(parsed.messages[0].providerRequestId, 'r_AB12');
    assert.equal(parsed.messages[1].id, 'rc_old');
    assert.equal(Object.hasOwn(parsed, 'createdAt'), false);
    assert.equal(parsed.updatedAt, null, 'detail-only wire lacks a conversation metadata version');
    assert.equal(parsed.messages.at(-1)?.timestamp, 1700000010500);
    assert.equal(Object.hasOwn(parsed, 'chatTime'), false);
    assert.equal(parsed.nextPageToken, 'tC_detail_cursor');
    assert.equal(Object.hasOwn(parsed, 'titles'), false);
    assert.equal(parsed.schemaDrift, undefined);
});

test('detail: absent optional fields and truncated candidates do not fabricate messages or timestamps', () => {
    for (const [key, expected] of [
        ['G_BOUNDARY_DETAIL_02', ['User only prompt']],
        ['G_BOUNDARY_DETAIL_03', ['Model only answer']],
    ] as const) {
        const parsed = decodeGeminiDetail(geminiDetailGen(key));
        assert.deepEqual(parsed.messages.map(m => m.content), expected);
        assert.equal(Object.hasOwn(parsed, 'timestamp'), false);
        assert.equal(Object.hasOwn(parsed, 'createdAt'), false);
        assert.equal(parsed.attachmentCount, 0);
        assert.equal(parsed.turnsRejected, undefined);
    }
});

test('detail: extra wrapping and renamed envelope use the existing fallback and report envelope drift', () => {
    const wireTurn = turn();
    const wrapped = { additional: { layers: [[[wireTurn]]] }, extra: true };
    assert.deepEqual(findTurnsDeep(wrapped), [wireTurn]);
    const parsed = decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_DETAIL_RENAMED_01'));
    assert.deepEqual(parsed.messages.map(m => m.content), ['Boundary user prompt', 'Boundary model answer']);
    assert.ok(parsed.schemaDrift?.some(w => w.startsWith('Envelope drift:')));
    assert.deepEqual(parsed._debug!.schemaDriftWarnings, parsed.schemaDrift);
    let atLimit: unknown = [wireTurn];
    for (let depth = 0; depth < 6; depth++) atLimit = [atLimit];
    assert.deepEqual(findTurnsDeep(atLimit), [wireTurn]);
    assert.equal(findTurnsDeep([atLimit]), null);
});

test('detail: another RPC cannot supply turns when the matching RPC has no turns', () => {
    const text = geminiDetailGen('G_BOUNDARY_ALTERNATE_RPC_01');
    const parsed = decodeGeminiDetail(text);
    assert.deepEqual(parsed.messages, []);
    assert.deepEqual(parsed._raw, [null]);
    assert.ok(parsed.schemaDrift?.some(w => w.startsWith('Payload drift:')));
});

test('detail: missing or malformed titles keep the existing newest-wire-prompt fallback', () => {
    for (const key of [
        'G_BOUNDARY_TITLE_UNDEFINED_01', 'G_BOUNDARY_TITLE_NULL_01',
        'G_BOUNDARY_TITLE_EMPTY_01', 'G_BOUNDARY_TITLE_OBJECT_01',
        'G_BOUNDARY_TITLE_BLANK_01', 'G_BOUNDARY_TITLE_SPACE_01',
        'G_BOUNDARY_TITLE_GENERIC_01',
    ] as const) {
        const parsed = decodeGeminiDetail(geminiDetailGen(key));
        assert.equal(parsed.title, 'Newest prompt title');
        assert.equal(parsed.titleSource, 'sniff');
        assert.equal(Object.hasOwn(parsed, 'titles'), false);
    }
    assert.equal(decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_DETAIL_04')).title, 'Flat user prompt title');
});

test('detail: metadata-only and undiscoverable-turn payloads retain distinct drift diagnostics', () => {
    const metadata = decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_DETAIL_05'));
    assert.deepEqual(metadata.messages, []);
    assert.ok(metadata.schemaDrift?.some(w => w.startsWith('metadata-only payload:')));
    assert.deepEqual(metadata._debug!.schemaDriftWarnings, metadata.schemaDrift);
    const missingTurns = decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_DETAIL_06'));
    assert.deepEqual(missingTurns.messages, []);
    assert.ok(missingTurns.schemaDrift?.some(w => w.startsWith('Payload drift:')));
});

test('detail: metadata-only identity and title are decoded once without changing malformed fallbacks', () => {
    const valid = decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_METADATA_TRIMMED_01'));
    assert.deepEqual(valid.metadataConversation, { id: ID, title: 'Metadata title' });
    assert.equal(valid.bodyShape, 'metadata_only');
    assert.deepEqual(valid.messages, []);
    assert.ok(valid.schemaDrift?.some(w => w.startsWith('metadata-only payload:')));

    for (const key of [
        'G_BOUNDARY_METADATA_TITLE_NULL_01',
        'G_BOUNDARY_METADATA_TITLE_NUMBER_01',
        'G_BOUNDARY_METADATA_TITLE_OBJECT_01',
        'G_BOUNDARY_METADATA_TITLE_EMPTY_01',
        'G_BOUNDARY_METADATA_TITLE_BLANK_01',
    ] as const) {
        const parsed = decodeGeminiDetail(geminiDetailGen(key));
        assert.equal(parsed.metadataConversation, undefined);
        assert.equal(parsed.bodyShape, 'metadata_only');
        assert.ok(parsed.schemaDrift?.some(w => w.startsWith('metadata-only payload:')));
    }
    for (const key of [
        'G_BOUNDARY_METADATA_ID_NULL_01',
        'G_BOUNDARY_METADATA_ID_NUMBER_01',
        'G_BOUNDARY_METADATA_ID_REQUEST_01',
        'G_BOUNDARY_METADATA_ID_PREFIX_01',
    ] as const) {
        const parsed = decodeGeminiDetail(geminiDetailGen(key));
        assert.equal(parsed.metadataConversation, undefined);
        assert.ok(!parsed.schemaDrift?.some(w => w.startsWith('metadata-only payload:')));
    }
    const notMetadataOnly = decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_METADATA_NON_METADATA_01'));
    assert.equal(notMetadataOnly.metadataConversation, undefined);
});

test('unidentified metadata cannot become a user message', () => {
    const parsed = decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_DETAIL_07'));
    assert.equal(parsed.turnsRejected, 1);
    assert.ok(!parsed.messages.some(message => message.content === 'Rejected recognizer prompt'));
    assert.ok(parsed.schemaDrift?.some(w => w.includes('Turn ID meta')));
});

test('candidate extraction accepts the compact layout without scanning telemetry as variants', () => {
    const compactCandidate = ['rc_compact', 'Compact answer'];
    const compact = [[ID], null, [], [compactCandidate, 'google', 'S', 6]];
    assert.deepEqual(extractModelCandidates(compact), [['rc_compact', 'Compact answer']]);
    assert.equal(extractCandidateText(['rc_parts', [['Part one', [' + part two'], null, 42], 'en']]), 'Part one + part two');
    for (const candidate of [null, [], ['rc_wrong', { wrong: true }]]) assert.equal(extractCandidateText(candidate), '');
});

const imagesAreRequired: {} extends Pick<GeminiMessageEvidence, 'structuredImages'> ? false : true = true;

test('Turn decoding validates known fields once and honors the selected draft', () => {
    const candidates = [
        ['rc_old', [['Old answer']]],
        ['rc_selected', [['Selected answer']]]
    ];
    const model = [candidates, null, 'google', 'rc_selected'];
    const raw = [[ID, 'r_AB12'], [1700000000, 500000000], [['Prompt']], model];
    const decoded = decodeTurn(raw);
    assert.ok(decoded);
    assert.equal(Object.hasOwn(decoded, 'raw'), false, 'Turn raw array is not an output field');
    assert.equal(decoded.timestamp, 1700000000500);
    assert.equal(decoded.userMessageId, 'r_AB12');
    assert.equal(decoded.fallbackTurnId, 'r_AB12');
    assert.equal(decoded.rawProviderRequestId, 'r_AB12');
    assert.equal(decoded.userText, 'Prompt');
    assert.equal(Object.hasOwn(decoded, 'rawUserPayload'), false, 'User wire evidence stays private to L1 resource decoders');
    assert.equal(decoded.candidate?.index, 1);
    assert.deepEqual(decoded.candidate, {
        source: candidates[1], body: candidates[1][1], index: 1, turnDocument: undefined,
        id: 'rc_selected',
        text: 'Selected answer',
        thoughts: null,
        citations: [],
        sourceAttributions: [],
        groundingCitationMarkers: []
    });

    assert.equal(imagesAreRequired, true);
    const parsed = decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_SELECTED_DRAFT_01'));
    assert.ok(parsed.messages.every(message => Array.isArray(message.structuredImages)));
    const modelMessages = parsed.messages.filter(m => m.role === 'model');
    assert.equal(modelMessages.length, 1);
    assert.equal(modelMessages[0].content, 'Selected answer');
    assert.equal(modelMessages[0].id, 'rc_selected');
    // Source-only evidence retains the provider's original request token.
    for (const message of parsed.messages) {
        assert.equal(message.rawProviderRequestId, 'r_AB12');
        assert.equal(message.providerRequestId, 'r_AB12');
    }
});

test('single Turn decoder closes selected draft and user resources into typed message evidence', () => {
    const candidates: unknown[] = [
        ['rc_old', [['Old answer']]],
        { malformed: true },
        ['rc_selected', [['Selected answer']]]
    ];
    const raw = [[ID, 'r_AB12'], [1700000000, 500000000], [['Prompt']], [candidates, null, 'google', 'rc_selected']];
    const turn = decodeTurn(raw);
    assert.ok(turn);
    const messages = decodeGeminiTurn(turn, raw, createDocumentReader(raw), new Set(), new Set(), ID);
    assert.deepEqual(messages.map(({ role, id, content }) => [role, id, content]), [
        ['user', 'r_AB12', 'Prompt'],
        ['model', 'rc_selected', 'Selected answer']
    ]);
    assert.ok(messages.every(message => !Object.hasOwn(message, 'source')
        && !Object.hasOwn(message, 'body') && !Object.hasOwn(message, 'turnDocument')),
        'downstream message evidence must not expose raw candidate wire slots');
    assert.equal(decodeTurn(null), null);
});

test('Turn Decoder only attributes selected Candidate thoughts, citations and grounding metadata', () => {
    const wrongBody = [
        ['Unselected draft'],
        ['THOUGHT', 'Do not export'],
        ['https://wrong.example/source', 'Wrong source'],
        { '44': [[['[cite: 99]']]] },
    ];
    const source = ['https://selected.example/source', 'Selected source'];
    const selectedBody = [
        ['Selected answer'],
        ['THOUGHT', 'Selected reasoning'],
        source,
        { '44': [[['[cite: 1]']]] },
    ];
    const sourceTable = [null, [[['cited span'], [1], [source], 'spp_selected']]];
    const wrong = ['rc_wrong', wrongBody];
    const selected = ['rc_selected', selectedBody, sourceTable];
    const wire = [[ID, 'r_AB12'], null, [['Question']], [[wrong, selected], null, 'google', 'rc_selected']];
    const decoded = decodeTurn(wire);
    assert.ok(decoded?.candidate);
    assert.equal(decoded.candidate.id, 'rc_selected');
    assert.equal(decoded.candidate?.source, selected);
    assert.equal(decoded.candidate.thoughts, 'Selected reasoning');
    assert.deepEqual(decoded.candidate.citations, [{ url: source[0], title: source[1] }]);
    assert.deepEqual(decoded.candidate.sourceAttributions, [
        { sourceId: 'spp_selected', sources: [{ url: source[0], title: source[1] }] },
    ]);
    assert.deepEqual(decoded.candidate.groundingCitationMarkers, ['[cite: 1]']);
    assert.equal(JSON.stringify(decoded.candidate).includes('wrong.example'), false);

    const malformed = decodeTurn([[ID], null, [], [[['rc_empty', null, { invalid: true }]]]]);
    assert.ok(malformed?.candidate);
    assert.equal(malformed.candidate.thoughts, null);
    assert.deepEqual(malformed.candidate.citations, []);
    assert.deepEqual(malformed.candidate.sourceAttributions, []);
    assert.deepEqual(malformed.candidate.groundingCitationMarkers, []);
});

test('Turn decoder owns text fallbacks without guessing unrelated candidate metadata', () => {
    const fallbackCandidate = ['rc_fallback', { nested: [['Model fallback answer']] }];
    const wire = [[ID, 'r_AB12'], null, [['User prompt']], [[fallbackCandidate]]];
    const decoded = decodeTurn(wire);
    assert.ok(decoded);
    assert.equal(decoded.userText, 'User prompt');
    assert.equal(decoded.candidate?.text, 'Model fallback answer');
    assert.equal(Object.hasOwn(decoded.candidate ?? {}, 'raw'), false);
    assert.equal(decoded.candidate?.body, fallbackCandidate[1]);

    assert.equal(decodeTurn([[ID], null, ['Flat prompt'], null])?.userText, 'Flat prompt');
    assert.equal(decodeTurn([[ID], null, { invalid: true }, null])?.userText, '');
});

test('Turn decoding keeps compact layouts, missing IDs, malformed fields and raw media evidence', () => {
    assert.equal(decodeTurn(null), null);
    const compactCandidate = ['rc_compact', 'Compact answer'];
    const compact = [[ID], null, [], [compactCandidate, 'google', 'S', 6]];
    const single = decodeTurn(compact);
    assert.ok(single);
    assert.equal(single.candidate?.index, 0);
    assert.equal(single.candidate?.id, 'rc_compact');
    assert.equal(single.candidate?.text, 'Compact answer');
    assert.equal(single.candidate?.source, compactCandidate);

    const partialCandidate = [null, [['Text without an ID']]];
    const partial = [[ID], null, [['Prompt']], [[partialCandidate, ['rc_other', [['Other answer']]]]]];
    const decodedPartial = decodeTurn(partial);
    assert.ok(decodedPartial);
    assert.equal(decodedPartial.timestamp, null);
    assert.equal(decodedPartial.rawProviderRequestId, undefined);
    assert.equal(decodedPartial.candidate?.index, 0);
    assert.equal(decodedPartial.candidate?.id, '');
    assert.equal(decodedPartial.candidate?.text, 'Text without an ID');
    assert.equal(decodedPartial.candidate?.source, partialCandidate);
    assert.equal(Object.hasOwn(decodedPartial.candidate ?? {}, 'raw'), false);
    assert.equal(decodeTurn([null, null, null, { malformed: true }]), null);

    const mixedCandidates: unknown[] = [
        ['rc_first', [['Primary answer']]],
        { malformed: true },
        ['rc_target', [['Selected answer']]]
    ];
    const mixed = decodeTurn([[ID], null, [['Prompt']], [mixedCandidates, null, null, 'rc_target']]);
    assert.equal(mixed?.candidate?.index, 2, 'malformed draft must not shift the selected draft index');
    assert.equal(mixed?.candidate?.source, mixedCandidates[2]);
    assert.equal(mixed?.candidate?.text, 'Selected answer');
    assert.equal(decodeTurn([[ID], null, [], [[{ malformed: true }]]])?.candidate, null);

    const rawDocument = [[[null]]];
    const withMedia: unknown[] = [[ID], null, [], [[['rc_media', [['Image prompt']]]]]];
    const modelPayload = withMedia[3];
    if (!Array.isArray(modelPayload)) throw new Error('fixture model payload must be array');
    modelPayload[12] = rawDocument;
    assert.equal(Object.hasOwn(decodeTurn(withMedia) ?? {}, 'rawAnswerDocument'), false);
});

test('Gemini resource decoder consumes raw Turn/Candidate wire slots but exports only typed evidence', () => {
    const wireDocument = [[[Array.from({ length: 35 }, (_v, i) => i === 34 ? ['x^2'] : null)]]];
    const wireCandidate = ['rc_boundary', [['Answer']]];
    const modelPayload: unknown[] = [[wireCandidate]];
    modelPayload[12] = wireDocument;
    const rawTurn: unknown[] = [[ID, 'r_AB12'], null, [['Prompt']], modelPayload];
    const decoded = decodeTurn(rawTurn);
    assert.ok(decoded?.candidate);
    const userResources = decodeGeminiUserResources(rawTurn);
    assert.deepEqual(userResources.images, []);
    assert.deepEqual(userResources.files, []);
    const result = decodeGeminiCandidateResources(
        decoded.candidate, createDocumentReader(rawTurn), new Set(), new Set(), ID
    );
    assert.equal(result.structuredExtraction.status, 'decoded');
    assert.equal(result.generatedFiles.length, 0);
    assert.equal(result.documents.length, 0);
    assert.equal(result.images.length, 0);
    assert.equal(Object.hasOwn(result, 'raw'), false);
    assert.equal(Object.hasOwn(result, 'body'), false);
});

test('thinking and citation helpers ignore malformed nodes, deduplicate URLs and preserve thought order', () => {
    const body = [['Visible answer'], ['THOUGHT', 'First thought'], [null, 'thought-details', 'Second thought'],
        ['THOUGHT', null], ['https://example.com/source', 'First source title'], ['https://example.com/source', 'Duplicate title'],
        ['https://example.com/malformed', 42], ['https://googleusercontent.com/immersive_entry_chip/a', 'Internal chip']];
    assert.equal(extractThoughts(body), 'First thought\n\nSecond thought');
    assert.deepEqual(extractCitations(body), [{ url: 'https://example.com/source', title: 'First source title' }]);
    const parsed = decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_THOUGHT_CITATION_01'));
    const model = parsed.messages.find(m => m.role === 'model');
    assert.equal(model?.content, 'Visible answer');
    assert.equal(model?.thoughts, 'First thought\n\nSecond thought');
    assert.deepEqual(model?.citations, extractCitations(body));
});

test('attachment helpers ignore null, empty and malformed shapes; valid response images remain attachments', () => {
    for (const raw of [null, [], [null, []], { extra: true }, [['broken.png']]]) {
        assert.deepEqual(extractImages(raw), []);
        assert.deepEqual(extractUserFiles(raw), []);
        assert.deepEqual(extractDocumentsMeta(raw), []);
    }
    const url = 'https://lh3.googleusercontent.com/boundary-image';
    const parsed = decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_IMAGE_ATTACHMENT_01'));
    assert.equal(parsed.attachmentCount, 1);
    const model = parsed.messages.find(m => m.role === 'model');
    assert.equal(model?.images?.[0].sourceUrl, url);
    assert.equal(model?.attachments?.[0].type, 'image');
    assert.equal('localName' in model!.attachments![0], false);
    assert.equal(model?.documents, undefined);
});

test('cursor fallback scans extra slots and ignores malformed candidates', () => {
    assert.equal(extractNextPageToken([null, 42, [], { token: 'tC_wrong_shape' }, 'tC_extra']), 'tC_extra');
    assert.equal(extractNextPageToken([null, 'tC_first', 'tC_second']), 'tC_first');
    assert.equal(extractNextPageToken([null, 42, []]), null);
});

test('sanitized Tier-2 wire fixtures retain structured nodes and search images through detail parsing', () => {
    const fixture = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, 'fixtures/provider/structured_rpc', name), 'utf8'));
    const document = fixture('wire-turn-3-12-b-stack.json');
    const decoded = decodeGeminiStructuredPayload(document);
    assert.ok(decoded);
    assert.equal(decoded.children.length, 49);
    assert.equal(decoded.children.filter(node => node.nodeType === 12).length, 13);
    const parsed = decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_CAPTURED_STACK_01'));
    const model = parsed.messages.find(m => m.role === 'model');
    assert.deepEqual(model?.structuredContent, decoded);
    assert.ok(model?.content.includes('CHSH'));
    assert.ok((model?.images?.length ?? 0) > 0);
    assert.equal(parsed.schemaDrift, undefined);
    // A truncated field-12 tree must fall back, retaining the raw answer.
    const fallback = decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_CAPTURED_TRUNCATED_01'))
        .messages.find(m => m.role === 'model');
    assert.equal(fallback?.structuredContent, undefined);
    assert.equal(fallback?.content, model?.content);
});


test('known behavior: an ID-only candidate becomes model content through the single-element fallback', () => {
    // Existing fallback treats a one-element candidate as its text body.
    assert.equal(extractCandidateText(['rc_missing']), 'rc_missing');
    const parsed = decodeGeminiDetail(geminiDetailGen('G_BOUNDARY_DETAIL_08'));
    assert.equal(parsed.messages.find(m => m.role === 'model')?.content, 'rc_missing');
});

test('known behavior: a malformed image tuple is eligible for generic user-file fallback', () => {
    const raw = [['https://lh3.googleusercontent.com/example', 'wrong-width', 200]];
    assert.deepEqual(extractImages(raw), []);
    assert.deepEqual(extractUserFiles(raw), [{
        sourceUrl: 'https://lh3.googleusercontent.com/example', fileName: 'attachment',
        id: 'wrong-width', thumbnailUrl: undefined
    }]);
    assert.deepEqual(extractDocumentsMeta(raw), []);
});


test('response images decode shared wire evidence once and refresh it for the next response', () => {
    const generated: unknown[] = Array(16).fill(null);
    generated[2] = 'generated.png';
    generated[3] = 'https://lh3.googleusercontent.com/generated';
    generated[5] = 'same-image-token';
    generated[11] = 'image/png';
    generated[15] = [512, 512, 1000];
    let snapshots = 0;
    Object.defineProperty(generated, 'toJSON', { value: () => {
        snapshots++;
        return Array.from(generated);
    } });
    const inline = ['https://lh3.googleusercontent.com/preview', 512, 512, 'same-image-token'];
    const body = [inline, generated];
    const candidate = ['rc_images', body];
    const structuredContent: GeminiStructuredDocument = { children: [{ nodeType: 0, images: [{
        sourceUrl: 'https://lh3.googleusercontent.com/generated', token: 'same-image-token', isGenerated: true,
    }] }] };
    const evidence = extractResponseImageEvidence(candidate, [body], '', structuredContent);
    const { images } = evidence;
    assert.equal(snapshots, 1, 'overlapping roots must share the decoded diagnostic snapshot');
    assert.equal(images.length, 1);
    assert.equal(images[0].isGenerated, true);
    assert.equal(structuredBodyAttachments(evidence)[0].src, generated[3]);
    assert.equal(snapshots, 1, 'resource adaptation consumes decoded facts without scanning the structured tree');
    assert.equal(images[0].sourceUrl, generated[3], 'generated source supersedes the inline preview');
    generated[3] = 'https://lh3.googleusercontent.com/updated';
    const updated = extractResponseImageEvidence(candidate, [body, generated], '');
    assert.equal(snapshots, 2, 'evidence belongs to one response extraction');
    assert.equal(updated.images[0].sourceUrl, generated[3]);
});

test('response image evidence reuse preserves visible, inline and metadata-only search image rules', () => {
    const visible = { attachmentType: 36, Kc: 'https://lh3.googleusercontent.com/visible' };
    const inline = { attachmentType: 36, Kc: 'https://lh3.googleusercontent.com/inline' };
    const hidden = { attachmentType: 36, Kc: 'https://lh3.googleusercontent.com/metadata-only' };
    const body = [visible];
    const candidate = ['rc_search', body, [{ ...visible }, inline, hidden]];
    assert.deepEqual(extractResponseImageEvidence(candidate, [body], '').images.map(image => image.sourceUrl), [visible.Kc]);
    assert.deepEqual(extractResponseImageEvidence(candidate, [body], `![inline](${inline.Kc})`).images.map(image => image.sourceUrl),
        [visible.Kc, inline.Kc]);
});
