import { chatgptAccountObservation } from '../../l1/client/chatgpt/accountObservation.js';
import { CHATGPT_SOURCE_EVENT, chatGPTConversationId, chatGPTRequest, confirmedChatGPTDeletion } from '../../l1/sniffer/chatgpt/observation.js';
import { parseChatGPTConversation } from '../../l1/parsers/chatgpt/parseConversation.js';
import { parseChatGPTList } from '../../l1/parsers/chatgpt/parseList.js';
import { decodeChatGPTDetail } from '../../l1/parsers/chatgpt/decodeDetail.js';
import { ensureV2Ready } from '../api/runtimeReady.js';
import { resolveCurrentAccount, invalidateAccountContext, setAccountChangedHandler } from './accountContext.js';
import { BadgeView } from '../../ui/badge/badgeView.js';
import { LiveSaveCoordinator } from './liveSaveCoordinator.js';
import { registerCleanup, runCleanups } from './cleanupRegistry.js';
import { hookHistoryEvents } from './pageObserver.js';
import { ingestIndexes, ingestDetail, ingestDeletedConversation } from '../api/domainIngestion.js';

runCleanups();
invalidateAccountContext();
let active = true;
registerCleanup(() => { active = false; invalidateAccountContext(); });
LiveSaveCoordinator.init({ badge: BadgeView });
registerCleanup(LiveSaveCoordinator.cleanup);
const refreshAccount = () => { void BadgeView.refreshAccount().catch(error => console.warn('[ChatGPT badge]', error)); };
setAccountChangedHandler(refreshAccount);
hookHistoryEvents(refreshAccount);
void ensureV2Ready().then(() => {
    const mount = () => { if (active) BadgeView.ensureBadge(); };
    if (document.readyState !== 'loading') mount();
    else {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
        registerCleanup(() => document.removeEventListener('DOMContentLoaded', mount));
    }
}).catch(error => console.warn('[ChatGPT initialization]', error));

async function currentAccount() {
    const response = await fetch('/api/auth/session', { credentials: 'include' });
    const observation = response.ok ? chatgptAccountObservation(await response.json()) : null;
    const context = await resolveCurrentAccount(observation);
    return context && observation ? { ...observation, id: context.accountId } : null;
}
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object' || !('action' in message)) return false;
    if (message.action !== 'getAccountContext' && message.action !== 'ping') return false;
    void currentAccount().then(account => {
        const id = location.pathname.split('/c/')[1]?.split('/')[0];
        respond({ ok: true, accountContext: account ? { accountId: account.id, providerId: 'chatgpt' } : null,
            conversationId: chatGPTConversationId(id) ? id : null });
    }).catch(error => respond({ ok: false, error: String(error) }));
    return true;
});

let queue = Promise.resolve();
window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || !('type' in data)
        || data.type !== CHATGPT_SOURCE_EVENT || !('payload' in data)) return;
    const raw = data.payload;
    queue = queue.catch(() => {}).then(async () => {
        if (!raw || typeof raw !== 'object' || !('url' in raw) || typeof raw.url !== 'string'
            || !('kind' in raw)
            || !('requestIdentity' in raw) || typeof raw.requestIdentity !== 'string' || !('responseBody' in raw)) return;
        const method = raw.kind === 'detail' || raw.kind === 'list' ? 'GET' : raw.kind === 'delete' ? ('method' in raw && raw.method === 'DELETE' ? 'DELETE' : 'PATCH') : raw.kind === 'stream' ? 'POST' : '';
        const source = new URL(raw.url);
        const request = raw.kind === 'sidebar' && source.origin === location.origin
            ? { kind: 'sidebar' as const } : chatGPTRequest(raw.url, method);
        if (!request || request.kind !== raw.kind) return;
        const account = await currentAccount();
        if (!account || account.providerAccountId !== raw.requestIdentity) return;
        if (request.kind === 'list' || request.kind === 'sidebar') {
            const parsed = parseChatGPTList(raw.responseBody);
            if (parsed.conversations.some(item => !chatGPTConversationId(item.id))) return;
            // A loaded sidebar page is useful Index evidence, but is not proof
            // that all remote history has been scanned. Do not invent Coverage.
            await ingestIndexes(account.id, parsed.conversations.map(item => ({
                conversationId: item.id,
                fields: { ...(item.title ? { title: item.title, titleSource: 'provider' as const } : {}),
                    ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}),
                    ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}) },
            })));
            return;
        }
        if (!('conversationId' in raw) || !chatGPTConversationId(raw.conversationId)
            || request.conversationId && request.conversationId !== raw.conversationId) return;
        const key = { accountId: account.id, conversationId: raw.conversationId };
        if (request.kind === 'delete') {
            if ('requestBody' in raw && confirmedChatGPTDeletion(raw.requestBody, raw.responseBody, method)) await ingestDeletedConversation(account.id, key.conversationId);
            return;
        }
        if (request.kind === 'detail') {
            let conversation;
            try { conversation = decodeChatGPTDetail(raw.responseBody, key.conversationId); }
            catch (error) {
                if (error instanceof TypeError) return; // Malformed or foreign source evidence.
                throw error;
            }
            const parsed = parseChatGPTConversation({ account, conversation, assetsByNode: new Map() });
            const admission = await ingestDetail(account.id, key.conversationId, parsed.conversation.detail, parsed.conversation.index);
            if (!admission.accepted || !admission.changed) return;
        }
        // The worker rechecks the sending document's current Account. A stream
        // completion refreshes through the production provider before saving.
        await LiveSaveCoordinator.executeLiveSave(key, request.kind === 'stream');
    }).catch(error => console.warn('[ChatGPT capture]', error));
});
