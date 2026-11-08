import { describeFixtures, synthetic, captured } from './provenance.js';
import { metadataBody } from './grok/sources.js';

const fixtureMap = {
    'GR_METADATA_01': () => metadataBody(),
};

export function metadataGen(key: keyof typeof fixtureMap) { return fixtureMap[key](); }

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Grok protocol, content or state counterexample; no saved capture is used."), {
    GR_METADATA_01: captured("tests/fixtures/providers/grokDetail.json", "metadata endpoint body"),
});
