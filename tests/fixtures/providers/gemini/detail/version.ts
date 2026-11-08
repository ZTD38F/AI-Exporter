import { timestampPairs } from '../sources.js';

/** Original List+Detail source-version proof, now shared by keyed fixtures only. */
export function versionMixed(messageTime: number[], version?: number[], more = false, id = 'version_chat'): string {
    const turn = [['c_' + id, 'r_request'], null, [['Question']],
        [[['rc_answer', [['Answer']]]]], messageTime];
    const rows: Array<[string, unknown]> = [['hNvQHb', [[turn], more ? 'tCnext' : null, null, []]]];
    if (version) rows.push(['MaZiqc', [null, null, [['c_' + id, 'Source title', null, null, null, version]]]]);
    return JSON.stringify(rows.map(([name, payload]) => ['wrb.fr', name, JSON.stringify(payload)]));
}

export function versionPairDetail(index: number): string {
    const pairs: Array<{ metadataWire: number[]; detailTurnWire: number[] }> =
        timestampPairs;
    const pair = pairs[index];
    if (!pair) throw new Error('Missing Gemini timestamp pair ' + index);
    return versionMixed(pair.detailTurnWire, pair.metadataWire);
}

export function versionUnrelated(): string {
    const rows: Array<[string, unknown]> = [
        ['hNvQHb', [[[['c_actual_chat', 'r_req'], [1700000000, 0], [['Q']],
            [[['rc_a', [['A']]]]]]]]],
        ['MaZiqc', [null, null, [
            ['c_other_chat', 'Unrelated', null, null, null, [1700000005, 0]],
        ]]],
    ];
    return JSON.stringify(rows.map(([name, payload]) => ['wrb.fr', name, JSON.stringify(payload)]));
}
