import { describeFixtures, synthetic } from './provenance.js';
/** Raw SSE text from POST /backend-api/f/conversation. One key per source event/chunk. */
const fixtureMap = {
    'C_STREAM_EVENT_01': () => 'data: [DONE]',
    'C_STREAM_EVENT_02': () => 'data: ' + JSON.stringify({
        v: { conversation_id: '6acffdc5-c4d0-83e8-8e1b-ba60979a618a' },
    }),
    'C_STREAM_EVENT_03': () => 'data: ' + JSON.stringify({
        conversation_id: '6acffdc5-c4d0-83e8-8e1b-ba60979a618a',
    }),
    'C_STREAM_EVENT_INVALID_01': () => 'data: {"v":{"conversation_id":"invalid"}}',
    'C_STREAM_EVENT_INVALID_02': () => 'data: ["v1"]',
    'C_STREAM_EVENT_INVALID_03': () => 'event: done',
    'C_STREAM_EVENT_INVALID_04': () => 'data: not json',
    'C_STREAM_CAPTURE_CHUNK_01': () => 'data: ' + JSON.stringify({
        v: { conversation_id: '6acffdc5-c4d0-83e8-8e1b-ba60979a618a' },
    }) + '\n\ndata: [DONE]\n\n',
};

export function streamGen(key: keyof typeof fixtureMap): string {
    return fixtureMap[key]();
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored ChatGPT protocol, content or state counterexample; no saved capture is used."));
