import type { ConversationKey } from './conversationKey.js';
import { sameConversationKey } from './conversationKey.js';
import { restoreDomainSnapshot, type TrustedDomain } from './runtimeValidation.js';
import { getIndex, getDetail } from '../l3a/storageService.js';
/** Persistence does not carry trust. L2 validates restored facts and requested ownership. */
export async function readConversation(key: ConversationKey): Promise<TrustedDomain | null> {
    const index = await getIndex(key), detail = await getDetail(key);
    if (!index || !detail) return null;
    const conversation = restoreDomainSnapshot({ index, detail });
    if (!sameConversationKey(key, index.key)) throw new TypeError('Stored conversation identity mismatch');
    return conversation;
}
