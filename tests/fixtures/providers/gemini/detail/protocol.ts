/** Native batchexecute response bodies containing Gemini's hNvQHb Detail RPC. */
export const DOMAIN_ID = 'c_native12345678';

export const rpc = (inner: unknown): string => ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify(inner)]]);

export function emptyTurnWire(id: string, unknownDocument = false): string {
    const candidate = ['rc_empty', [''], null, []];
    const model: unknown[] = [[candidate], null, null, 'rc_empty'];
    model[8] = 'US'; model[12] = [[]]; model[24] = 1;
    if (unknownDocument) model[30] = [['unknown document']];
    return rpc([[[[id, 'r_empty'], null, [['']], model, [1757132274, 411870000]]], null, null, []]);
}

export function domainTurn(prompt = 'Question', seconds: number | null = 1700000000,
    candidates: unknown[] = [['rc_answer', [['Answer']]]], request = 'r_AB12'): unknown[] {
    return [[DOMAIN_ID, request], seconds === null ? null : [seconds, 0], [[prompt]], [candidates]];
}

/** Independent admission counterexamples based on the saved regression3 Turn layout. */
export function admissionWire(extra: unknown): string {
    const valid = [['c_admission', 'r_request'], [1700000000, 0], [['Real question']], [[['rc_answer', [['Real answer']]]]]];
    return rpc([[valid, extra]]);
}

/** Raw observability probes previously in parse_observability.test.ts. */
export function observabilityTurn(id = 'c_abc123def456', userPayload: unknown = [['hello']]): unknown[] {
    return [[id], [1700000000, 0], userPayload, [[['rc_cand000001', ['world'], 'en']]]];
}

/** Native Detail payloads for source-document and parser boundary tests. */
export function observabilityDocumentTurn(extraCand: unknown[]): unknown[] {
    const candidate: unknown[] = ['rc_cand000001', ['world'], 'en', ...extraCand];
    return [['c_abc123def456'], [1700000000, 0], [['hello']], [[candidate]]];
}

export const BOUNDARY_ID = 'c_boundary12345678';

export function boundaryTurn(prompt = 'Boundary user prompt', seconds: number | null = 1700000000,
    candidates: unknown[] = [['rc_boundary', [['Boundary model answer'], 'en']]]): unknown[] {
    return [[BOUNDARY_ID, 'r_AB12'], seconds === null ? null : [seconds, 500000000], [[prompt]], [candidates]];
}

/** Wire format local to the selected-candidate Detail response fixtures. */
export function selectedCandidates(): unknown[] {
    return [
        ['rc_displayed', [['## System Definition and Mass Balances\n\nDisplayed balance.']]],
        ['rc_alternative', [['## System Boundaries and Assumptions\n\nUnselected balance.']]],
    ];
}

export function selectedWire(candidates: unknown[], selected?: unknown): string {
    const model = [candidates, null, null, selected];
    const turn = [['c_selected12345678', 'r_request'], [1700000000, 0], [['Derive the mass balance.']], model];
    return ")]}'\n\n" + JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[turn]])]]);
}

/** Native hNvQHb payloads used by the independent dual-parser audit tests. */
export function dualAuditWire(markdown = 'Hello', document: unknown = { children: [{ nodeType: 18, text: 'Hello' }] }): string {
    const candidate: unknown[] = [[['rc_dualaudit', [markdown]]]];
    candidate[12] = document;
    return JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([[[['c_dualaudit', 'r_fixture'], [1700000000, 0], [['Question']], candidate]]])]]);
}

/** Exact Detail turn layout used by the P1-E source-wire regression cases. */
export function p1RegressionTurn(userPayload: unknown = [['hello']], text = 'world', extraCand: unknown[] = []): unknown[] {
    const candidate: unknown[] = ['rc_cand000001', [text], 'en', ...extraCand];
    return [['c_abc123def456'], [1700000000, 0], userPayload, [[candidate]]];
}

export function boundaryTop(inner: unknown): string {
    return JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify(inner)]]);
}

export function boundaryTitleWire(value: unknown): string {
    return rpc([[boundaryTurn('Newest prompt title'), boundaryTurn('Oldest prompt title')], null, value]);
}

/** Previously inline parser-boundary, false-envelope and native-title responses. */
export function boundarySelectedDraftWire(): string {
    const candidates = [
        ['rc_old', [['Old answer']]],
        ['rc_selected', [['Selected answer']]],
    ];
    const model = [candidates, null, 'google', 'rc_selected'];
    const raw = [[BOUNDARY_ID, 'r_AB12'], [1700000000, 500000000], [['Prompt']], model];
    return rpc([[raw]]);
}

export function boundaryCitationThoughtWire(): string {
    const body: unknown[] = [['Visible answer'], ['THOUGHT', 'First thought'],
        [null, 'thought-details', 'Second thought'], ['THOUGHT', null],
        ['https://example.com/source', 'First source title'],
        ['https://example.com/source', 'Duplicate title'],
        ['https://example.com/malformed', 42],
        ['https://googleusercontent.com/immersive_entry_chip/a', 'Internal chip']];
    return rpc([[boundaryTurn('Cited prompt', null, [['rc_cited', body]])]]);
}

export function p1BadLeadingDetailWire(): string {
    const junkStr = JSON.stringify({ data: [[['c_r_12345', [1, 2], 'music_tv talk', null]]] });
    const goodInner = JSON.stringify([[p1RegressionTurn()]]);
    return ")]}'\n\n" + JSON.stringify([
        ['x.fr', 'junk', junkStr],
        ['y.fr', 'data', goodInner],
    ]);
}
