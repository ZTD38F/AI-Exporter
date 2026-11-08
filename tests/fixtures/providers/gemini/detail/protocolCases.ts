import { describeFixtures, synthetic, derived } from '../../provenance.js';
import { domainCapturedStructuredWire, boundaryCapturedDocumentWire } from './content.js';
import { mixedNativePage, parserBundledTitleWire } from './integration.js';
import { DOMAIN_ID, rpc, emptyTurnWire, domainTurn, admissionWire, observabilityTurn, observabilityDocumentTurn, BOUNDARY_ID, boundaryTurn, selectedCandidates, selectedWire, p1RegressionTurn, boundaryTop, boundaryTitleWire, boundarySelectedDraftWire, p1BadLeadingDetailWire } from './protocol.js';

export const protocolCases = {
    'G_DISPATCH_MIXED_01': () => JSON.stringify([
        ['wrb.fr', 'MaZiqc', JSON.stringify([null, [[BOUNDARY_ID, 'Dispatch title', null, null, null, [1700000010, 0]]], null])],
        ['wrb.fr', 'hNvQHb', JSON.stringify([[boundaryTurn()]])],
    ]),
    'G_DISPATCH_CHUNKED_01': () => ")]}'\n42\n" + JSON.stringify([
        ['wrb.fr', 'MaZiqc', JSON.stringify([null, [], null])],
    ]) + '\n[malformed]\n64\n' + rpc([[boundaryTurn()]]) + '\n[["unfinished',
    'G_DISPATCH_DECOY_01': () => JSON.stringify([
        ['wrb.fr', 'otherRpc', JSON.stringify([[boundaryTurn('Mention MaZiqc and hNvQHb as text')]])],
    ]),
    'G_DISPATCH_DETAIL_ERROR_01': () => JSON.stringify([
        ['wrb.fr', 'hNvQHb', null, null, null, ['BardErrorInfo', 1167]],
        ['wrb.fr', 'otherRpc', JSON.stringify([[boundaryTurn()]])],
    ]),
    'G_PARSER_CONTRACT_MALFORMED_DETAIL_01': () => '[]',
    'G_DETAIL_NATIVE_TRANSPORT_EMPTY_01': () => '',
    'G_DETAIL_NATIVE_TRANSPORT_NON_JSON_01': () => 'not JSON',
    'G_DETAIL_NATIVE_TRANSPORT_NULL_01': () => 'null',
    'G_DETAIL_NATIVE_TRANSPORT_EMPTY_BATCH_01': () => '[]',
    'G_BOUNDARY_SELECTED_DRAFT_01': () => boundarySelectedDraftWire(),
    'G_BOUNDARY_CAPTURED_STACK_01': () => boundaryCapturedDocumentWire(),
    'G_BOUNDARY_CAPTURED_TRUNCATED_01': () => boundaryCapturedDocumentWire(true),
    'G_GEMINI_PARSER_MIXED_TITLE_01': () => parserBundledTitleWire(),
    'G_P1E_LEADING_DECOY_DETAIL_01': () => p1BadLeadingDetailWire(),
    'G_RPC_DOMAIN_CAPTURED_STACK_01': () => domainCapturedStructuredWire(),
    'G_BOUNDARY_DETAIL_INNER_NULL_01': () => boundaryTop(null),
    'G_BOUNDARY_DETAIL_INNER_ARRAY_01': () => boundaryTop([]),
    'G_BOUNDARY_DETAIL_INNER_OBJECT_01': () => boundaryTop({ unexpected: true }),
    'G_BOUNDARY_DETAIL_INNER_NUMBER_01': () => boundaryTop(42),
    'G_BOUNDARY_DETAIL_INNER_SCALAR_01': () => boundaryTop('scalar'),
    'G_BOUNDARY_DETAIL_INNER_BROKEN_01': () => JSON.stringify([['wrb.fr', 'hNvQHb', '[broken']]),
    'G_BOUNDARY_DETAIL_EMPTY_TEXT_01': () => '',
    'G_BOUNDARY_DETAIL_EMPTY_JSON_01': () => '[]',
    'G_BOUNDARY_DETAIL_RPC_NULL_01': () => rpc(null),
    'G_BOUNDARY_DETAIL_RPC_FALSE_01': () => rpc(false),
    'G_BOUNDARY_DETAIL_RPC_EMPTY_01': () => rpc([]),
    'G_BOUNDARY_DETAIL_RENAMED_01': () => {
        const wireTurn = boundaryTurn();
        const wrapped = { additional: { layers: [[[wireTurn]]] }, extra: true };
        return ")]}'\n\n" + JSON.stringify([['renamedEnvelope', 'renamedRpc', JSON.stringify(wrapped)]]);
    },
    'G_BOUNDARY_TITLE_UNDEFINED_01': () => boundaryTitleWire(undefined),
    'G_BOUNDARY_TITLE_NULL_01': () => boundaryTitleWire(null),
    'G_BOUNDARY_TITLE_EMPTY_01': () => boundaryTitleWire([]),
    'G_BOUNDARY_TITLE_OBJECT_01': () => boundaryTitleWire({ title: 'wrong shape' }),
    'G_BOUNDARY_TITLE_BLANK_01': () => boundaryTitleWire(''),
    'G_BOUNDARY_TITLE_SPACE_01': () => boundaryTitleWire('  '),
    'G_BOUNDARY_TITLE_GENERIC_01': () => boundaryTitleWire('Google Gemini'),
    'G_NATIVE_CALLERS_MIXED_01': () => mixedNativePage('r_new', 1700000010, 'tC_older'),
    'G_NATIVE_CALLERS_MIXED_02': () => mixedNativePage('r_old', 1700000000),
    'G_NATIVE_CALLERS_MIXED_03': () => mixedNativePage('r_one', 1700000000, 'tC_repeat'),
    'G_NATIVE_CALLERS_MIXED_04': () => mixedNativePage('r_native', 1700000000, 'tC_old'),
    'G_NATIVE_CALLERS_MIXED_05': () => mixedNativePage('r_older', 1700000000),
    'G_NATIVE_CALLERS_MIXED_06': () => mixedNativePage('r_newer', 1700000010, 'tC_retry_older'),
    'G_NATIVE_CALLERS_MIXED_07': () => mixedNativePage('r_newer', 1700000010, 'tC_retry_older'),
    'G_NATIVE_ACQ_MIXED_01': () => mixedNativePage('r_new', 1700000010, 'tC_older'),
    'G_NATIVE_ACQ_MIXED_02': () => mixedNativePage('r_old', 1700000000),
    'G_NATIVE_ACQ_MIXED_03': () => mixedNativePage('r_one', 1700000000, 'tC_repeat'),
    'G_NATIVE_ACQ_MIXED_04': () => mixedNativePage('r_native', 1700000000, 'tC_old'),
    'G_NATIVE_ACQ_MIXED_05': () => mixedNativePage('r_older', 1700000000),
    'G_NATIVE_ACQ_MIXED_06': () => mixedNativePage('r_newer', 1700000010, 'tC_retry_older'),
    'G_NATIVE_ACQ_MIXED_07': () => mixedNativePage('r_newer', 1700000010, 'tC_retry_older'),
    'G_DYNAMIC_TITLE_ARBITRATION_DETAIL_01': () => {
        const turn = [['c_sniff_test_chat_888', 'r_question'], [1700000000, 0],
            [['如何构建高性能分布式缓存系统？']], [[['rc_question', [['构建高性能分布式缓存需要注意这些要点']]]]]];
        return JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[turn], null, ''])]]);
    },
    'G_BOUNDARY_ALTERNATE_RPC_01': () => {
        const turn = [['c_boundary12345678', 'r_AB12'], [1700000000, 500000000],
            [['Boundary user prompt']], [[['rc_boundary', [['Boundary model answer'], 'en']]]]];
        return JSON.stringify([
            ['wrb.fr', 'hNvQHb', '[null]'],
            ['wrb.fr', 'otherRpc', JSON.stringify([[turn]])],
        ]);
    },
    'G_P1E_DETAIL_01': () => rpc([[p1RegressionTurn(undefined,
        '第一行\nhttps://googleusercontent.com/immersive_entry_chip/abc123\n第三行')]]),
    'G_P1E_DETAIL_02': () => rpc([[p1RegressionTurn(undefined,
        '看这张图\nhttps://googleusercontent.com/image_generation_content/tok999\n结束',
        [['https://lh3.googleusercontent.com/img=w100', 100, 100]])]]),
    'G_P1E_DETAIL_03': () => rpc([null, null, [['c_meta1234567890', '元数据标题', 'x']]]),
    'G_P1E_DETAIL_04': () => rpc([[p1RegressionTurn(['hello world from user'])]]),
    'G_P1E_DETAIL_05': () => rpc([[p1RegressionTurn([['标准形态文本']])]]),
    'G_GEMINI_PARSER_DETAIL_01': () => {
        const model = [
            [
                ['rc_024c7ad5d90f4db8', [
                    ['不能。如果你的CAS完全没有装备机枪，是无法夺取制空权的。'],
                    'zh',
                ]],
            ],
            [['hoi4 air wing equipment filtering tags']],
            'google', 'c', 'S', 6, 6, '.',
        ];
        const turn = [
            ['c_024c7ad5d90f4db8', 'r_turn_1'],
            [1717058840, 264000000],
            [['如果cas不带机枪的话能抢制空么']],
            model,
        ];
        return ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[turn], null, '钢铁雄心4制空测试'])]]);
    },
    'G_GEMINI_PARSER_DETAIL_02': () => rpc([['c_123', 'Title with [brackets] inside', 'data']]),
    'G_PROVIDER_ADAPTER_01': () => {
        const turn = [['c_prefixed_detail', 'r_request'], [1700000000, 0], [['Question']],
            [[['rc_answer', [['Answer ![image](data:image/png;base64,AQID)']]]]]];
        return JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[turn], null, 'Canonical detail'])]]);
    },
    'G_TIMESTAMP_HONESTY_01': () => rpc([[
        [['c_noTsTurn_1', 'r_turn_1'], null, [['Question']], [[['rc_model_1', [['Answer']]]]]],
    ]]),
    'G_PROMPT_LITERAL_01': () => {
        const prompt = "Use f(\\$)=1, **literal**, $x$, <input> and C:\\temp\\file.\n\nKeep [link](https://example.com) and \\* intact.";
        const turn = [['c_literalprompt', 'r_prompt'], [1700000000, 0], [[prompt]],
            [[['rc_answer', [['**Rendered answer**']]]]]];
        return JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[turn]])]]);
    },
    'G_SELECTED_CANDIDATE_01': () => selectedWire(selectedCandidates(), 'rc_displayed'),
    'G_SELECTED_CANDIDATE_02': () => selectedWire(selectedCandidates(), 'rc_alternative'),
    'G_SELECTED_CANDIDATE_03': () => selectedWire(selectedCandidates(), null),
    'G_SELECTED_CANDIDATE_04': () => selectedWire(selectedCandidates(), 'c'),
    'G_SELECTED_CANDIDATE_05': () => selectedWire(selectedCandidates(), 6),
    'G_SELECTED_CANDIDATE_06': () => selectedWire(selectedCandidates(), 'rc_missing'),
    'G_SELECTED_CANDIDATE_07': () => selectedWire([
        ['rc_unselected', [['Unselected image ![image](https://lh3.googleusercontent.com/unselected-image.png)'],
            ['https://lh3.googleusercontent.com/unselected-image.png', 640, 480]]],
        ['rc_selected', [['Displayed image ![image](https://lh3.googleusercontent.com/selected-image.png)'],
            ['https://lh3.googleusercontent.com/selected-image.png', 640, 480]]],
    ], 'rc_selected'),
    'G_PAGINATION_EMPTY_01': () => emptyTurnWire('c_source_chat_123'),
    'G_PAGINATION_EMPTY_FOREIGN': () => emptyTurnWire('c_other'),
    'G_OBSERVABILITY_DOC_01': () => {
        const item = ['https://y/immersive_entry_chip/e2e', '123e4567-e89b-12d3-a456-426614174099', 'End To End Heuristic Title'];
        const clue = '## End To End Heuristic Title\n\n' + '正文'.repeat(100);
        return rpc([[observabilityDocumentTurn([[item], clue])]]);
    },
    'G_OBSERVABILITY_DOC_02': () => {
        const id = '123e4567-e89b-12d3-a456-426614174099';
        const item = ['https://y/immersive_entry_chip/0', id, 'Document'];
        const content = [id, [['http://googleusercontent.com/immersive_entry_chip/0\n# 虚构城市水力建模分析\n\n' + '正文详细内容'.repeat(20)]]];
        return rpc([[observabilityDocumentTurn([[item], content])]]);
    },
    'G_OBSERVABILITY_DOC_03': () => {
        const id = '123e4567-e89b-12d3-a456-426614174099';
        const item = ['https://y/immersive_entry_chip/0', id, 'Document'];
        const content = [id, [['http://googleusercontent.com/immersive_entry_chip/0\n']]];
        return rpc([[observabilityDocumentTurn([[item], content])]]);
    },
    'G_OBSERVABILITY_DOC_04': () => {
        const item = ['https://y/immersive_entry_chip/no-match', '123e4567-e89b-12d3-a456-426614174099', 'Target Research Report'];
        const unrelated = '# Different Document\n\n' + 'Unrelated content '.repeat(35);
        return rpc([[observabilityDocumentTurn([[item], unrelated])]]);
    },
    'G_BOUNDARY_DETAIL_01': () => {
        const newest = boundaryTurn('Newest prompt', 1700000010, [['rc_new_a', [['First variant']]], ['rc_new_b', 'Second variant']]);
        const oldest = boundaryTurn('Oldest prompt', 1700000000, [['rc_old', [['Old answer']]]]);
        return rpc([[newest, oldest], 'tC_detail_cursor', 'Official detail title', { extra: true }]);
    },
    'G_BOUNDARY_DETAIL_02': () => rpc([[[[BOUNDARY_ID], null, [['User only prompt']]]]]),
    'G_BOUNDARY_DETAIL_03': () => rpc([[[[BOUNDARY_ID], null, null, [[['rc_model_only', [['Model only answer']]]]]]]]),
    'G_BOUNDARY_DETAIL_04': () => {
        const user = boundaryTurn();
        user[2] = ['Flat user prompt title'];
        return rpc([[user]]);
    },
    'G_BOUNDARY_DETAIL_05': () => rpc([null, null, [[BOUNDARY_ID, 'Metadata title']]]),
    'G_BOUNDARY_METADATA_TRIMMED_01': () => rpc([null, null, [[BOUNDARY_ID, '  Metadata title  ']]]),
    'G_BOUNDARY_METADATA_TITLE_NULL_01': () => rpc([null, null, [[BOUNDARY_ID, null]]]),
    'G_BOUNDARY_METADATA_TITLE_NUMBER_01': () => rpc([null, null, [[BOUNDARY_ID, 42]]]),
    'G_BOUNDARY_METADATA_TITLE_OBJECT_01': () => rpc([null, null, [[BOUNDARY_ID, { wrong: 'shape' }]]]),
    'G_BOUNDARY_METADATA_TITLE_EMPTY_01': () => rpc([null, null, [[BOUNDARY_ID, '']]]),
    'G_BOUNDARY_METADATA_TITLE_BLANK_01': () => rpc([null, null, [[BOUNDARY_ID, '   ']]]),
    'G_BOUNDARY_METADATA_ID_NULL_01': () => rpc([null, null, [[null, 'Metadata title']]]),
    'G_BOUNDARY_METADATA_ID_NUMBER_01': () => rpc([null, null, [[42, 'Metadata title']]]),
    'G_BOUNDARY_METADATA_ID_REQUEST_01': () => rpc([null, null, [['r_not_a_conversation', 'Metadata title']]]),
    'G_BOUNDARY_METADATA_ID_PREFIX_01': () => rpc([null, null, [['wrong_prefix', 'Metadata title']]]),
    'G_BOUNDARY_METADATA_NON_METADATA_01': () => rpc([null, [], [[BOUNDARY_ID, 'Metadata title']]]),
    'G_BOUNDARY_DETAIL_06': () => rpc([null, { extra: true }]),
    'G_TURN_ADMISSION_METADATA': () => admissionWire([null, null, [['METADATA_NOT_A_USER_PROMPT']], null]),
    'G_TURN_ADMISSION_SCALAR': () => admissionWire(42),
    'G_TURN_ADMISSION_UNOWNED': () => admissionWire([['x_not_a_turn'], null, [['Unowned prose']]]),
    'G_TURN_ADMISSION_REQUEST_RECOVERY': () => admissionWire([['changed_conversation_prefix', 'r_recovered'], null, [['Recovered question']]]),
    'G_TURN_ADMISSION_CANDIDATE_RECOVERY': () => admissionWire([null, null, null, [[['rc_recovered', [['Recovered answer']]]]]]),
    'G_BOUNDARY_DETAIL_07': () => rpc([[boundaryTurn(), [['x_not_a_turn'], null, [['Rejected recognizer prompt']]]]]),
    'G_BOUNDARY_DETAIL_08': () => rpc([[boundaryTurn('Missing body prompt', null, [['rc_missing']])]]),
    'G_RPC_DOMAIN_01': () => {
        const code = "import math\n\n\nclass Encoder:\n    def encode(self):\n        return 1\n\n\n\nprint(Encoder().encode())";
        const answer = "Explanation\n\n```python\n" + code + "\n```\n\nConclusion";
        return rpc([[domainTurn('Show the program', 1700000000, [['rc_answer', [[answer]]]])]]);
    },
    'G_RPC_DOMAIN_02': () => {
        const body = [['**Answer** [1]'], ['THOUGHT', 'Check **facts**'], ['https://example.test/source', 'Source']];
        return rpc([[domainTurn('Question', 1700000000, [['rc_answer', body]])], null, 'Authored title']);
    },
    'G_RPC_DOMAIN_04': () => rpc([[domainTurn('Question', null, undefined, 'r_AbCd12')]]),
    'G_RPC_DOMAIN_05': () => {
        const older = domainTurn('Older', 1700000000, [['rc_old', [['Old answer']]]], 'r_old');
        const newer = domainTurn('Newer', 1700000010, [['rc_new1', [['First']]], ['rc_new2', [['Second']]]], 'r_new');
        return rpc([[newer, older]]);
    },
    'G_RPC_DOMAIN_06': () => rpc([[[[DOMAIN_ID], null, [['Question']], [[['rc_answer', [['Answer']]]]]]]]),
    'G_RPC_DOMAIN_07': () => rpc([[domainTurn(), [['x_not_a_turn'], null, [['Unrecognized source prompt']]]], 'tC_native_cursor']),
    'G_RPC_DOMAIN_08': () => rpc([[domainTurn()]]),
    'G_RPC_DOMAIN_09': () => rpc([null, null, [[DOMAIN_ID, 'Metadata title']]]),
    'G_RPC_DOMAIN_10': () => rpc([null, null, [[DOMAIN_ID, 'Metadata title']]]),
    'G_RPC_DOMAIN_12': () => {
        const image: unknown[] = [];
        image[2] = 'watermarked_img_native.png';
        image[3] = 'https://lh3.googleusercontent.com/native_generated_image';
        image[11] = 'image/png';
        image[15] = [640, 480, 100];
        return rpc([[domainTurn('Draw', null, [['rc_image', [['Image'], image]]], 'r_Ab12')]]);
    },
    'G_RPC_DOMAIN_14': () => rpc(null),
    'G_RPC_DOMAIN_15': () => rpc([]),
    'G_RPC_DOMAIN_16': () => {
        const image: unknown[] = [];
        image[2] = 'source:photo?.png';
        image[3] = 'https://lh3.googleusercontent.com/source-photo';
        image[11] = 'image/png';
        image[15] = [640, 480, 100];
        return rpc([[domainTurn('Draw', null, [['rc_image', [['Image'], image]]])]]);
    },
    'G_RPC_DOMAIN_17': () => rpc([[domainTurn('Draw', null, [['rc_inline', [['Image'], ['https://lh3.googleusercontent.com/inline', 1, 1]]]])]]),
    'G_RPC_DOMAIN_18': () => {
        const rawTurn = [[DOMAIN_ID], null, [['Question']], [[['', [['Answer']]]]]];
        return rpc([[rawTurn, rawTurn]]);
    },
    'G_RPC_DOMAIN_19': () => rpc([[domainTurn('Question', null, undefined, 'r_Ab12')]]),
    'G_RPC_DOMAIN_20': () => '',
    'G_RPC_DOMAIN_21': () => 'not JSON',
    'G_DETAIL_NATIVE_TRANSPORT_01': () => {
        const turn = [
            ['c_native_bridge', 'r_abc123'],
            [1700000000, 0],
            [['Independent question']],
            [[['rc_answer', [['Independent answer']]]]],
        ];
        return JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[turn], null, 'Native title'])]]);
    },
    'G_DETAIL_PARSER_FALLBACK_01': () => {
        const inner = [
            [
                [
                    ['c_fallback_123', 'r_turn_1'],
                    null,
                    [['如何用Rust写WebAssembly插件']],
                    [[['rc_model_1', ['这是Rust WebAssembly回答']]]],
                ],
            ],
            null,
            'Rust WebAssembly 开发实战',
        ];
        return ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify(inner)]]);
    },
    'G_DETAIL_PARSER_META_ONLY_01': () => {
        const inner = [
            null,
            null,
            [['c_meta_only_456', '仅元数据标题', null, null, null, [1774139824, 809290000], null, null, null, 2]],
        ];
        return ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify(inner)]]);
    },
    'G_SNIFFER_DETAIL_01': () => JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([
        [[[ 'c_source_sniff_123', 'r_question'], [1700000000, 0], [['Question']],
            [[['rc_answer', [['Answer']]]]]]], null,
    ])]]),
    'G_SNIFFER_DETAIL_02': () => JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([
        [[[ 'c_source_sniff_123', 'r_question'], [1700000000, 0], [['Question']],
            [[['rc_answer', [['Answer']]]]]]], null,
    ])]]),
    'G_SNIFFER_DETAIL_03': () => JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([
        [[[ 'c_source_sniff_123', 'r_question'], [1700000000, 0], [['Question']],
            [[['rc_answer', [['Answer']]]]]]], null,
    ])]]),
    'G_NATIVE_ACQ_01': () => {
        const turn = [['c_native', 'r_one'], [1700000000, 0], [['Question']], [[['rc_one', [['Answer']]]]]];
        return ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[turn], null, 'Native title'])]]);
    },
    'G_NATIVE_ACQ_02': () => ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([null, null, [['c_native']]])]]),
    'G_NATIVE_ACQ_03': () => ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[], null, 'Empty conversation'])]]),
    'G_NATIVE_ACQ_04': () => ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([null, null, [['c_native', 'Title']]])]]),
    'G_NATIVE_ACQ_05': () => ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[], null, 'Verified empty conversation'])]]),
    'G_NATIVE_ACQ_06': () => ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([null, null, [['c_native', 'Title']]])]]),
    'G_NATIVE_ACQ_07': () => ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([null, null, [['c_native']]])]]),
    'G_NATIVE_CALLERS_02': () => ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([null, null, [['c_native']]])]]),
    'G_NATIVE_CALLERS_03': () => ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([null, null, [['c_native']]])]]),
    'G_OBSERVABILITY_01': () => rpc([[observabilityTurn(),
        observabilityTurn('c_odd000000000001', '非数组形态的 user payload'),
        [['x_123'], [1, 0], [['u']]]]]),
    'G_OBSERVABILITY_02': () => rpc([[observabilityTurn(), observabilityTurn('c_abc123def457')]]),
    'G_OBSERVABILITY_03': () => rpc([[observabilityTurn(), [['x_123'], [1, 0], [['u']]]]]),
    'G_OBSERVABILITY_04': () => rpc([[observabilityTurn(), [['x_123'], [1, 0], [['u']]]]]),

    // Static hNvQHb fragments used to verify selective sniffer broadcasts.
    'G_REGRESSION_LOCK_FILTER_DETAIL_01': () =>
        String.fromCharCode(41, 93, 125, 39) + '\n' + JSON.stringify([['wrb.fr', 'hNvQHb', ['c_123'], null]]),
    'G_EXTRACTED_REGRESSION_FILTER_DETAIL_01': () =>
        String.fromCharCode(41, 93, 125, 39) + '\n' + JSON.stringify([['wrb.fr', 'hNvQHb', ['c_123'], null]]),
    'G_REGRESSION_LOCK_PARSER_DETAIL_01': () =>
        rpc([[[['c_testid1234567890ab', 'r1'], null,
            [['Special test message with , null , in code and [brackets]']],
            [[['rc1', [['answer1']]]]]]], null, 'Test Title']),
    'G_EXTRACTED_REGRESSION_PARSER_DETAIL_01': () =>
        rpc([[[['c_testid1234567890ab', 'r1'], null,
            [['Special test message with , null , in code and [brackets]']],
            [[['rc1', [['answer1']]]]]]], null, 'Test Title']),
};

const wireCaseBCandOrigin = derived(["tests/fixtures/provider/structured_rpc/wire-case-b-cand.json", "tests/fixtures/provider/structured_rpc/wire-turn-3-12-b-stack.json"], "Saved Detail/structured content or measured timestamps with authored identity, RPC framing or boundary mutations.");

export const fixtureOrigins = describeFixtures(protocolCases, synthetic("Authored Gemini protocol, content or state counterexample; no saved capture is used."), {
    G_BOUNDARY_CAPTURED_STACK_01: wireCaseBCandOrigin,
    G_BOUNDARY_CAPTURED_TRUNCATED_01: wireCaseBCandOrigin,
    G_RPC_DOMAIN_CAPTURED_STACK_01: wireCaseBCandOrigin,
});
