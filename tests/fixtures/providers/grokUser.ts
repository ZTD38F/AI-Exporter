import { describeFixtures, synthetic } from './provenance.js';
/** Synthetic account identities, never inferred from a captured conversation ID. */
const fixtureMap = {
    'GR_USER_PROVIDER_01': () => ({ userId: '11111111-1111-4111-8111-111111111111' }),
    'GR_USER_E2E_01': () => ({ userId: '11111111-1111-4111-8111-111111111111', givenName: 'Grok fixture account' }),
};
export function userGen(key: keyof typeof fixtureMap) { return fixtureMap[key](); }

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Grok protocol, content or state counterexample; no saved capture is used."));
