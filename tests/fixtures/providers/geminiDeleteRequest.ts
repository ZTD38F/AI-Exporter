import { describeFixtures, synthetic, captured, derived } from './provenance.js';
import nativeDelete from '../gemini_native_delete.json';
/** Raw Gemini GzXR5e conversation deletion RPC request bodies. */
const fixtureMap = {
    'G_NATIVE_CAPTURE_DELETE_REQUEST_01': () => nativeDelete.requestBody,
    'G_NATIVE_CAPTURE_DELETE_DUPLICATE_REQUEST_01': () => {
        const requests = JSON.parse(new URLSearchParams(nativeDelete.requestBody).get('f.req')!);
        requests[0].push(requests[0][0]);
        return new URLSearchParams({ 'f.req': JSON.stringify(requests) }).toString();
    },
    'G_E2E_REALTIME_DELETE_REQUEST_01': () => new URLSearchParams({
        'f.req': JSON.stringify([[['GzXR5e', JSON.stringify(['c_8888abcd1234ef01']), null, 'generic']]]),
    }).toString(),
    'G_REGRESSION_MIXED_DELETE_REQUEST_01': () => new URLSearchParams({
        'f.req': JSON.stringify([[['otherRpc', JSON.stringify(['c_aabbccdd11223344'])],
            ['GzXR5e', JSON.stringify(['c_deadbeef00112233']), null, 'generic']]]),
    }).toString(),
    'G_REGRESSION_DELETE_NO_ID_REQUEST_01': () => 'f.req=[[["GzXR5e",null]]]',
    'G_REGRESSION_DECOY_DELETE_REQUEST_01': () =>
        'f.req=[["aabbccdd11223344"],["GzXR5e","c_deadbeef00112233"]]',
    'G_DELETE_SNIFFER_REQUEST_01': () => new URLSearchParams({
        'f.req': JSON.stringify([[['GzXR5e', JSON.stringify(['c_deadbeef00112233']), null, 'generic']]]),
    }).toString(),
    'G_FROZEN_CONTRACT_DELETE_REQUEST_01': () => new URLSearchParams({
        'f.req': JSON.stringify([[['GzXR5e', JSON.stringify(['c_deadbeef00112233']), null, 'generic']]]),
    }).toString(),
    'G_L1_VERIFIED_DELETE_REQUEST_01': () => new URLSearchParams({
        'f.req': JSON.stringify([[['GzXR5e', JSON.stringify([null, 'c_deadbeef00112233']), null, 'generic']]]),
    }).toString(),
};

export function deleteRequestGen(key: keyof typeof fixtureMap): string {
    return fixtureMap[key]();
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Gemini protocol, content or state counterexample; no saved capture is used."), {
    G_NATIVE_CAPTURE_DELETE_REQUEST_01: captured("tests/fixtures/gemini_native_delete.json", "sanitized requestBody"),
    G_NATIVE_CAPTURE_DELETE_DUPLICATE_REQUEST_01: derived(["tests/fixtures/gemini_native_delete.json"], "Saved source fields embedded in an authored protocol/state counterexample."),
});
