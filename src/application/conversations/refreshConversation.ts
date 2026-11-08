import type { ConversationKey } from '../../l2/conversationKey.js';
import { getAccount } from '../../runtime/api/accountRegistry.js';
import { createTaskProvider } from '../../l1/client/taskProvider.js';
import { createSourceResourceContext } from '../../l1/resources/sourceResources.js';

/** Verified reply completion updates source facts independently of disk delivery settings. */
export async function refreshConversation(key: ConversationKey): Promise<void> {
    const account = await getAccount(key.accountId);
    if (!account) throw new Error('Account unavailable');
    const resources = createSourceResourceContext();
    try {
        await createTaskProvider(account.providerId, resources).fetchConversationDetail(key.accountId, key.conversationId);
    } finally {
        resources.release();
    }
}
