import type { Account } from '../../../l2/accountRegistry.js';
import type { DomainConversationIndex } from '../../../l2/conversationIndex.js';
import type { TitleSource } from '../../../l2/titleAuthority.js';
import { cleanTitle, isRealTitle, isBrandPlaceholderTitle } from '../../../shared/utils/titleText.js';
import { normId, isReservedRoute } from '../../../shared/utils/pathUtils.js';

type ConversationIngestionSource = 'detail' | 'takeout' | 'snapshot';
export function semanticTitleSource(source?: string): TitleSource {
    return source === 'user' ? 'user' : ['rpc', 'api-detail', 'dom', 'provider', 'openai'].includes(source ?? '') ? 'provider' : 'derived';
}
interface ParsedMetadataInput {
    account?: Account; providerId: string; id: string; title?: string; titleSource?: string;
    createdAt?: number; updatedAt?: number; activityAt?: number; url?: string; messageCount?: number;
}
/** Source paths become semantics here. Domain never ranks RPC versus DOM. */
export function parseIndexMetadata(input: ParsedMetadataInput, source: ConversationIngestionSource = 'detail'): Omit<DomainConversationIndex, 'key'> {
    const id = input.providerId === 'gemini' ? normId(input.id) : input.id.trim();
    if (!id || input.providerId === 'gemini' && (id === 'unknown' || isReservedRoute(id))) throw new TypeError('Invalid conversation identity');
    const candidate = cleanTitle(input.title);
    const title = !isBrandPlaceholderTitle(candidate) && (isRealTitle(candidate, id) || (input.providerId !== 'gemini' || source === 'takeout' || input.titleSource === 'takeout') && candidate) ? candidate : undefined;
    return {
        ...(title ? { title, titleSource: semanticTitleSource(input.titleSource ?? (source === 'takeout' ? 'takeout' : undefined)) } : {}),
        ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}), ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}), ...(input.activityAt !== undefined ? { activityAt: input.activityAt } : {}) };
}
