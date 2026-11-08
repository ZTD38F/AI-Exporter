import { describeFixtures, synthetic } from './provenance.js';
/** Native request bodies for Gemini's hNvQHb Detail RPC. */
function requestBody(args: unknown[]): string {
    return new URLSearchParams({
        'f.req': JSON.stringify([[['hNvQHb', JSON.stringify(args), null, 'generic']]]),
    }).toString();
}

const fixtureMap = {
    'G_TIER2_CAPTURE_NATIVE_REQUEST_01': () => new URLSearchParams({
        'f.req': JSON.stringify([[['hNvQHb', JSON.stringify(['c_target', null])]]]),
    }).toString(),
    'G_E2E_TITLE_ARBITRATION_DETAIL_REQUEST_01': () =>
        requestBody(['c_sniff_test_chat_888', 10, null, 1, [1], [4], null, 1]),
    'G_E2E_PRODUCTION_PASSIVE_DETAIL_REQUEST_01': () =>
        requestBody(['c_passive', null, null, 1, [1], [4], null, 1]),
    'G_E2E_UUID_DETAIL_REQUEST_STALE_01': () =>
        requestBody(['c_staleuuid123', 10, null, 1, [1], [4], null, 1]),
    'G_E2E_UUID_DETAIL_REQUEST_CURRENT_01': () =>
        requestBody(['c_currentuuid123', 10, null, 1, [1], [4], null, 1]),
    'G_L1_DETAIL_REQUEST_VALID_01': () =>
        requestBody(['c_source_chat_123', 10, 'tC_NEXT_PAGE_123456789', 1, [1], [4], null, 1]),
    'G_L1_DETAIL_REQUEST_TRUNCATED_01': () =>
        requestBody(['c_source_chat_123', 10, 'tC_NEXT_PAGE_123456789']),
    'G_L1_DETAIL_REQUEST_GARBAGE_01': () => 'garbage',
};

export function requestGen(key: keyof typeof fixtureMap): string {
    return fixtureMap[key]();
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Gemini protocol, content or state counterexample; no saved capture is used."));
