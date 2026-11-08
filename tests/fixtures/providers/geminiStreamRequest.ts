import { describeFixtures, synthetic } from './provenance.js';
/** Gemini StreamGenerate transport request samples. */
const fixtureMap = {
    'G_STREAM_E2E_REQUEST_01': () => 'f.req=test',
};

export function requestGen(key: keyof typeof fixtureMap): string {
    return fixtureMap[key]();
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Gemini protocol, content or state counterexample; no saved capture is used."));
