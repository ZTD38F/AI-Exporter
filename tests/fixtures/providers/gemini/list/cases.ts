import { describeFixtures, synthetic, derived } from '../../provenance.js';
import { wire, sourceRow, geminiList, boundaryRow, contractRow, rpcRow, rpcEnvelope, rpcBatchWire, nativeAnyError, p1RegressionList, scanFlowWire, scanRows, fixedPage, e2eIncrementalList, e2eUuidList, versionPairList } from './builders.js';

export const listCases = {
    'G_E2E_ACCOUNT_REGISTRY_EMPTY_BATCH_01': () => '[]',
    'G_PARSER_CONTRACT_MALFORMED_LIST_01': () => '[]',
    'G_MESSAGE_BRIDGE_OVERSIZED_BODY_01': () => 'x'.repeat(3000001),
    'G_P1E_LEADING_DECOY_LIST_01': () => {
        const junkStr = JSON.stringify('just public_wifi talk');
        const listInnerStr = JSON.stringify([null, [['c_list0012345678', 'ListTitle', null, null, 5]], null]);
        return ")]}'\n\n" + JSON.stringify([
            ['x.fr', 'junk', junkStr],
            ['wrb.fr', 'MaZiqc', listInnerStr],
        ]);
    },
    'G_REGRESSION_GENERIC_DECOY_LIST_01': () => ")]}'\n" +
        JSON.stringify([['wrb.fr', 'generic_rpc', '[]', null]]),
    'G_EXTRACTED_GENERIC_DECOY_LIST_01': () => ")]}'\n" +
        JSON.stringify([['wrb.fr', 'generic_rpc', '[]', null]]),
    'G_REGRESSION_SLOT_ISOLATION_LIST_01': () =>
        JSON.stringify([['wrb.fr', 'MaZiqc', JSON.stringify([null, null, [['c_slot_isolation', 'Title']]])]]),
    'G_REGRESSION_BRACKET_TITLE_LIST_01': () => `)]}'\n\n[[ "wrb.fr", "MaZiqc", "[[\\"c_123\\", \\"Title [with bracket]\\", [1700000000, 0]]]" ]]`,
    'G_SOURCE_EMPTY_01': () => geminiList([]),
    'G_SOURCE_ONE_01': () => geminiList(["one"]),
    'G_SOURCE_TWO_01': () => geminiList(["two"]),
    'G_SOURCE_ONE_MORE_01': () => geminiList(["one"], "tC_more"),
    'G_SOURCE_ONE_NEXT_01': () => geminiList(["one"], "tC_next"),
    'G_SOURCE_ONE_LOOP_01': () => geminiList(["one"], "tC_loop"),
    'G_SOURCE_TWO_LOOP_01': () => geminiList(["two"], "tC_loop"),
    'G_SOURCE_SHARED_CURSOR_01': () => geminiList(["shared"], "tC_same_token_123456789"),
    'G_SOURCE_RECENT_01': () => geminiList(["recent"]),
    'G_SOURCE_VISIBLE_01': () => geminiList(["visible"]),
    'G_SOURCE_VISIBLE_LIMIT_01': () => geminiList(["visible"], "tC_limit"),
    'G_SOURCE_FIRST_NEXT_01': () => geminiList(["first"], "tC_next"),
    'G_SOURCE_FIRST_LOOP_01': () => geminiList(["first"], "tC_loop"),
    'G_SOURCE_SECOND_01': () => geminiList(["second"]),
    'G_SOURCE_SECOND_LOOP_01': () => geminiList(["second"], "tC_loop"),
    'G_SOURCE_NEVER_01': () => geminiList(["never"]),
    'G_SOURCE_UNTRUSTED_01': () => geminiList(["untrusted"]),
    'G_SOURCE_REPEATED_CURSOR_01': () => geminiList(["repeated"], "tC_repeat"),
    'G_SOURCE_REPEATED_01': () => geminiList(["repeated"]),
    'G_SOURCE_HEAD_NEXT_01': () => geminiList(["head"], "tC_next"),
    'G_SOURCE_LATER_01': () => geminiList(["later"]),
    'G_SOURCE_OLD_01': () => geminiList(["old"]),
    'G_SOURCE_NEW_NEXT_01': () => geminiList(["new"], "tC_next"),
    'G_SOURCE_CHAT_01': () => geminiList(["source_chat_123"]),
    'G_E2E_INCREMENTAL_WINDOW_HEAD_01': () => e2eIncrementalList('chat', [100, 90], 'tC_middle'),
    'G_E2E_INCREMENTAL_WINDOW_MIDDLE_01': () => e2eIncrementalList('chat', [80, 70], 'tC_limit'),
    'G_E2E_INCREMENTAL_WINDOW_LIMIT_01': () => JSON.stringify([[
        'wrb.fr', 'MaZiqc', null, null, null,
        [5, null, [['type.googleapis.com/assistant.boq.bard.application.BardErrorInfo', [1096]]]], 'generic',
    ]]),
    'G_E2E_INCREMENTAL_WINDOW_HEAD_02': () => e2eIncrementalList('chat', [120, 110, 95, 85], 'tC_unread'),
    'G_E2E_INCREMENTAL_WINDOW_HEAD_03': () => e2eIncrementalList('chat', [130, 120, 110, 95], 'tC_unread'),
    'G_E2E_INCREMENTAL_DISJOINT_HEAD_01': () => e2eIncrementalList('rebuild', [100, 70], null),
    'G_E2E_INCREMENTAL_DISJOINT_HEAD_02': () => e2eIncrementalList('rebuild', [150, 140], 'tC_fresh'),
    'G_E2E_INCREMENTAL_DISJOINT_TAIL_02': () => e2eIncrementalList('rebuild', [130, 120], null),
    'G_E2E_UUID_LIST_STALE_01': () => e2eUuidList('staleuuid123'),
    'G_E2E_UUID_LIST_CURRENT_01': () => e2eUuidList('currentuuid123'),
    'G_DYNAMIC_PAGE_SYNC_01': () => fixedPage('39d5b41870e49a67', '量子纠缠物理原理深度解析', 1700000000),
    'G_DYNAMIC_PAGE_SYNC_02': () => fixedPage('takeout_chat_888', 'Renamed by Gemini', 1700000200),
    'G_DYNAMIC_TITLE_ARBITRATION_01': () => fixedPage('arbitration_chat_999', '官方服务端RPC最终权威标题', 1700000000),
    'G_DYNAMIC_TITLE_ARBITRATION_02': () => fixedPage('arbitration_chat_999', 'RPC 更晚的标题', 1700000200),
    'G_DYNAMIC_WATERMARK_LIST_01': () => fixedPage('abcdef123', 'A', 1700000000),
    'G_DYNAMIC_WATERMARK_LIST_02': () => fixedPage('abcdef123', 'A', 1699999999),
    'G_DYNAMIC_SCAN_FLOW_LIST_01': () => scanFlowWire(scanRows()),
    'G_DYNAMIC_SCAN_FLOW_LIST_02': () => scanFlowWire(scanRows(true)),
    'G_DYNAMIC_SCAN_FLOW_PINNED_01': () => scanFlowWire([
        sourceRow('scan_pinned', '置顶的较早会话', 1600000000),
    ]),
    'G_PARSER_PAYLOAD_TOP_01': () => JSON.stringify([
        ['wrb.fr', 'MaZiqc', JSON.stringify([null, [['c_123', 'Title 1']]])],
        ['wrb.fr', 'otherRpc', '{}'],
    ]),
    'G_PARSER_PAYLOAD_LEGACY_01': () => JSON.stringify([
        ['wrb.fr', 'hXcbkd', JSON.stringify([null, [['c_legacy', 'Legacy Title']]])],
    ]),
    'G_PARSER_PAYLOAD_HEURISTIC_01': () => JSON.stringify([
        ['unknown_prefix', 'unknown_rpc', JSON.stringify([['turn1']])],
    ]),
    'G_PARSER_PAYLOAD_ERROR_01': () => JSON.stringify([
        ['wrb.fr', 'error_rpc', null, null, null, ['generic', 'BardErrorInfo: quota exceeded']],
    ]),
    'G_BOUNDARY_LIST_SLOTS_01': () => {
        const row = ['c_boundary12345678', 'Boundary title - Gemini', [1690000000],
            [1680000000], 2, [1700000000, 500000000], null, { extra: true }, null, 7];
        return ")]}'\n\n" + JSON.stringify([['wrb.fr', 'MaZiqc',
            JSON.stringify([null, [row], null, null, 'tC_fallback_cursor', { future: true }])]]);
    },
    'G_BOUNDARY_LIST_EMPTY_TEXT_01': () => '',
    'G_BOUNDARY_LIST_INVALID_JSON_01': () => 'not-json',
    'G_BOUNDARY_LIST_EMPTY_JSON_01': () => '[]',
    'G_BOUNDARY_LIST_BAD_DETAIL_01': () => ")]}'\n\n" +
        JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify(null)]]),
    'G_BOUNDARY_LIST_BAD_INNER_01': () => ")]}'\n\n" +
        JSON.stringify([['wrb.fr', 'MaZiqc', '[broken']]),
    'G_BOUNDARY_FRAMING_MIXED_01': () => {
        const first = ['wrb.fr', 'MaZiqc', '[["quoted [bracket] and \\"escape\\""]]'];
        const second = ['wrb.fr', 'hNvQHb', '[]'];
        return ")]}'\n123\n" + JSON.stringify([first]) + '\n[not-json]\n'
            + JSON.stringify([second]) + '\n[["unfinished';
    },
        'G_P1E_LIST_01': () => p1RegressionList([['c_cnt1234567890', 'T', null, null, null, 1757839234]]),
    'G_P1E_LIST_02': () => p1RegressionList([['c_cnt2234567890', 'T2', null, null, 7]]),
    'G_P1E_LIST_03': () => p1RegressionList([['c_nots1234567890', 'NoTime']]),
    'G_P1E_LIST_04': () => p1RegressionList([['c_hasts1234567890', 'HasTime', null, null, null, [1700000000, 0]]]),
    'G_TAKEOUT_LIMIT_01': () => JSON.stringify([['wrb.fr', 'MaZiqc', null, null, null, ['BardErrorInfo', 1096]]]),
    'G_CONVERSATION_ORDER_01': () => JSON.stringify([
        ['wrb.fr', 'MaZiqc', JSON.stringify([null,
            [['c_server123', 'Server title', null, null, 12, [1700000000, 0]]]])],
    ]),

    'G_BOUNDARY_LIST_01': () => {
        const ids = ['c_missingtitle123', 'c_nulltitle123456', 'c_objecttitle1234', 'c_blanktitle12345'];
        const rows = [null, [], 'not-a-row', [ids[0]], [ids[1], null], [ids[2], { title: 'wrong shape' }], [ids[3], ' \t ']];
        return ")]}'\n\n" + JSON.stringify([['wrb.fr', 'MaZiqc', JSON.stringify([null, rows])]]);
    },
    'G_BOUNDARY_LIST_02': () => ")]}'\n\n" + JSON.stringify([['wrb.fr', 'MaZiqc',
        JSON.stringify([null, null, [['c_boundary12345678', 'Secondary title']]])]]),
    'G_BOUNDARY_LIST_03': () => ")]}'\n\n" + JSON.stringify([['wrb.fr', 'MaZiqc', JSON.stringify([null, [], 'tC_empty_page'])]]),
    'G_L1_CLIENT_V2_MOCKED_02': () => JSON.stringify([
        ['wrb.fr', 'MaZiqc', null, null, null, ['BardErrorInfo', 1096]],
    ]),
    'G_L1_LIST_RPC_ISOLATION_01': () => rpcBatchWire(
        rpcEnvelope('hNvQHb', []), ['wrb.fr', 'MaZiqc', null, null, null, ['BardErrorInfo', 429]]),
    'G_L1_LIST_RPC_ISOLATION_02_0': () => rpcBatchWire(rpcEnvelope('hNvQHb', [])),
    'G_L1_LIST_RPC_ISOLATION_02_1': () => rpcBatchWire(rpcEnvelope('hNvQHb', [null, null, [rpcRow()]])),
    'G_L1_LIST_RPC_ISOLATION_02_2': () => rpcBatchWire(rpcEnvelope('hNvQHb', [null, 'tC_next', [rpcRow()]])),
    'G_L1_LIST_RPC_ISOLATION_03_0': () => rpcBatchWire(rpcEnvelope('hNvQHb', []), rpcEnvelope('MaZiqc', [null, null, [rpcRow()]])),
    'G_L1_LIST_RPC_ISOLATION_03_1': () => rpcBatchWire(rpcEnvelope('MaZiqc', [null, 'tC_next', [rpcRow()]]), rpcEnvelope('hNvQHb', [])),
    'G_L1_LIST_RPC_ISOLATION_04_LIMIT': () => rpcBatchWire(rpcEnvelope('hNvQHb', []), ['wrb.fr', 'MaZiqc', null, null, null, ['BardErrorInfo', 1096]]),
    'G_L1_LIST_RPC_ISOLATION_04_UNRELATED': () => rpcBatchWire(['wrb.fr', 'hNvQHb', null, null, null, ['BardErrorInfo', 1096]]),
    'G_L1_LIST_RPC_ISOLATION_05': () => rpcBatchWire(nativeAnyError('MaZiqc', 1096)),
    'G_L1_LIST_RPC_ISOLATION_06_0': () => rpcBatchWire(nativeAnyError('hNvQHb', 1096)),
    'G_L1_LIST_RPC_ISOLATION_06_1': () => rpcBatchWire(nativeAnyError('MaZiqc', 1167)),
    'G_L1_LIST_RPC_ISOLATION_06_2': () => rpcBatchWire(nativeAnyError('MaZiqc', 10961)),
    'G_L1_LIST_RPC_ISOLATION_06_3': () => rpcBatchWire(nativeAnyError('MaZiqc', '1096')),
    'G_L1_LIST_RPC_ISOLATION_06_4': () => rpcBatchWire(nativeAnyError('MaZiqc', 1096, 'type.googleapis.com/other.BardErrorInfo')),
    'G_L1_LIST_RPC_ISOLATION_06_5': () => rpcBatchWire(['wrb.fr', 'MaZiqc', null, null, null, [1096]]),
    'G_L1_CONTRACT_01': () => wire([contractRow()]),
    'G_L1_CONTRACT_06': () => ((nextCursor: string | null = null, id = 'source_chat_123', seconds = 1700000050) =>
        wire([contractRow(id, seconds)], nextCursor))('tC_NEXT_PAGE_123456789'),
    'G_L1_CONTRACT_07': (nextCursor: string | null = null, id = 'source_chat_123', seconds = 1700000050) =>
        wire([contractRow(id, seconds)], nextCursor),
    'G_L1_CONTRACT_10': () => ((nextCursor: string | null = null, id = 'source_chat_123', seconds = 1700000050) =>
        wire([contractRow(id, seconds)], nextCursor))('tC_NEXT_PAGE_123456789'),
    'G_L1_CONTRACT_11': () => ((nextCursor: string | null = null, id = 'source_chat_123', seconds = 1700000050) =>
        wire([contractRow(id, seconds)], nextCursor))('tC_NEXT_PAGE_123456789', 'different_chat_456', 1700000040),
    'G_L1_CONTRACT_12': () => 'garbage',
    'G_L1_CONTRACT_13': () => wire(),
    'G_L1_CONTRACT_15_0': () => rpcBatchWire(['wrb.fr', 'MaZiqc', null, null, null, ['generic', "BardErrorInfo: cursor expired"]]),
    'G_L1_CONTRACT_15_1': () => rpcBatchWire(['wrb.fr', 'MaZiqc', null, null, null, ['generic', "[\"BardErrorInfo\",9999]"]]),
    'G_L1_CONTRACT_21': () => JSON.stringify([
        ['wrb.fr', 'MaZiqc', null, null, null, ['BardErrorInfo', 1096]],
    ]),
    'G_LIST_SOURCE_BOUNDARY_07': () => wire([boundaryRow()]),
    'G_LIST_SOURCE_BOUNDARY_08_0': () => rpcBatchWire(rpcEnvelope('MaZiqc', [null, null, [null]])),
    'G_LIST_SOURCE_BOUNDARY_08_1': () => rpcBatchWire(rpcEnvelope('MaZiqc', [null, { unexpected: true }])),
    'G_LIST_SOURCE_BOUNDARY_08_2': () => rpcBatchWire(rpcEnvelope('MaZiqc', [null, null, [['c_unknown', 'Invalid identity']]])),
    'G_LIST_SOURCE_BOUNDARY_08_3': () => rpcBatchWire(rpcEnvelope('MaZiqc', [null, null, [['c_settings', 'Reserved route']]])),
    'G_LIST_SOURCE_BOUNDARY_09': () => wire([], 'tC_cursor'),
    'G_LIST_SOURCE_BOUNDARY_10_EXPLICIT': () => wire([sourceRow('boundary123', 'Title', 1700000060)]),
    'G_LIST_SOURCE_BOUNDARY_10_AMBIGUOUS': () => rpcBatchWire(rpcEnvelope('MaZiqc', [null, { cursor: 'unrecognized' }, [sourceRow('boundary123', 'Title', 1700000060)]])),
    'G_PAGE_OBSERVATION_03': () => {
        const fallback = sourceRow('abcdef123', 'abcdef123', 1700000020);
        fallback[2] = fallback[5];
        fallback[5] = null;
        return wire([fallback]);
    },
    'G_PAGE_OBSERVATION_04': () => wire([
        sourceRow('abcdef123', 'abcdef123', 1700000010),
        sourceRow('abcdef456', 'abcdef456', 1700000020),
    ]),
    'G_PAGE_OBSERVATION_06': () => JSON.stringify([['wrb.fr', 'MaZiqc', '[]']]),
    'G_PAGE_OBSERVATION_07': () =>
        JSON.stringify([['wrb.fr', 'MaZiqc', JSON.stringify([null, { unexpected: true }])]]),
    'G_PAGE_OBSERVATION_08': () => wire([
        sourceRow('abcdef123', 'abcdef123', 1700000020),
        sourceRow('abcdef456', 'abcdef456', 1700000020),
        sourceRow('abcdef789', 'abcdef789', 1700000010),
    ]),
    'G_PAGE_OBSERVATION_09': () => {
        const row = sourceRow('abcdef456', 'abcdef456', 1700000020);
        row[5] = [1700000020, 100];
        return wire([row, sourceRow('abcdef123', 'abcdef123', 1700000020)]);
    },
    'G_PAGE_OBSERVATION_10': () => wire([
        sourceRow('abcdef123', 'abcdef123', 1700000020),
        sourceRow('abcdef123', 'abcdef123', 1700000020),
    ]),
    'G_UNIFIED_INGEST_INTEGRITY_01': () => wire([
        ['c_unknown', 'Invalid'],
        sourceRow('valid_123', 'Valid Chat', 1700000000),
    ]),
    'G_SNIFFER_LIST_04': () => wire([]),
    'G_ACTIVE_TITLE_01': () => wire([
        ['c_generic_title_01', 'Observed generic_title_01', null, null, null, [1700000000, 0]],
        ['c_sniff_title_01', 'Observed sniff_title_01', null, null, null, [1700000000, 0]],
        ['c_resolved_title_01', 'Observed resolved_title_01', null, null, null, [1700000000, 0]],
        ['c_undated_rpc_01', 'Observed undated_rpc_01', null, null, null, null],
    ]),
    'G_VERIFIED_SCAN_OVERLAP_01': () => JSON.stringify([
        ['wrb.fr', 'MaZiqc', null, null, null, [13], 'generic'],
    ]),

    // Static native List bodies used by E2E source acquisition probes.
    'G_E2E_INCREMENTAL_ERROR_LIST_01': () =>
        JSON.stringify([['wrb.fr', 'MaZiqc', null, null, null, [13], 'generic']]),
    // Fixed single-RPC admission and hook-filter cases; preserve native framing.
    'G_FROZEN_CONTRACT_LIST_01': () => JSON.stringify([['wrb.fr', 'MaZiqc', JSON.stringify([null, null, []])]]),
    'G_REGRESSION_LOCK_DECOY_LIST_01': () =>
        JSON.stringify([['wrb.fr', 'MaZiqc', '[["aabbccdd11223344",null]]', null]]),
    'G_REGRESSION_LOCK_FILTER_LIST_01': () =>
        String.fromCharCode(41, 93, 125, 39) + '\n' + JSON.stringify([['wrb.fr', 'MaZiqc', ['c_123'], null]]),
    'G_EXTRACTED_REGRESSION_FILTER_LIST_01': () =>
        String.fromCharCode(41, 93, 125, 39) + '\n' + JSON.stringify([['wrb.fr', 'MaZiqc', ['c_123'], null]]),
    'G_REGRESSION_LOCK_REQUEST_LIST_01': () =>
        `)]}'\n\n[["wrb.fr","MaZiqc","[]",null]]`,
    'G_EXTRACTED_REGRESSION_REQUEST_LIST_01': () =>
        `)]}'\n\n[["wrb.fr","MaZiqc","[]",null]]`,
    'G_REGRESSION_LOCK_CURSOR_LIST_01': () =>
        JSON.stringify([['wrb.fr', 'MaZiqc', '[]', null]]),
    'G_EXTRACTED_REGRESSION_CURSOR_LIST_01': () =>
        JSON.stringify([['wrb.fr', 'MaZiqc', '[]', null]]),

    // L1 target-bound 1167 / provider-limit response proofs.
    'G_L1_VERIFIED_LIST_1167_01': () =>
        String.fromCharCode(41, 93, 125, 39) + '\n\n' + JSON.stringify([['wrb.fr', 'MaZiqc', null, null, null, ['BardErrorInfo', 1167]]]),
    'G_L1_VERIFIED_LIST_FALSE_DELETE_01': () =>
        String.fromCharCode(41, 93, 125, 39) + '\n\n' + JSON.stringify([['wrb.fr', 'MaZiqc', JSON.stringify([null, 'c_deadbeef00112233'])]]),
    'G_L1_VERIFIED_LIST_LIMIT_01': () =>
        String.fromCharCode(41, 93, 125, 39) + '\n\n' + JSON.stringify([['wrb.fr', 'MaZiqc', null, null, null, ['BardErrorInfo', 1096]]]),
    'G_L1_VERIFIED_LIST_LIMIT_10961': () =>
        String.fromCharCode(41, 93, 125, 39) + '\n\n' + JSON.stringify([['wrb.fr', 'MaZiqc', null, null, null, ['BardErrorInfo', 10961]]]),
    'G_L1_VERIFIED_LIST_LIMIT_429': () =>
        String.fromCharCode(41, 93, 125, 39) + '\n\n' + JSON.stringify([['wrb.fr', 'MaZiqc', null, null, null, ['BardErrorInfo', 429]]]),
    'G_L1_VERIFIED_LIST_LIMIT_STRING': () =>
        String.fromCharCode(41, 93, 125, 39) + '\n\n' + JSON.stringify([['wrb.fr', 'MaZiqc', null, null, null, ['BardErrorInfo', '1096']]]),
    'G_VERSION_PAIR_LIST_01': () => versionPairList(0),
    'G_VERSION_PAIR_LIST_02': () => versionPairList(1),
    'G_VERSION_PAIR_LIST_03': () => versionPairList(2),
    'G_VERSION_PAIR_LIST_04': () => versionPairList(3),
    'G_VERSION_PAIR_LIST_05': () => versionPairList(4),
    'G_VERSION_PAIR_LIST_06': () => versionPairList(5),
    'G_VERSION_CREATION_SLOT_LIST_01': () => JSON.stringify([
        ['wrb.fr', 'MaZiqc', JSON.stringify([null, null, [
            ['c_version_chat', 'Source title', [1700000005, 0], [1700000000, 0], null, null],
        ]])],
    ]),
    'G_VERSION_METADATA_ONLY_LIST_01': () => JSON.stringify([
        ['wrb.fr', 'MaZiqc', JSON.stringify([null, null, [
            ['c_metadata_chat', 'Metadata only', null, null, null, [1700000000, 0]],
        ]])],
    ]),
};

