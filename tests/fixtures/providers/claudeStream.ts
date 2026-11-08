import { describeFixtures, synthetic } from './provenance.js';
/** Native POST /completion, /completion2 and retry_completion* SSE body samples. */
const fixtureMap = {
    'CL_L1_SOURCE_HOOK_COMPLETION_01': () => 'data: {"type":"message_stop"}\n\n',
};

export function streamGen(key: keyof typeof fixtureMap): string {
    return fixtureMap[key]();
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Claude protocol, content or state counterexample; no saved capture is used."));
