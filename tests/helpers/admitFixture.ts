import { ingestDetail } from '../../src/l2/ingestion.js';
import { readStoredConversation } from './readStoredConversation.js';
import { deleteStoredConversation } from '../../src/l3a/storageService.js';
import type { ConversationKey } from '../../src/l2/conversationKey.js';
import type { DomainFixture } from './domainFixture.js';
import { fixtureAccountFor } from './domainFixture.js';
/** Historical fixture identity only; persistence keys contain no provider routing data. */
export function storageIdentity(_providerId: string, accountId: string, conversationId: string): ConversationKey {
    return { accountId, conversationId };
}
export async function admitFixture(accountId: string | null | undefined, parsed: DomainFixture): Promise<DomainFixture> {
    if (!accountId || parsed.account.id !== accountId) throw new TypeError('Detail account/provider mismatch');
    const { index, detail } = parsed.conversation;
    await ingestDetail(accountId, index.key.conversationId,
        { ...detail, ...(parsed.sourceVersion !== undefined ? { savedAt: parsed.sourceVersion } : {}) }, index);
    const result = await readFixture(index.key);
    if (!result) throw new Error('Fixture Detail missing');
    return result;
}
export async function readFixture(key: ConversationKey): Promise<DomainFixture | null> {
    const conversation = await readStoredConversation(key);
    return conversation ? { account: fixtureAccountFor(conversation), conversation, diagnostics: [], resourceHints: {}, acquisitionHints: {} } : null;
}
export async function removeFixture(key: ConversationKey): Promise<void> { await deleteStoredConversation(key); }
