import { describeFixtures, synthetic, derived } from '../../provenance.js';
import { versionMixed, versionPairDetail, versionUnrelated } from './version.js';

export const versionCases = {
    'G_VERSION_DETAIL_METADATA_ONLY_01': () => JSON.stringify([
        ['wrb.fr', 'MaZiqc', JSON.stringify([null, null, [
            ['c_metadata_chat', 'Metadata only', null, null, null, [1700000000, 0]],
        ]])],
        ['wrb.fr', 'hNvQHb', JSON.stringify([null, null, [['c_metadata_chat', 'Metadata only']]])],
    ]),
    'G_VERSION_PAIR_DETAIL_01': () => versionPairDetail(0),
    'G_VERSION_PAIR_DETAIL_02': () => versionPairDetail(1),
    'G_VERSION_PAIR_DETAIL_03': () => versionPairDetail(2),
    'G_VERSION_PAIR_DETAIL_04': () => versionPairDetail(3),
    'G_VERSION_PAIR_DETAIL_05': () => versionPairDetail(4),
    'G_VERSION_PAIR_DETAIL_06': () => versionPairDetail(5),
    'G_VERSION_DETAIL_MATCHING_01': () => versionMixed([1700000000, 0], [1700000005, 123000000]),
    'G_VERSION_DETAIL_NO_META_01': () => versionMixed([1700000000, 0]),
    'G_VERSION_DETAIL_UNRELATED_01': () => versionUnrelated(),
    'G_VERSION_DETAIL_SAVED_AT_01': () => versionMixed([1700000000, 0], [1700000000, 0]),
    'G_VERSION_DETAIL_SAVED_AT_02': () => versionMixed([1700000000, 0], [1700000000, 0]),
    'G_VERSION_DETAIL_NEWER_01': () => versionMixed([1700000005, 0], [1700000005, 0]),
    'G_VERSION_DETAIL_PARTIAL_NEWER_01': () => versionMixed([1700000010, 0], [1700000010, 0], true),
    'G_VERSION_DETAIL_OLDER_01': () => versionMixed([1700000000, 0], [1700000000, 0]),
    'G_VERSION_DETAIL_PARTIAL_ID_01': () => versionMixed([1700000000, 0], [1700000000, 0], true, 'partial_chat'),
    'G_VERSION_DETAIL_UNKNOWN_ID_01': () => versionMixed([1700000000, 0], undefined, false, 'unknown_chat'),
    'G_VERSION_DETAIL_CONFLICT_ID_01': () => versionMixed([1700000005, 0], [1700000000, 0], false, 'conflicting_chat'),
    'G_VERSION_DETAIL_PAGE_FIRST_01': () => versionMixed([1700000005, 0], [1700000005, 0], true),
    'G_VERSION_DETAIL_PAGE_CHANGED_01': () => versionMixed([1700000000, 0], [1700000010, 0]),
    'G_VERSION_DETAIL_PAGE_CONSISTENT_01': () => versionMixed([1700000000, 0], [1700000005, 0]),
    'G_VERSION_DETAIL_HEALTHY_01': () => versionMixed([1700000000, 0], [1700000005, 0]),
    'G_VERSION_DETAIL_MISMATCHED_01': () => versionMixed([1700000010, 0], [1700000005, 0]),
    'G_VERSION_LAYERS_FRESHNESS_01': () => versionMixed([1700000000, 0], [1700000000, 0]),
    'G_VERSION_LAYERS_JSON_01': () => versionMixed([1700000000, 0], [1700000000, 0]),
    'G_VERSION_LAYERS_JSON_PARTIAL_01': () => versionMixed([1700000000, 0], [1700000000, 0], true),
    'G_VERSION_LAYERS_HEALTHY_01': () => versionMixed([1700000000, 0], [1700000005, 0]),
    'G_VERSION_LAYERS_MISMATCHED_01': () => versionMixed([1700000010, 0], [1700000005, 0]),
};

const geminiTimestampPairsOrigin = derived(["tests/fixtures/gemini_timestamp_pairs.json"], "Saved Detail/structured content or measured timestamps with authored identity, RPC framing or boundary mutations.");

export const fixtureOrigins = describeFixtures(versionCases, synthetic("Authored Gemini protocol, content or state counterexample; no saved capture is used."), {
    G_VERSION_PAIR_DETAIL_01: geminiTimestampPairsOrigin,
    G_VERSION_PAIR_DETAIL_02: geminiTimestampPairsOrigin,
    G_VERSION_PAIR_DETAIL_03: geminiTimestampPairsOrigin,
    G_VERSION_PAIR_DETAIL_04: geminiTimestampPairsOrigin,
    G_VERSION_PAIR_DETAIL_05: geminiTimestampPairsOrigin,
    G_VERSION_PAIR_DETAIL_06: geminiTimestampPairsOrigin,
});
