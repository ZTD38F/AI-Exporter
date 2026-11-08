import { hasGrokAccess } from '../../l1/client/grok/grokSource.js';
import { hasClaudeAccess } from '../../l1/client/claude/claudeSource.js';
import { getAccount } from '../../l3a/storageService.js';
import { isAccountId } from '../../l2/accountRegistry.js';
import { hasChatGPTAccess } from '../../l1/client/chatgpt/chatgptAccess.js';
import type { SourcePlatform } from '../../shared/platformHosts.js';

export function assertExtensionSender(sender: chrome.runtime.MessageSender): void {
    if (sender.id !== chrome.runtime.id) throw new Error('Foreign extension sender');
}
export function assertContentSender(sender: chrome.runtime.MessageSender): { providerId: SourcePlatform; tabId: number } {
    assertExtensionSender(sender);
    const url = sender.url && new URL(sender.url);
    const tabId = sender.tab?.id;
    if (tabId === undefined || !url || !['https://gemini.google.com', 'https://chatgpt.com', 'https://chat.openai.com', 'https://claude.ai', 'https://grok.com'].includes(url.origin)
        || (sender.frameId !== undefined && sender.frameId !== 0)) throw new Error('Unsupported Provider Content sender');
    const hostname = url.hostname;
    return { tabId, providerId: hostname === 'grok.com' ? 'grok' : hostname === 'gemini.google.com' ? 'gemini' : hostname === 'claude.ai' ? 'claude' : 'chatgpt' };
}
export function contentProviderId(sender: chrome.runtime.MessageSender): 'gemini' | 'chatgpt' | 'claude' | 'grok' {
    return assertContentSender(sender).providerId;
}
export async function requireContentContext(sender: chrome.runtime.MessageSender, accountId: unknown) {
    const { providerId, tabId } = assertContentSender(sender);
    if (!isAccountId(accountId)) throw new TypeError('Expected Account UUID');
    const account = await getAccount(accountId);
    if (!account || account.providerId !== providerId) throw new Error('Content Account/Provider mismatch');
    if (account.providerId === 'chatgpt' && !await hasChatGPTAccess()) throw new Error('ChatGPT site access revoked');
    if (account.providerId === 'grok' && !await hasGrokAccess()) throw new Error('Grok site access revoked');
    if (account.providerId === 'claude' && !await hasClaudeAccess()) throw new Error('Claude site access revoked');
    return { account, tabId };
}
/** Active operations must still belong to the sending document's current Account.
 * Passive ingestion deliberately uses requireContentContext and its captured request identity.
 */
export async function requireCurrentContentAccount(sender: chrome.runtime.MessageSender, accountId: unknown) {
    const { account, tabId } = await requireContentContext(sender, accountId);
    const response: unknown = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Current Tab Account check timed out')), 3000);
        try {
            chrome.tabs.sendMessage(tabId, { action: 'getAccountContext' },
                { frameId: 0, ...(sender.documentId ? { documentId: sender.documentId } : {}) }, value => {
                    clearTimeout(timer);
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message || 'Tab unavailable'));
                    else resolve(value);
                });
        } catch (error) { clearTimeout(timer); reject(error); }
    });
    const result = object(response);
    const context = object(result.accountContext);
    if (result.ok !== true || context.providerId !== account.providerId || context.accountId !== account.id) {
        throw new Error('Requested Account does not match the sending Tab');
    }
    if (account.providerId === 'grok' && !await hasGrokAccess()) throw new Error('Grok site access revoked');
    if (account.providerId === 'claude' && !await hasClaudeAccess()) throw new Error('Claude site access revoked');
    return account;
}
export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected message object');
    return value as Record<string, unknown>;
}
