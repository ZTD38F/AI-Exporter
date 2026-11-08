import { describeFixtures, synthetic, captured, derived } from './provenance.js';
import { textDetail } from './grok/sources.js';

const fixtureMap = {
    'GR_TREE_STABLE_01': () => textDetail().tree,
    'GR_TREE_INFLIGHT_01': () => {
        const tree = textDetail().tree;
        tree.inflightResponses.push({});
        return tree;
    },
};

export function treeGen(key: keyof typeof fixtureMap) { return fixtureMap[key](); }

export const fixtureOrigins = describeFixtures(fixtureMap, synthetic("Authored Grok protocol, content or state counterexample; no saved capture is used."), {
    GR_TREE_STABLE_01: captured("tests/fixtures/providers/grokDetail.json", "response-tree endpoint body"),
    GR_TREE_INFLIGHT_01: derived(["tests/fixtures/providers/grokDetail.json"], "Saved source fields embedded in an authored protocol/state counterexample."),
});
