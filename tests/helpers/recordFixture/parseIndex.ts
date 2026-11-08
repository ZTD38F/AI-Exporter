import type { Account } from '../../../src/l2/accountRegistry.js';
import { semanticTitleSource, parseIndexMetadata } from '../../../src/l1/parsers/shared/parseIndexMetadata.js';
import { restoreConversationIndex, type DomainConversationIndex } from '../../../src/l2/conversationIndex.js';
import { normalizeTimestamp } from '../../../src/l1/parsers/shared/time.js';
import { cleanTitle, isRealTitle, isBrandPlaceholderTitle } from '../../../src/shared/utils/titleText.js';
import { isTitleSource, resolveTitle, type TitleCandidate } from '../../../src/l2/titleAuthority.js';
import { normId, isReservedRoute } from '../../../src/shared/utils/pathUtils.js';

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid index source record');
    return value as Record<string, unknown>;
}
/** Historical times alone accept seconds-looking numeric strings. Native times never guess units. */
function legacyTime(value: unknown): number | undefined {
    if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
        const number = Number(value);
        return Number.isFinite(number) ? number < 1e11 ? number * 1000 : number : undefined;
    }
    return normalizeTimestamp(value);
}
/** Explicit fixture/source conversion; never used to recover persisted Index rows. */
export function parseLegacyConversationIndex(value: unknown, account: Account): DomainConversationIndex {
    const row = object(value);
    if (typeof row.id !== 'string' && typeof row.id !== 'number') throw new TypeError('Index source has no identity');
    const candidates: TitleCandidate[] = [];
    if (typeof row.title === 'string' && !isBrandPlaceholderTitle(row.title)) candidates.push({ value: cleanTitle(row.title), source: semanticTitleSource(typeof row.titleSource === 'string' ? row.titleSource : undefined) });
    if (row.titles && typeof row.titles === 'object') for (const [source, value] of Object.entries(row.titles)) {
        if (typeof value === 'string' && !isBrandPlaceholderTitle(value)) candidates.push({ value: cleanTitle(value), source: semanticTitleSource(source) });
    }
    const title = resolveTitle(candidates);
    const conversationId = account.providerId === 'gemini' ? normId(String(row.id)) : String(row.id);
    return restoreConversationIndex({ key: { accountId: account.id, conversationId }, ...parseIndexMetadata({ providerId: account.providerId, id: String(row.id),
        title: title?.value ?? '', titleSource: title?.source,
        createdAt: legacyTime(row.createdAt), updatedAt: legacyTime(row.updatedAt) ?? legacyTime(row.timestamp) ?? legacyTime(row.chatTime) }) });
}
