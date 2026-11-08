import type { Account } from '../../src/l2/accountRegistry.js';
import type { ConversationKey } from '../../src/l2/conversationKey.js';
import type { DomainAsset } from '../../src/l2/conversationDetail.js';
import type { ReadonlyDomain } from '../../src/l2/runtimeValidation.js';
import type { DocumentAst, DisplayBlock } from '../../src/l3b/ast/ast.js';

/**
 * L4 test doubles for the FROZEN upstream v2 data contracts.
 * All upstream dependencies are type-only: never execute L1/L2/L3b logic here.
 * These are INPUT fixtures, not surrogate parser/composer implementations.
 */
const V2_ACCOUNT_ID = '10000000-0000-4000-8000-000000000001';
export const V2_SECOND_ACCOUNT_ID = '10000000-0000-4000-8000-000000000002';

function v2Key(conversationId = 'same123456', accountId = V2_ACCOUNT_ID): ConversationKey {
    return { accountId, conversationId };
}
export function v2Account(providerId = 'gemini', accountId = V2_ACCOUNT_ID): Account {
    return { id: accountId, providerId, providerAccountId: providerId === 'gemini' ? '10000000001' : 'fixture-user' };
}
export function v2Conversation(title = 'Chat', assets: DomainAsset[] = [],
    options: { conversationId?: string; accountId?: string } = {}): ReadonlyDomain {
    const key = v2Key(options.conversationId, options.accountId);
    return {
        index: { key, title, titleSource: 'derived' },
        detail: { key: { ...key }, quality: { status: 'complete' }, assets, messages: [] },
    } satisfies ReadonlyDomain;
}
export function v2Document(blocks: DisplayBlock[], options: {
    title?: string; id?: string; provider?: string; role?: 'user' | 'assistant' | 'system' | 'developer' | 'unknown';
} = {}): DocumentAst {
    return {
        title: options.title ?? 'Fixture',
        metadata: { id: options.id ?? 'fixture', provider: options.provider ?? 'gemini' },
        messages: [{ role: options.role ?? 'assistant', blocks }],
    } satisfies DocumentAst;
}
