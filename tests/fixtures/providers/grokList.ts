import { describeFixtures, synthetic, derived } from './provenance.js';
import { conversationRow as row, conversationId } from './grok/sources.js';

/** List variants reuse captured metadata; envelopes/cursors are explicit synthetic states. */
const fixtureMap = {
    'GR_LIST_TERMINAL_01': () => ({ conversations: [row()] }),
    'GR_LIST_CONTINUATION_01': () => ({ conversations: [row()], nextPageToken: conversationId }),
    'GR_LIST_EMPTY_01': () => ({ conversations: [] }),
    'GR_LIST_EMPTY_TOKEN_01': () => ({ conversations: [], nextPageToken: '' }),
    'GR_LIST_NULL_TOKEN_01': () => ({ conversations: [], nextPageToken: null }),
    'GR_LIST_NUMBER_TOKEN_01': () => ({ conversations: [], nextPageToken: 12 }),
    'GR_LIST_FOREIGN_TOKEN_01': () => ({ conversations: [], nextPageToken: '../foreign' }),
    'GR_LIST_BLANK_TITLE_01': () => ({ conversations: [{ ...row(), title: '   ' }] }),
    'GR_LIST_NUMBER_TITLE_01': () => ({ conversations: [{ ...row(), title: 12 }] }),
    'GR_LIST_DUPLICATE_01': () => ({ conversations: [row(), row()] }),
    'GR_LIST_MISSING_TIME_01': () => ({ conversations: [{ ...row(), modifyTime: null }] }),
};
export function listGen<K extends keyof typeof fixtureMap>(key: K): ReturnType<(typeof fixtureMap)[K]> {
    return fixtureMap[key]() as ReturnType<(typeof fixtureMap)[K]>;
}

const grokDetailOrigin = derived(["tests/fixtures/providers/grokDetail.json"], "Captured conversation metadata inside synthetic List envelopes, cursors or malformed fields.");

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Grok protocol, content or state counterexample; no saved capture is used."), {
    GR_LIST_TERMINAL_01: grokDetailOrigin,
    GR_LIST_CONTINUATION_01: grokDetailOrigin,
    GR_LIST_BLANK_TITLE_01: grokDetailOrigin,
    GR_LIST_NUMBER_TITLE_01: grokDetailOrigin,
    GR_LIST_DUPLICATE_01: grokDetailOrigin,
    GR_LIST_MISSING_TIME_01: grokDetailOrigin,
});
