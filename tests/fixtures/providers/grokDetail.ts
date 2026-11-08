import { describeFixtures, synthetic, captured } from './provenance.js';
import { textDetail, imageDetailBody } from './grok/sources.js';

const fixtureMap = {
    'GR_DETAIL_TEXT_01': () => textDetail(),
    'GR_DETAIL_IMAGE_01': () => imageDetailBody(),
};

export function detailGen<K extends 'GR_DETAIL_TEXT_01' | 'GR_DETAIL_IMAGE_01'>(key: K): ReturnType<(typeof fixtureMap)[K]> {
    return fixtureMap[key]() as ReturnType<(typeof fixtureMap)[K]>;
}

// Compatibility exports for existing callers. New consumers can import the endpoint directly.
export { metadataGen } from './grokMetadata.js';
export { responsesGen } from './grokResponses.js';
export { treeGen } from './grokTree.js';

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Grok protocol, content or state counterexample; no saved capture is used."), {
    GR_DETAIL_TEXT_01: captured("tests/fixtures/providers/grokDetail.json", "saved metadata/tree/responses bundle"),
    GR_DETAIL_IMAGE_01: captured("tests/fixtures/providers/grokImageDetail.json", "saved image metadata/tree/responses bundle"),
});