const recentOrigin = derived(["tests/fixtures/provider/gemini_list/recent.json"], "Captured List row/envelope or saved timestamp fields with explicit identities, paging, times or malformed slots.");
const geminiTimestampPairsOrigin = derived(["tests/fixtures/gemini_timestamp_pairs.json"], "Captured List row/envelope or saved timestamp fields with explicit identities, paging, times or malformed slots.");

export const fixtureOrigins = describeFixtures(listCases, synthetic("Authored Gemini protocol, content or state counterexample; no saved capture is used."), {
    G_SOURCE_EMPTY_01: recentOrigin,
    G_SOURCE_ONE_01: recentOrigin,
    G_SOURCE_TWO_01: recentOrigin,
    G_SOURCE_ONE_MORE_01: recentOrigin,
    G_SOURCE_ONE_NEXT_01: recentOrigin,
    G_SOURCE_ONE_LOOP_01: recentOrigin,
    G_SOURCE_TWO_LOOP_01: recentOrigin,
    G_SOURCE_SHARED_CURSOR_01: recentOrigin,
    G_SOURCE_RECENT_01: recentOrigin,
    G_SOURCE_VISIBLE_01: recentOrigin,
    G_SOURCE_VISIBLE_LIMIT_01: recentOrigin,
    G_SOURCE_FIRST_NEXT_01: recentOrigin,
    G_SOURCE_FIRST_LOOP_01: recentOrigin,
    G_SOURCE_SECOND_01: recentOrigin,
    G_SOURCE_SECOND_LOOP_01: recentOrigin,
    G_SOURCE_NEVER_01: recentOrigin,
    G_SOURCE_UNTRUSTED_01: recentOrigin,
    G_SOURCE_REPEATED_CURSOR_01: recentOrigin,
    G_SOURCE_REPEATED_01: recentOrigin,
    G_SOURCE_HEAD_NEXT_01: recentOrigin,
    G_SOURCE_LATER_01: recentOrigin,
    G_SOURCE_OLD_01: recentOrigin,
    G_SOURCE_NEW_NEXT_01: recentOrigin,
    G_SOURCE_CHAT_01: recentOrigin,
    G_E2E_INCREMENTAL_WINDOW_HEAD_01: recentOrigin,
    G_E2E_INCREMENTAL_WINDOW_MIDDLE_01: recentOrigin,
    G_E2E_INCREMENTAL_WINDOW_HEAD_02: recentOrigin,
    G_E2E_INCREMENTAL_WINDOW_HEAD_03: recentOrigin,
    G_E2E_INCREMENTAL_DISJOINT_HEAD_01: recentOrigin,
    G_E2E_INCREMENTAL_DISJOINT_HEAD_02: recentOrigin,
    G_E2E_INCREMENTAL_DISJOINT_TAIL_02: recentOrigin,
    G_E2E_UUID_LIST_STALE_01: recentOrigin,
    G_E2E_UUID_LIST_CURRENT_01: recentOrigin,
    G_DYNAMIC_PAGE_SYNC_01: recentOrigin,
    G_DYNAMIC_PAGE_SYNC_02: recentOrigin,
    G_DYNAMIC_TITLE_ARBITRATION_01: recentOrigin,
    G_DYNAMIC_TITLE_ARBITRATION_02: recentOrigin,
    G_DYNAMIC_WATERMARK_LIST_01: recentOrigin,
    G_DYNAMIC_WATERMARK_LIST_02: recentOrigin,
    G_DYNAMIC_SCAN_FLOW_LIST_01: recentOrigin,
    G_DYNAMIC_SCAN_FLOW_LIST_02: recentOrigin,
    G_DYNAMIC_SCAN_FLOW_PINNED_01: recentOrigin,
    G_L1_LIST_RPC_ISOLATION_02_1: recentOrigin,
    G_L1_LIST_RPC_ISOLATION_02_2: recentOrigin,
    G_L1_LIST_RPC_ISOLATION_03_0: recentOrigin,
    G_L1_LIST_RPC_ISOLATION_03_1: recentOrigin,
    G_L1_CONTRACT_01: recentOrigin,
    G_L1_CONTRACT_06: recentOrigin,
    G_L1_CONTRACT_07: recentOrigin,
    G_L1_CONTRACT_10: recentOrigin,
    G_L1_CONTRACT_11: recentOrigin,
    G_L1_CONTRACT_13: recentOrigin,
    G_LIST_SOURCE_BOUNDARY_07: recentOrigin,
    G_LIST_SOURCE_BOUNDARY_09: recentOrigin,
    G_LIST_SOURCE_BOUNDARY_10_EXPLICIT: recentOrigin,
    G_LIST_SOURCE_BOUNDARY_10_AMBIGUOUS: recentOrigin,
    G_PAGE_OBSERVATION_03: recentOrigin,
    G_PAGE_OBSERVATION_04: recentOrigin,
    G_PAGE_OBSERVATION_08: recentOrigin,
    G_PAGE_OBSERVATION_09: recentOrigin,
    G_PAGE_OBSERVATION_10: recentOrigin,
    G_UNIFIED_INGEST_INTEGRITY_01: recentOrigin,
    G_SNIFFER_LIST_04: recentOrigin,
    G_ACTIVE_TITLE_01: recentOrigin,
    G_VERSION_PAIR_LIST_01: geminiTimestampPairsOrigin,
    G_VERSION_PAIR_LIST_02: geminiTimestampPairsOrigin,
    G_VERSION_PAIR_LIST_03: geminiTimestampPairsOrigin,
    G_VERSION_PAIR_LIST_04: geminiTimestampPairsOrigin,
    G_VERSION_PAIR_LIST_05: geminiTimestampPairsOrigin,
    G_VERSION_PAIR_LIST_06: geminiTimestampPairsOrigin,
});
