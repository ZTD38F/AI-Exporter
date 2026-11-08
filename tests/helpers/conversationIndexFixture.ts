import { restoreConversationIndex, type DomainConversationIndex } from '../../src/l2/conversationIndex.js';
import type { ConversationKey } from '../../src/l2/conversationKey.js';
import { fixtureKey } from './domainFixture.js';

/** Canonical business-test input. Raw schema/parser/migration tests keep explicit inputs.
 * Dates stay absent unless the scenario supplies them; no fabricated activity version.
 * Validation returns a fresh key as well as a fresh index for every call.
 */
export function makeConversationIndex(
    overrides: Partial<Omit<DomainConversationIndex, 'key'>> & { key?: Partial<ConversationKey> } = {},
): DomainConversationIndex {
    return restoreConversationIndex({ title: 'Research', titleSource: 'derived', ...overrides,
        key: { ...fixtureKey(), ...overrides.key } });
}
