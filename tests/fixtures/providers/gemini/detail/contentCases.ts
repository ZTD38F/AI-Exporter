import { describeFixtures, synthetic, derived } from '../../provenance.js';
import { coverageTextNode, coverageWire, citationText, citationField, citationSourceAnnotation, citationSourceTable, citationWire, citationInvalidFileMarker, citationCompositeWire, citationInlineCombinedWire } from './content.js';
import { dualAuditWire, boundaryCitationThoughtWire } from './protocol.js';
import { citationFile } from './sources.js';

export const contentCases = {
    'G_BOUNDARY_THOUGHT_CITATION_01': () => boundaryCitationThoughtWire(),
    'G_STRUCTURED_CITATION_COMPOSITE_PARAGRAPH_01': () => citationCompositeWire('paragraph'),
    'G_STRUCTURED_CITATION_COMPOSITE_LIST_01': () => citationCompositeWire('list'),
    'G_STRUCTURED_CITATION_COMPOSITE_TABLE_01': () => citationCompositeWire('table'),
    'G_STRUCTURED_CITATION_COMPOSITE_QUOTE_01': () => citationCompositeWire('quote'),
    'G_STRUCTURED_CITATION_INLINE_COMBINED_01': () => citationInlineCombinedWire(),
    'G_STRUCTURED_CITATION_MATH_FILE_CHIP_01': () => citationWire({ children: [
        { nodeType: 12, FTa: 'a=b' },
        { nodeType: 'citation', number: 1, title: 'test_config.json' },
    ] }),
    'G_GROUNDING_CITATION_MARKERS_01': () => {
        const inner = [
            [
                [
                    ['c_533ac8ca2ecb8bd7', 'r_turn_u0'],
                    [1700000000, 0],
                    ['Load configuration test_config.json', 0],
                    null,
                ],
                [
                    ['c_533ac8ca2ecb8bd7', 'r_turn_m1'],
                    [1700000005, 0],
                    null,
                    [[
                        [
                            'rc_candidate_0',
                            [['Loaded \`test_config.json\`[cite: 1]:\n\n* **status**: \`"ok"\`[cite: 1]']],
                            null, null, null, null, null, null, null, null, null, null,
                            [{ '8': [], '44': [
                                [['[cite: 1]', 0], [[null, [[null, 0, 'test_config.json', null, [3, null, 'File attachment']]]]]],
                            ] }],
                        ],
                    ]],
                ],
            ],
            null,
            'c_533ac8ca2ecb8bd7',
        ];
        return ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify(inner)]]);
    },
    'G_STRUCTURED_CITATIONS_38': () => {
        const good = citationField(31, [[['[cite: 1]', 0], [[null, [[null, 0, 'file.json', null, null, null, null, null, 1, null, null, 'application/json'], null, null, null, null, null, 'file.json']]], ['quote', 0]]]);
        good[32] = 'unknown visible payload';
        return citationWire([[[good]]]);
    },
    'G_STRUCTURED_CITATIONS_29': () => citationWire(
        [[[citationText('body', [citationSourceAnnotation(0, 99)])]]],
        citationSourceTable()),
    'G_STRUCTURED_CITATIONS_30': () => citationWire(
        [[[citationText('body', [citationSourceAnnotation(0, 4, [])])]]],
        citationSourceTable()),
    'G_STRUCTURED_CITATIONS_31': () => citationWire(
        [[[citationText('body', [citationSourceAnnotation(0, 4, ['unknown'])])]]],
        citationSourceTable()),
    'G_STRUCTURED_CITATIONS_32': () => citationWire(
        [[[citationText('body', [[0, 4, [null, null, null, [null, ['spp_fixture']], 'unknown']]])]]],
        citationSourceTable()),
    'G_STRUCTURED_CITATIONS_33': () => citationWire(
        [[[citationText('body', [[0, 4, [[null, null, null, null, 2], null, null, [null, []]]]])]]],
        citationSourceTable()),
    'G_STRUCTURED_CITATIONS_34': () => citationWire(
        [[[citationText('body', [citationSourceAnnotation(0, 3), [2, 4, [[null, null, null, null, 2]]]])]]],
        citationSourceTable()),
    'G_STRUCTURED_CITATIONS_35': () => citationWire(
        [[[citationText('body', [[0, 4, [[null, null, null, null, 3]]], citationSourceAnnotation(1, 3)])]]],
        citationSourceTable()),
    'G_STRUCTURED_CITATIONS_36': () => {
        const table = citationSourceTable();
        const rows = table[1] as unknown[][];
        rows.push([['same ID different URL'], [1], [['https://example.com/conflict', 'Conflict']], 'spp_fixture']);
        return citationWire([[[citationText('body', [citationSourceAnnotation(0, 4)])]]], table);
    },
    'G_STRUCTURED_CITATIONS_37': () => citationWire(
        [[[citationText('body', [citationSourceAnnotation(0, 4)])]]],
        citationSourceTable([['javascript:bad', 'Bad']])),
    'G_STRUCTURED_CITATIONS_15': () => citationInvalidFileMarker('[cite: 1]'),
    'G_STRUCTURED_CITATIONS_16': () => citationInvalidFileMarker('[cite: 1, 1]'),
    'G_STRUCTURED_CITATIONS_17': () => citationInvalidFileMarker('[cite: 1, 0]'),
    'G_STRUCTURED_CITATIONS_18': () => citationInvalidFileMarker('[cite: 1, 2, 3]'),
    'G_STRUCTURED_CITATIONS_19': () => citationInvalidFileMarker('[cite: 1, unknown]'),
    'G_STRUCTURED_CITATIONS_20': () => citationWire({ children: [citationField(13, [[]])] }),
    'G_STRUCTURED_CITATIONS_21': () => citationWire({ children: [citationField(13, ['invalid'])] }),
    'G_STRUCTURED_CITATIONS_22': () => citationWire({ children: [
        citationField(13, [[citationText('valid'), citationField(38, ['unknown'])]]),
    ] }),
    'G_STRUCTURED_CITATIONS_23': () => citationWire({ children: [
        { nodeType: 'paragraph', children: [{ nodeType: 1, code: 'not inline' }] },
    ] }),
    'G_STRUCTURED_CITATIONS_24': () => citationWire({ children: [
        { nodeType: 'paragraph', children: [{ nodeType: 18, text: 'heading', jJ: 2 }] },
    ] }),
    'G_STRUCTURED_CITATIONS_25': () => citationWire([[[citationField(31, [])]]]),
    'G_STRUCTURED_CITATIONS_26': () => citationWire([[[citationField(31, [['[cite: 1]', 0]])]]]),
    'G_STRUCTURED_CITATIONS_27': () => citationWire([[[citationField(31, [
        [['[cite: 0]', 0], [], ['quote', 0]],
    ])]]]),
    'G_STRUCTURED_CITATIONS_28': () => citationWire([[[citationField(31, [
        [['[cite: 1]', 0], [], ['quote', 0]],
    ])]]]),
    'G_STRUCTURED_CITATIONS_01': () => citationWire(citationFile('live-file-citations')),
    'G_STRUCTURED_CITATIONS_02': () => citationWire(citationFile('live-optics-table-citations')),
    'G_STRUCTURED_CITATIONS_03': () => citationWire(citationFile('live-blockquote')),
    'G_STRUCTURED_CITATIONS_04': () => {
        const quote = citationField(16, [[citationText('different quoted text')]]);
        return citationWire({ children: [{ nodeType: 20, items: [{ children: [quote] }] }] });
    },
    'G_STRUCTURED_CITATIONS_05': () => citationWire([[[citationField(16, [])]]]),
    'G_STRUCTURED_CITATIONS_06': () => citationWire([[[citationField(16, [[]])]]]),
    'G_STRUCTURED_CITATIONS_07': () => citationWire([[[citationField(16, ['bad'])]]]),
    'G_STRUCTURED_CITATIONS_08': () => citationWire([[[citationField(16, [[citationField(38, ['unknown'])]])]]]),
    'G_STRUCTURED_CITATIONS_09': () => {
        const quote = citationField(16, [[citationText('different quoted text')]]);
        quote[17] = 'conflicting content';
        return citationWire([[[quote]]]);
    },
    'G_STRUCTURED_CITATIONS_10': () => citationWire(citationFile('live-combined-file-citations')),
    'G_STRUCTURED_CITATIONS_11': () => citationWire(
        citationFile('live-source-attributions'), citationFile('live-source-table')),
    'G_STRUCTURED_CITATIONS_12': () => {
        const table = citationSourceTable([
            ['https://example.com/a', 'A'], ['https://example.com/b', 'B'],
            ['https://example.com/a', 'A'],
        ]);
        const raw = [[[citationText('😀 bold italic [1]', [
            citationSourceAnnotation(0, 14),
            [3, 14, [[null, null, null, null, 2]]],
            [8, 14, [[null, null, null, null, 1]]],
        ])]]];
        return citationWire(raw, table);
    },
    'G_STRUCTURED_CITATIONS_13': () => {
        const raw = [[[citationText('body', [citationSourceAnnotation(0, 4)])]]];
        return citationWire(raw, undefined, [
            ['rc_alternative', [['other body']], citationSourceTable()],
        ]);
    },
    'G_STRUCTURED_CITATIONS_14': () => {
        const raw = [[[citationText('body', [citationSourceAnnotation(0, 4)])]]];
        return citationWire(raw, citationSourceTable(), [['rc_alternative', [['other body']]]]);
    },
    'G_DUAL_AUDIT_01': () => dualAuditWire(),
    'G_DUAL_AUDIT_02': () => dualAuditWire(),
    'G_DUAL_AUDIT_03': () => dualAuditWire('Independent raw Markdown'),
    'G_DUAL_AUDIT_04': () => dualAuditWire(),
    'G_DUAL_AUDIT_05': () => dualAuditWire('Independent answer [cite: 1]', { children: [
        { nodeType: 'paragraph', children: [{ nodeType: 18, text: 'Native answer' },
            { nodeType: 'citation', number: 1, title: 'test_config.json' }] },
    ] }),
    'G_DUAL_AUDIT_06': () => dualAuditWire('Hello', null),
    'G_DUAL_AUDIT_07': () => dualAuditWire('Hello', { children: [{ nodeType: 999, text: 'Hello' }] }),
    'G_DUAL_AUDIT_08': () => dualAuditWire('Hello', { children: [] }),
    'G_DUAL_AUDIT_09': () => dualAuditWire(),
    'G_DUAL_AUDIT_10': () => dualAuditWire(),
    'G_DUAL_AUDIT_11': () => dualAuditWire('DIFFERENT'),
    'G_DUAL_AUDIT_12': () => dualAuditWire(),
    'G_DUAL_AUDIT_13': () => dualAuditWire('Hello', null),
    'G_DUAL_AUDIT_14': () => dualAuditWire(),
    'G_DUAL_AUDIT_15': () => dualAuditWire(),
    'G_STRUCTURED_COVERAGE_01': () => coverageWire(citationFile('live-range-coder')),
    'G_STRUCTURED_COVERAGE_02': () => {
        const leaf = coverageTextNode('PRIVATE_SOURCE_TEXT', 999);
        const list = Object.assign(Array(12).fill(null), { 11: [[[[leaf]]]] });
        return coverageWire([[[coverageTextNode('known', 3), list]]]);
    },
    'G_STRUCTURED_COVERAGE_03': () => coverageWire(undefined),
    'G_STRUCTURED_COVERAGE_04': () => coverageWire(
        citationFile('live-imagen-panel'),
        [['rc_image', [['\n']]]],
    ),
};

