import { listGen as geminiListGen } from '../../gemini.js';

export function mixedNativePage(request: string, seconds: number, cursor: string | null = null): string {
    const turn = [['c_native', request], [seconds, 0], [['Question ' + request]],
        [[['rc_' + request, [['**Answer**']]]]]];
    return JSON.stringify([
        ['wrb.fr', 'hNvQHb', JSON.stringify([[turn], cursor, 'Title'])],
        ['wrb.fr', 'MaZiqc', JSON.stringify([null, null,
            [['c_native', 'Title', null, null, null, [1700000010, 0]]]])],
    ]);
}

/** Complete native batchexecute batches for production E2E passive/live-save audit. */
export function e2eProductionMixed(id: string, question: string, answer: string, title: string): string {
    const turn = [['c_' + id, 'r_question'], [1700000000, 0], [[question]],
        [[['rc_question', [[answer]]]]]];
    return JSON.stringify([
        ['wrb.fr', 'hNvQHb', JSON.stringify([[turn], null])],
        ['wrb.fr', 'MaZiqc', JSON.stringify([null, null, [
            ['c_' + id, title, null, null, null, [1700000000, 0]],
        ]])],
    ]);
}
/** Original L1 mixed Detail+List source response; the List half is the existing List key. */
export function l1ContractWire(prompt = 'Question', next: string | null = null): string {
    const frame = JSON.stringify([
        ['wrb.fr', 'hNvQHb', JSON.stringify([[
            [['c_source_chat_123', 'r_' + prompt], [1700000000, 0], [[prompt]],
                [[['rc_' + prompt, [['Answer']]]]]],
        ], next])],
    ]);
    return geminiListGen('G_L1_CONTRACT_01') + `${frame.length + 2}\n${frame}\n`;
}

export function parserBundledTitleWire(): string {
    const detailInner = [[
        [['c_d3226d9a046c1116', 'r_turn_1'], null,
            [['然后mod要怎么打呢，我下载了一个mod文件，但是https://www.nexusmods.com/slaythespire2/mods/91']],
            [[['rc_model_1', ['这是Mod安装解答内容']]]]],
    ], null, null];
    const metaInner = [null, null,
        [['c_d3226d9a046c1116', '杀戮尖塔存档删除Mod风险',
            null, null, null, [1774139824, 809290000], null, null, null, 2]]];
    return ")]}'\n\n" + JSON.stringify([
        ['wrb.fr', 'hNvQHb', JSON.stringify(detailInner)],
        ['wrb.fr', 'MaZiqc', JSON.stringify(metaInner)],
    ]);
}
