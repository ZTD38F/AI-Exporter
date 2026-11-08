import type { ConversationKey } from '../../src/l2/conversationKey.js';
import { sameConversationKey } from '../../src/l2/conversationKey.js';
import { restoreDomainSnapshot, type TrustedDomain } from '../../src/l2/runtimeValidation.js';
import { getIndex, getDetail } from '../../src/l3a/storageService.js';

/** Test-only assembly; Application/Export owns the production read path, not L2. */
export async function readStoredConversation(key: ConversationKey): Promise<TrustedDomain | null> {
    const [index, detail] = await Promise.all([getIndex(key), getDetail(key)]);
    if (!index || !detail) return null;
    if (!sameConversationKey(key, index.key) || !sameConversationKey(key, detail.key))
        throw new TypeError('Stored conversation identity mismatch');
    return restoreDomainSnapshot({ index, detail });
}