const liveCombinedFileCitationsOrigin = derived(["tests/fixtures/provider/structured_rpc/live-combined-file-citations.json"], "Saved Detail/structured content or measured timestamps with authored identity, RPC framing or boundary mutations.");

export const fixtureOrigins = describeFixtures(contentCases, synthetic("Authored Gemini protocol, content or state counterexample; no saved capture is used."), {
    G_STRUCTURED_CITATION_INLINE_COMBINED_01: liveCombinedFileCitationsOrigin,
    G_STRUCTURED_CITATIONS_15: liveCombinedFileCitationsOrigin,
    G_STRUCTURED_CITATIONS_16: liveCombinedFileCitationsOrigin,
    G_STRUCTURED_CITATIONS_17: liveCombinedFileCitationsOrigin,
    G_STRUCTURED_CITATIONS_18: liveCombinedFileCitationsOrigin,
    G_STRUCTURED_CITATIONS_19: liveCombinedFileCitationsOrigin,
    G_STRUCTURED_CITATIONS_01: derived(["tests/fixtures/provider/structured_rpc/live-file-citations.json"], "Saved Detail/structured content or measured timestamps with authored identity, RPC framing or boundary mutations."),
    G_STRUCTURED_CITATIONS_02: derived(["tests/fixtures/provider/structured_rpc/live-optics-table-citations.json"], "Saved Detail/structured content or measured timestamps with authored identity, RPC framing or boundary mutations."),
    G_STRUCTURED_CITATIONS_03: derived(["tests/fixtures/provider/structured_rpc/live-blockquote.json"], "Saved Detail/structured content or measured timestamps with authored identity, RPC framing or boundary mutations."),
    G_STRUCTURED_CITATIONS_10: liveCombinedFileCitationsOrigin,
    G_STRUCTURED_CITATIONS_11: derived(["tests/fixtures/provider/structured_rpc/live-source-attributions.json", "tests/fixtures/provider/structured_rpc/live-source-table.json"], "Saved Detail/structured content or measured timestamps with authored identity, RPC framing or boundary mutations."),
    G_STRUCTURED_COVERAGE_01: derived(["tests/fixtures/provider/structured_rpc/live-range-coder.json"], "Saved Detail/structured content or measured timestamps with authored identity, RPC framing or boundary mutations."),
    G_STRUCTURED_COVERAGE_04: derived(["tests/fixtures/provider/structured_rpc/live-imagen-panel.json"], "Saved Detail/structured content or measured timestamps with authored identity, RPC framing or boundary mutations."),
});
