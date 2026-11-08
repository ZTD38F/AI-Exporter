import { restoreConversationIndex, type DomainConversationIndex } from '../../src/l2/conversationIndex.js';
import { parseIndexMetadata } from '../../src/l1/parsers/shared/parseIndexMetadata.js';
import { normalizeTimestamp } from '../../src/l1/parsers/shared/time.js';
import { resolveTitle } from '../../src/l2/titleAuthority.js';
import { semanticTitleSource } from '../../src/l1/parsers/shared/parseIndexMetadata.js';
import { cleanTitle, isBrandPlaceholderTitle } from '../../src/shared/utils/titleText.js';
import { fixtureAccount } from './domainFixture.js';
/** Test source facts are explicitly bound before exercising canonical consumers. */
export function indexFixture(value: unknown): DomainConversationIndex {
    if (!value || typeof value !== 'object') throw new TypeError('Invalid fixture');
    const raw = value as Record<string, unknown>;
    if ('key' in raw) return restoreConversationIndex(value);
    const providerId = typeof raw.providerId === 'string' ? raw.providerId : 'gemini';
    const candidates = Object.entries(raw.titles && typeof raw.titles === 'object' ? raw.titles : {}).flatMap(([source, value]) => typeof value === 'string' && !isBrandPlaceholderTitle(value) ? [{ value: cleanTitle(value), source: semanticTitleSource(source) }] : []);
    if (typeof raw.title === 'string' && !isBrandPlaceholderTitle(raw.title)) candidates.unshift({ value: cleanTitle(raw.title), source: semanticTitleSource(typeof raw.titleSource === 'string' ? raw.titleSource : undefined) });
    const title = resolveTitle(candidates);
    return restoreConversationIndex({ key: { accountId: fixtureAccount(providerId).id, conversationId: providerId === 'gemini' ? String(raw.id).replace(/^c_/, '') : String(raw.id) }, ...parseIndexMetadata({ providerId, id: String(raw.id),
        title: title?.value ?? '', titleSource: title?.source,
        createdAt: normalizeTimestamp(raw.createdAt), updatedAt: normalizeTimestamp(raw.updatedAt ?? raw.timestamp ?? raw.chatTime) }) });
}
