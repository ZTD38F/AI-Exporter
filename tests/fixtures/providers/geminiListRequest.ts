import { describeFixtures, synthetic } from './provenance.js';
/** Native request bodies for the Gemini MaZiqc List RPC. */
const fixtureMap = {
    'G_E2E_PAGE_SYNC_LIST_REQUEST_01': () => new URLSearchParams({
        'f.req': JSON.stringify([[['MaZiqc', JSON.stringify([20, null, [0, null, 1]]), null, 'generic']]]),
    }).toString(),
    'G_E2E_TITLE_ARBITRATION_LIST_REQUEST_01': () => new URLSearchParams({
        'f.req': JSON.stringify([[['MaZiqc', JSON.stringify([20, null, [0, null, 1]]), null, 'generic']]]),
    }).toString(),
    'G_HOOK_GENERIC_PROBE_REQUEST_01': () => 'f.req=[[["wrb.fr",null]]]',
    'G_HOOK_MALFORMED_LIST_REQUEST_01': () => 'f.req=[[["MaZiqc",null]]]',
    'G_HOOK_LIST_CURSOR_REQUEST_01': () => new URLSearchParams({
        'f.req': JSON.stringify([[['MaZiqc', JSON.stringify([31, 'cursor', [0, null, 1]]), null, 'generic']]]),
    }).toString(),
    'G_HOOK_OVERRIDE_CREDENTIAL_REQUEST_01': () => 'f.req=payload&at=override_at_token&f.sid=override_sid',
    'G_REGRESSION_DECOY_LIST_REQUEST_01': () => 'f.req=[["MaZiqc",null]]',
    'G_PROTOCOL_NO_DELETE_ANCHOR_REQUEST_01': () => 'f.req=[["MaZiqc","aabbccdd11223344"]]',
    'G_E2E_UUID_LIST_REQUEST_01': () => new URLSearchParams({
        'f.req': JSON.stringify([[['MaZiqc', JSON.stringify([20, null, [0, null, 1]]), null, 'generic']]]),
    }).toString(),
    'G_PAGE_OBSERVATION_02_RECENT': () => ((streamId: 'recent' | 'pinned', cursor: string | null = null) => {
        const filter = [streamId === 'recent' ? 0 : 1, null, 1];
        return new URLSearchParams({ 'f.req': JSON.stringify([[['MaZiqc',
            JSON.stringify([50, cursor, filter]), null, 'generic']]]) }).toString();
    })('recent', 'incoming'),
    'G_PAGE_OBSERVATION_02_PINNED': () => ((streamId: 'recent' | 'pinned', cursor: string | null = null) => {
        const filter = [streamId === 'recent' ? 0 : 1, null, 1];
        return new URLSearchParams({ 'f.req': JSON.stringify([[['MaZiqc',
            JSON.stringify([50, cursor, filter]), null, 'generic']]]) }).toString();
    })('pinned', 'incoming'),
    'G_PAGE_OBSERVATION_05': () => new URLSearchParams({
        'f.req': JSON.stringify([[['MaZiqc', JSON.stringify([50, null, [2, null, 1]]), null, 'generic']]]),
    }).toString(),
    'G_PAGE_OBSERVATION_11_VALID': () => requestBody([null, null, 1, null, null, null, null, null, null, 1]),
    'G_PAGE_OBSERVATION_11_INVALID_0': () => requestBody([null, null, 1, null, null, null, null, null, null]),
    'G_PAGE_OBSERVATION_11_INVALID_1': () => requestBody([null, null, 1, null, null, null, null, null, null, 1, null]),
    'G_PAGE_OBSERVATION_11_INVALID_2': () => requestBody([null, null, 1, null, null, null, null, null, 1, 1]),
};
function requestBody(filter: unknown): string {
    return new URLSearchParams({ 'f.req': JSON.stringify([[['MaZiqc', JSON.stringify([31, null, filter]), null, 'generic']]]) }).toString();
}
export function requestGen(key: keyof typeof fixtureMap): string { return fixtureMap[key](); }

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Gemini protocol, content or state counterexample; no saved capture is used."));
