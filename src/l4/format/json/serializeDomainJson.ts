import { readAccount, type Account } from '../../../l2/accountRegistry.js';
import { sameConversationKey } from '../../../l2/conversationKey.js';
import type { ReadonlyDomain } from '../../../l2/runtimeValidation.js';
import type { ResourceBindings } from '../../packaging/resourceBindings.js';

export const JSON_ARCHIVE_VERSION = 1;
/** A versioned semantic archive, independent of storage and transport implementations. */
export function serializeDomainJson(conversation: ReadonlyDomain, account: Readonly<Account>, resources: ResourceBindings): string {
    readAccount(account);
    if (account.id !== conversation.index.key.accountId || !sameConversationKey(conversation.index.key, conversation.detail.key)) throw new TypeError('JSON Account/key mismatch');
    return JSON.stringify({ format: 'gemini-exporter-domain', version: JSON_ARCHIVE_VERSION, account, conversation, resources }, null, 2);
}
