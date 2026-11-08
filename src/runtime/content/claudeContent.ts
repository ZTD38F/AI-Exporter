import { CLAUDE_SOURCE_EVENT, claudeRequest, claudeUuid } from '../../l1/sniffer/claude/observation.js';
import { observeClaudeAccount } from '../../l1/client/claude/accountObservation.js';
import { parseClaudeConversation } from '../../l1/parsers/claude/parseConversation.js';
import { parseClaudeList } from '../../l1/parsers/claude/parseList.js';
import { ensureV2Ready } from '../api/runtimeReady.js';
import { resolveCurrentAccount, invalidateAccountContext, setAccountChangedHandler } from './accountContext.js';
import { BadgeView } from '../../ui/badge/badgeView.js';
import { LiveSaveCoordinator } from './liveSaveCoordinator.js';
import { registerCleanup, runCleanups } from './cleanupRegistry.js';
import { hookHistoryEvents } from './pageObserver.js';
import { ingestIndexes, ingestDetail, ingestDeletedConversation } from '../api/domainIngestion.js';
import { getSettings } from '../../application/settings/index.js';
import { createClaudeVisitSave } from './claudeVisitSave.js';
runCleanups();
invalidateAccountContext();
let active = true;
registerCleanup(() => { active = false; invalidateAccountContext(); });
LiveSaveCoordinator.init({ badge: BadgeView });
registerCleanup(LiveSaveCoordinator.cleanup);
const refreshAccount = () => { void BadgeView.refreshAccount().catch(error => console.warn('[Claude badge]', error)); };
const visitSave = createClaudeVisitSave({ path: () => location.pathname, settings: getSettings,
    account: currentAccount, save: LiveSaveCoordinator.executeLiveSave });
let visitTimer: ReturnType<typeof setTimeout> | undefined;
function routeChanged() {
    refreshAccount();
    visitSave.observe(location.pathname);
    clearTimeout(visitTimer);
    visitTimer = setTimeout(() => { if (active) void visitSave.save().catch(error => console.warn('[Claude visit save]', error)); }, 750);
}
setAccountChangedHandler(routeChanged);
hookHistoryEvents(routeChanged);
registerCleanup(() => clearTimeout(visitTimer));
void ensureV2Ready().then(() => {
    const mount = () => { if (active) { BadgeView.ensureBadge(); routeChanged(); } };
    if (document.readyState !== 'loading') mount();
    else {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
        registerCleanup(() => document.removeEventListener('DOMContentLoaded', mount));
    }
}).catch(error => console.warn('[Claude initialization]', error));

async function currentAccount() {
    const observation = await observeClaudeAccount();
    const context = await resolveCurrentAccount(observation);
    return context && observation ? { ...observation, id: context.accountId } : null;
}
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object' || !('action' in message)) return false;
    if (message.action !== 'getAccountContext' && message.action !== 'ping') return false;
    void currentAccount().then(account => {
        const id = location.pathname.split('/chat/')[1]?.split('/')[0];
        respond({ ok: true, accountContext: account ? { accountId: account.id, providerId: 'claude' } : null,
            conversationId: claudeUuid(id) ? id : null });
    }).catch(error => respond({ ok: false, error: String(error) }));
    return true;
});
let queue = Promise.resolve();
const receive = (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || !('type' in data)
        || data.type !== CLAUDE_SOURCE_EVENT || !('payload' in data)) return;
    const raw = data.payload;
    queue = queue.catch(() => {}).then(async () => {
        if (!active || !raw || typeof raw !== 'object' || !('url' in raw) || typeof raw.url !== 'string'
            || !('method' in raw) || typeof raw.method !== 'string' || !('responseBody' in raw)
            || !('status' in raw) || typeof raw.status !== 'number' || raw.status < 200 || raw.status >= 300) return;
        const request = claudeRequest(raw.url, raw.method);
        const account = await currentAccount();
        if (!request || !account || account.providerAccountId !== request.organization) return;
        if (request.kind === 'list') {
            const parsed = parseClaudeList(raw.responseBody && typeof raw.responseBody === 'object' && 'data' in raw.responseBody ? raw.responseBody.data : raw.responseBody);
            await ingestIndexes(account.id, parsed.conversations.map(item => ({ conversationId: item.id,
                fields: { ...(item.title ? { title: item.title, titleSource: 'provider' as const } : {}),
                    ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}), updatedAt: item.updatedAt } })));
            return;
        }
        const cid = request.conversationId;
        if (!cid) return;
        if (request.kind === 'delete') {
            await ingestDeletedConversation(account.id, cid);
            return;
        }
        if (request.kind === 'detail') {
            const parsed = parseClaudeConversation(raw.responseBody, cid);
            const admission = await ingestDetail(account.id, cid, parsed.conversation.detail, parsed.conversation.index);
            if (!admission.accepted) return;
            visitSave.nativeDetail(cid);
        }
        await LiveSaveCoordinator.executeLiveSave({ accountId: account.id, conversationId: cid }, request.kind === 'stream');
    }).catch(error => console.warn('[Claude capture]', error));
};
window.addEventListener('message', receive);
registerCleanup(() => window.removeEventListener('message', receive));
// Initial history can be server-rendered, without a list request. Visible links
// prove only these index rows; they do not establish time ordering or Coverage.
let sidebarTimer: ReturnType<typeof setTimeout> | undefined;
let sidebarSignature = '';
const captureSidebar = async () => {
    const rows = [...document.querySelectorAll<HTMLAnchorElement>('a[data-row-main-button][href*="/chat/"],nav a[href*="/chat/"],aside a[href*="/chat/"]')]
        .map(a => ({ id: new URL(a.href).pathname.split('/chat/')[1], title: a.textContent?.trim() }))
        .filter((row): row is { id: string; title: string } => claudeUuid(row.id) && !!row.title);
    const signature = JSON.stringify(rows);
    if (!rows.length || signature === sidebarSignature) return;
    const account = await currentAccount();
    if (!account || !active) return;
    await ingestIndexes(account.id, [...new Map(rows.map(row => [row.id, row])).values()].map(row => ({
        conversationId: row.id, fields: { title: row.title, titleSource: 'provider' as const },
    })));
    sidebarSignature = signature;
};
const observer = new MutationObserver(() => {
    clearTimeout(sidebarTimer);
    sidebarTimer = setTimeout(() => { void captureSidebar().catch(console.warn); }, 500);
});
observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
void captureSidebar().catch(console.warn);
registerCleanup(() => { observer.disconnect(); clearTimeout(sidebarTimer); });
