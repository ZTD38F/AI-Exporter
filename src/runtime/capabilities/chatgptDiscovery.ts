import { getOrCreateAccount } from '../api/accountRegistry.js';
import { hasChatGPTAccess, ensureChatGPTRegistered } from '../../l1/client/chatgpt/chatgptAccess.js';
import { readChatGPTSession } from '../../l1/client/chatgpt/accountObservation.js';
import type { Account } from '../../l2/accountRegistry.js';
import { syncPlatformContentScripts } from './platformInjection.js';

/** Optional host access is granted explicitly in Options; discovery never prompts. */
export async function discoverChatGPTAccounts(): Promise<Account[]> {
    if (!await hasChatGPTAccess()) return [];
    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
    if (!tabs.length) return [];
    const response = await fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' });
    if (!response.ok) throw new Error(`ChatGPT session failed: ${response.status}`);
    const session: unknown = await response.json();
    const { observation, accessToken } = readChatGPTSession(session);
    if (!observation || !accessToken) return [];
    await ensureChatGPTRegistered();
    await syncPlatformContentScripts('chatgpt');
    return [await getOrCreateAccount(observation.providerId, observation.providerAccountId,
        observation.email, observation.displayName)];
}
