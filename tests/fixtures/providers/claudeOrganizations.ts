import { describeFixtures, synthetic } from './provenance.js';
/** Native GET /api/organizations response bodies, including deliberate malformed variants. */
const id = '11111111-1111-4111-8111-111111111111';
const fixtureMap = {
    'CL_SOURCE_DISCOVERY_ORGANIZATIONS_01': () => [],
    'CL_ACCOUNT_MIXED_ROWS_01': () => [null, 'bad', 7, { uuid: id, name: '  Team A  ' }],
    'CL_ACCOUNT_CACHED_CHANGE_01': () => [{ uuid: id, name: 'Changed before expiry' }],
    'CL_ACCOUNT_NUMBER_NAME_01': () => [{ uuid: id, name: 42 }],
    'CL_ACCOUNT_BLANK_NAME_01': () => [{ uuid: id, name: '   ' }],
    'CL_ACCOUNT_INVALID_ENVELOPE_01': () => ({ error: 'not an array' }),
    'CL_ACCOUNT_HTTP_FAILURE_01': () => [{ uuid: id, name: 'valid' }],
};
export function organizationsGen<K extends keyof typeof fixtureMap>(key: K): ReturnType<(typeof fixtureMap)[K]> {
    return fixtureMap[key]() as ReturnType<(typeof fixtureMap)[K]>;
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Claude protocol, content or state counterexample; no saved capture is used."));
