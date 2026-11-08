import { describeFixtures, synthetic, derived } from '../../provenance.js';
import { e2eProductionMixed, l1ContractWire } from './integration.js';
import { geminiDetailIdentityVariant } from '../../geminiRpcCapture.js';

export const integrationCases = {
    'G_E2E_PRODUCTION_PASSIVE_MIXED_01': () =>
        e2eProductionMixed('passive', 'Question from passive capture', 'Answer from passive capture', 'Passive detail'),
    'G_E2E_PRODUCTION_NATIVE_AUDIT_MIXED_01': () =>
        e2eProductionMixed('production', 'Question production', 'Current native answer', 'Current title'),
    'G_E2E_PRODUCTION_CONTINUED_MIXED_01': () =>
        e2eProductionMixed('abcdef123456', 'Final prompt', 'Final appended answer', 'Current continued title'),
    'G_E2E_UUID_DETAIL_STALE_01': () => geminiDetailIdentityVariant('staleuuid123'),
    'G_E2E_UUID_DETAIL_CURRENT_01': () => geminiDetailIdentityVariant('currentuuid123'),
    'G_L1_CONTRACT_DETAIL_DEFAULT_01': () => l1ContractWire(),
    'G_L1_CONTRACT_DETAIL_NEWER_01': () => l1ContractWire('Newer', 'tC_NEXT_PAGE_123456789'),
    'G_L1_CONTRACT_DETAIL_OLDER_01': () => l1ContractWire('Older'),
    'G_MESSAGE_BRIDGE_DETAIL_01': () => geminiDetailIdentityVariant('bridge_chat_123'),
    'G_LIVE_SAVE_OBSERVER_01': () => geminiDetailIdentityVariant('passive123'),
    'G_MESSAGE_ROUTER_LIVE_SAVE_01': () => geminiDetailIdentityVariant('source_sniff_123'),
    'G_L1_VERIFIED_DETAIL_1167_01': () =>
        String.fromCharCode(41, 93, 125, 39) + '\n\n' + JSON.stringify([['wrb.fr', 'hNvQHb', null, null, null, ['BardErrorInfo', 1167]]]),
    'G_L1_VERIFIED_DETAIL_1096_01': () =>
        String.fromCharCode(41, 93, 125, 39) + '\n\n' + JSON.stringify([['wrb.fr', 'hNvQHb', null, null, null, ['BardErrorInfo', 1096]]]),
    'G_L1_VERIFIED_DETAIL_1096_02': () =>
        String.fromCharCode(41, 93, 125, 39) + '\n\n' + JSON.stringify([['wrb.fr', 'hNvQHb', null, null, null, ['BardErrorInfo', 1096]]]),
};

const detailAndPinnedOrigin = derived(["tests/fixtures/provider/gemini_rpc/detail-and-pinned.json"], "Saved Detail/structured content or measured timestamps with authored identity, RPC framing or boundary mutations.");
const recentOrigin = derived(["tests/fixtures/provider/gemini_list/recent.json"], "Saved Detail/structured content or measured timestamps with authored identity, RPC framing or boundary mutations.");

export const fixtureOrigins = describeFixtures(integrationCases, synthetic("Authored Gemini protocol, content or state counterexample; no saved capture is used."), {
    G_E2E_UUID_DETAIL_STALE_01: detailAndPinnedOrigin,
    G_E2E_UUID_DETAIL_CURRENT_01: detailAndPinnedOrigin,
    G_L1_CONTRACT_DETAIL_DEFAULT_01: recentOrigin,
    G_L1_CONTRACT_DETAIL_NEWER_01: recentOrigin,
    G_L1_CONTRACT_DETAIL_OLDER_01: recentOrigin,
    G_MESSAGE_BRIDGE_DETAIL_01: detailAndPinnedOrigin,
    G_LIVE_SAVE_OBSERVER_01: detailAndPinnedOrigin,
    G_MESSAGE_ROUTER_LIVE_SAVE_01: detailAndPinnedOrigin,
});
