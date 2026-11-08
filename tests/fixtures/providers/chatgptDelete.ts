import { describeFixtures, synthetic } from './provenance.js';
/** Native acknowledgement bodies from ChatGPT conversation visibility PATCH and DELETE. */
const fixtureMap = {
    'C_CAPTURE_PATCH_CONFIRMED_01': () => ({ success: true }),
    'C_CAPTURE_PATCH_VISIBLE_01': () => ({ success: true }),
    'C_CAPTURE_PATCH_REJECTED_01': () => ({ success: false }),
    'C_CAPTURE_PATCH_EMPTY_01': () => ({}),
    'C_CAPTURE_PATCH_STRING_SUCCESS_01': () => ({ success: 'true' }),
    'C_CAPTURE_DELETE_CONFIRMED_01': () => ({ success: true }),
    'C_CAPTURE_DELETE_NULL_01': () => null,
    'C_CAPTURE_DELETE_EMPTY_01': () => ({}),
    'C_CAPTURE_DELETE_REJECTED_01': () => ({ success: false }),
    'C_CAPTURE_DELETE_STRING_SUCCESS_01': () => ({ success: 'true' }),
};

export function deleteGen(key: keyof typeof fixtureMap): { success?: boolean | string } | null {
    return fixtureMap[key]();
}

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored ChatGPT protocol, content or state counterexample; no saved capture is used."));
