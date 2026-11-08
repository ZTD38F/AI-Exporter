import { GROK_SOURCE_EVENT, grokRequest } from '../../l1/sniffer/grok/observation.js';
import { grokUuid } from '../../l1/parsers/grok/source.js';
import { parseGrokList } from '../../l1/parsers/grok/parseList.js';
import { observeGrokAccount } from '../../l1/client/grok/accountObservation.js';
import { ensureV2Ready } from '../api/runtimeReady.js';
import { invalidateAccountContext, resolveCurrentAccount, setAccountChangedHandler } from './accountContext.js';
import { BadgeView } from '../../ui/badge/badgeView.js';
import { LiveSaveCoordinator } from './liveSaveCoordinator.js';
import { registerCleanup, runCleanups } from './cleanupRegistry.js';
import { hookHistoryEvents } from './pageObserver.js';
import { ingestIndexes, ingestDeletedConversation } from '../api/domainIngestion.js';
import { getSettings, isLiveSaveEffective } from '../../application/settings/index.js';

runCleanups(); invalidateAccountContext();
let active = true;
registerCleanup(() => { active = false; invalidateAccountContext(); });
LiveSaveCoordinator.init({ badge: BadgeView });
registerCleanup(LiveSaveCoordinator.cleanup);
async function currentAccount() {
    const observation = await observeGrokAccount();
    const context = await resolveCurrentAccount(observation);
    return context && observation ? { ...observation, id: context.accountId } : null;
}
const conversationId = () => {
    const id = /^\/c\/([^/]+)\/?$/.exec(location.pathname)?.[1];
    return grokUuid(id) ? id : null;
};
let timer: ReturnType<typeof setTimeout> | undefined;
let queue = Promise.resolve();
const pending = new Map<string, string>();
function scheduleSave(id: string, owner: string) {
    clearTimeout(timer);
    pending.set(id, owner);
    timer = setTimeout(() => {
        const ids = [...pending]; pending.clear();
        queue = queue.catch(() => {}).then(async () => {
            for (const [id, owner] of ids) {
                if (!active || !isLiveSaveEffective(await getSettings(), true)) continue;
                const account = await currentAccount();
                if (active && account && account.providerAccountId === owner) await LiveSaveCoordinator.executeLiveSave({ accountId: account.id, conversationId: id }, true);
            }
        }).catch(error => console.warn('[Grok save]', error));
    }, 1000);
}
function routeChanged() {
    void BadgeView.refreshAccount().catch(console.warn);
    const id = conversationId();
    if (id) void currentAccount().then(account => {
        if (active && account && conversationId() === id) scheduleSave(id, account.providerAccountId);
    }).catch(console.warn);
}
setAccountChangedHandler(routeChanged); hookHistoryEvents(routeChanged);
registerCleanup(() => { clearTimeout(timer); pending.clear(); });
void ensureV2Ready().then(() => {
    const mount = () => { if (active) { BadgeView.ensureBadge(); routeChanged(); } };
    if (document.readyState !== 'loading') mount();
    else { document.addEventListener('DOMContentLoaded', mount, { once: true });
        registerCleanup(() => document.removeEventListener('DOMContentLoaded', mount)); }
}).catch(console.warn);
const onMessage = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object' || !('action' in message)
        || !['ping', 'getAccountContext'].includes(String(message.action))) return false;
    void currentAccount().then(account => respond({ ok: true,
        accountContext: account ? { accountId: account.id, providerId: 'grok' } : null, conversationId: conversationId() }))
        .catch(error => respond({ ok: false, error: String(error) }));
    return true;
};
chrome.runtime.onMessage.addListener(onMessage);
registerCleanup(() => chrome.runtime.onMessage.removeListener(onMessage));
const receive = (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || !('type' in data)
        || data.type !== GROK_SOURCE_EVENT || !('payload' in data)) return;
    const raw = data.payload;
    queue = queue.catch(() => {}).then(async () => {
        if (!active || !raw || typeof raw !== 'object' || !('url' in raw) || typeof raw.url !== 'string'
            || !('method' in raw) || typeof raw.method !== 'string' || !('owner' in raw) || !grokUuid(raw.owner)
            || !('status' in raw) || typeof raw.status !== 'number' || raw.status < 200 || raw.status >= 300) return;
        const request = grokRequest(raw.url, raw.method), account = await currentAccount();
        if (!request || !account || account.providerAccountId !== raw.owner || !active) return;
        if (request.kind === 'list' && 'responseBody' in raw) {
            const parsed = parseGrokList(raw.responseBody);
            // Native filtered lists prove rows, never global Coverage.
            await ingestIndexes(account.id, parsed.conversations.map(row => ({ conversationId: row.id, fields: {
                updatedAt: row.updatedAt, ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
                ...(row.title ? { title: row.title, titleSource: 'provider' as const } : {}) } })));
        } else if (request.kind === 'delete' && request.conversationId) {
            pending.delete(request.conversationId);
            await ingestDeletedConversation(account.id, request.conversationId);
        } else if (request.conversationId) scheduleSave(request.conversationId, raw.owner);
    }).catch(error => console.warn('[Grok capture]', error));
};
window.addEventListener('message', receive);
registerCleanup(() => window.removeEventListener('message', receive));

// Grok may deliver replies over a persistent transport without a fetch response.
// DOM changes are only a wake-up signal: the provider still reads the native tree
// and all message bodies, and rechecks account ownership before committing.
let mutationTimer: ReturnType<typeof setTimeout> | undefined;
let signature = '';
const observer = new MutationObserver(records => {
    if (!records.some(record => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        return target && !target.closest('#geminiExportBadge,[contenteditable="true"],textarea');
    })) return;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
        if (!active) return;
        const id = conversationId();
        const next = id + ':' + [...document.querySelectorAll('[id^="response-"]')]
            .map(element => [element.textContent, [...element.querySelectorAll('img')].map(img => img.src).join(',')].join(':')).join('\n');
        if (!id || next === signature) return;
        signature = next;
        void currentAccount().then(account => {
            if (active && account && conversationId() === id) scheduleSave(id, account.providerAccountId);
        }).catch(console.warn);
    }, 1500);
});
observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
registerCleanup(() => { observer.disconnect(); clearTimeout(mutationTimer); });
