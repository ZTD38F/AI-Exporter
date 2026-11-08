import { hasGrokAccess } from '../../l1/client/grok/grokSource.js';
import { hasClaudeAccess } from '../../l1/client/claude/claudeSource.js';
import { getOrCreateAccount } from '../../l2/accountAdmission.js';
import { ensureV2Ready } from './readiness.js';
import { requireContentContext, contentProviderId } from './contentSender.js';
import { hasChatGPTAccess } from '../../l1/client/chatgpt/chatgptAccess.js';

export function handleAccountRegistryMessage(message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void): boolean {
    if (!message || typeof message !== 'object' || !('action' in message) || message.action !== 'accountRegistry') return false;
    if (sender.id !== chrome.runtime.id) { respond({ ok: false, error: 'Foreign account registry sender' }); return true; }
    void (async () => {
        try {
            const senderProvider = contentProviderId(sender);
            await ensureV2Ready();
            if (!('command' in message)) throw new TypeError('Missing account registry command');
            // Extension pages list their own Registry directly. A Content script
            // must never enumerate other signed-in accounts across the IPC boundary.
            if (message.command === 'list') throw new Error('Account listing requires an Extension page');
            if (message.command === 'get' && 'accountId' in message && typeof message.accountId === 'string') {
                const { account } = await requireContentContext(sender, message.accountId);
                respond({ ok: true, value: account }); return;
            }
            if (message.command !== 'getOrCreate' || !('providerId' in message) || typeof message.providerId !== 'string'
                || !('providerAccountId' in message) || typeof message.providerAccountId !== 'string') throw new TypeError('Invalid account registry command');
            if (message.providerId !== senderProvider) throw new TypeError('Provider mismatch');
            if (message.providerId === 'chatgpt' && !await hasChatGPTAccess()) throw new Error('ChatGPT site access revoked');
            if (message.providerId === 'grok' && !await hasGrokAccess()) throw new Error('Grok site access revoked');
            if (message.providerId === 'claude' && !await hasClaudeAccess()) throw new Error('Claude site access revoked');
            const email = 'email' in message ? message.email : undefined;
            const displayName = 'displayName' in message ? message.displayName : undefined;
            if (email !== undefined && typeof email !== 'string' || displayName !== undefined && typeof displayName !== 'string') throw new TypeError('Invalid account profile');
            respond({ ok: true, value: await getOrCreateAccount(message.providerId, message.providerAccountId, email, displayName) });
        } catch (error) { respond({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    })();
    return true;
}
