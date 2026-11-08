import { describeFixtures, synthetic } from './provenance.js';
/** Native DELETE /api/organizations/:org/chat_conversations/:id response bodies. */
const fixtureMap = {
    'CL_L1_SOURCE_HOOK_DELETE_204_01': () => null,
};

export function deleteGen(key: keyof typeof fixtureMap): null {
    return fixtureMap[key]();
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Claude protocol, content or state counterexample; no saved capture is used."));
