import { isAccountId } from './accountRegistry.js';

export interface ConversationKey { accountId: string; conversationId: string }
export function conversationKey(accountId: string, conversationId: string): ConversationKey {
    if (!isAccountId(accountId) || !conversationId || conversationId !== conversationId.trim()) throw new TypeError('Invalid conversation key');
    return { accountId, conversationId };
}
export function readConversationKey(value: unknown): ConversationKey {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'accountId' && k !== 'conversationId')) throw new TypeError('Invalid conversation key');
    // The source object is untrusted; read its fields before passing typed values to the constructor.
    const accountId = 'accountId' in value ? value.accountId : undefined;
    const conversationId = 'conversationId' in value ? value.conversationId : undefined;
    if (typeof accountId !== 'string' || typeof conversationId !== 'string') throw new TypeError('Invalid conversation key');
    return conversationKey(accountId, conversationId);
}
export function sameConversationKey(a: Readonly<ConversationKey>, b: Readonly<ConversationKey>): boolean {
    return a.accountId === b.accountId && a.conversationId === b.conversationId;
}
