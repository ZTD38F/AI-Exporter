import { exportSummary } from '../shared/exportSummary.js';
import { resourceIssueKind } from '../../shared/resources/resourceResult.js';
import { getSettings } from '../../application/settings/index.js';
import type { ExportResult } from '../../application/export/types.js';
import { getAccountContext, resolveCurrentAccount } from '../../runtime/content/accountContext.js';
import { registerCleanup } from '../../runtime/content/cleanupRegistry.js';
import { text, useSettings, observeSettings, isDeveloperMode } from '../shared/settings.js';

let badge: HTMLElement | null = null;
let accountId: string | null = null;
let count: number | null = null;
let extensionContextInvalidated = false;
let feedback: 'ok' | 'partial' | 'failed' | 'unavailable' | null = null;
let feedbackResult: ExportResult | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let countPoll: ReturnType<typeof setInterval> | undefined;
let dragging = false;
let alive = false;
let positionChanged = false;
const clearFeedback = () => { clearTimeout(timer); timer = undefined; feedback = null; feedbackResult = null; };
const stopCountPolling = () => {
    if (countPoll !== undefined) clearInterval(countPoll);
    countPoll = undefined;
};
const startCountPolling = () => {
    stopCountPolling();
    if (!alive || !accountId || document.hidden) return;
    countPoll = setInterval(() => {
        const id = accountId;
        if (id) void refreshIndexCount(id);
    }, 60_000);
};
function render(): void {
    const label = badge?.querySelector('#geminiExportBadgeText');
    if (!label) return;
    const visibleFeedback = !isDeveloperMode() && feedbackResult?.attachmentIssues?.length
        && feedbackResult.otherPartial === 0 && !feedbackResult.failed.length && !feedbackResult.aborted ? 'ok' : feedback;
    badge?.classList.toggle('live-save-warning', visibleFeedback === 'unavailable');
    if (badge) badge.title = feedbackResult ? exportSummary(feedbackResult) : '';
    label.textContent = extensionContextInvalidated || !chrome.runtime?.id
        ? text('Extension updated. Refresh this page.', '插件已更新，请刷新页面')
        : visibleFeedback === 'unavailable' ? text('Saved; source attachments unavailable', '已保存，部分来源附件无法获取')
        : visibleFeedback === 'ok' ? text('✓ Saved', '✓ 已保存')
        : visibleFeedback === 'partial' ? text('Some content was not saved', '部分内容未保存')
        : visibleFeedback === 'failed' ? text('Save failed', '保存失败')
        : !accountId ? text('Current account unavailable', '无法识别当前账户')
        : count === null ? text('Count unavailable', '数量暂不可用')
        : text(`${count} conversation${count === 1 ? '' : 's'} indexed`, `已收录 ${count} 条对话`);
}
function position(left: number, top: number): void {
    if (!badge) return;
    badge.style.left = `${Math.max(8, Math.min(left, innerWidth - badge.offsetWidth - 8))}px`;
    badge.style.top = `${Math.max(8, Math.min(top, innerHeight - badge.offsetHeight - 8))}px`;
    badge.style.right = 'auto'; badge.style.bottom = 'auto';
}
async function refreshAccount(): Promise<void> {
    const cachedId = getAccountContext()?.accountId ?? null;
    if (cachedId !== accountId) { accountId = null; count = null; clearFeedback(); stopCountPolling(); render(); }
    const context = await resolveCurrentAccount();
    if (!alive) return;
    const id = context?.accountId ?? null;
    if (id !== (getAccountContext()?.accountId ?? null) || accountId === id) return;
    accountId = id; count = null; clearFeedback(); render();
    startCountPolling();
    if (id && !document.hidden) await refreshIndexCount(id);
}
/** Badge-internal count Pull: never requires Index-commit push callbacks. */
async function refreshIndexCount(id: string): Promise<void> {
    if (id !== accountId || !alive) return;
    try {
        const response: unknown = await chrome.runtime.sendMessage({ action: 'getLocalIndexCount', accountId: id });
        if (!alive || accountId !== id || getAccountContext()?.accountId !== id) return;
        if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true
            || !('count' in response) || typeof response.count !== 'number'
            || !Number.isInteger(response.count) || response.count < 0) throw new Error('Invalid index count');
        count = response.count;
    } catch (error) {
        if (alive && accountId === id && getAccountContext()?.accountId === id) {
            count = null;
            if (error instanceof Error && error.message.includes('Extension context invalidated')) extensionContextInvalidated = true;
        }
    }
    render();
}
/** One final result per task. Null/skipped do not create a notification. */
function showLiveSaveResultImpl(result: ExportResult | null, id: string): void {
    if (!result || !alive || !id || id !== accountId) return;
    const outcome = result.failed.length || result.aborted ? 'failed'
        : result.exported && result.partial ? (result.attachmentIssues?.length && result.attachmentIssues.every(issue => resourceIssueKind(issue) === 'expired') && result.otherPartial === 0 ? 'unavailable' : 'partial') : result.exported ? 'ok' : null;
    if (!outcome) return;
    clearFeedback(); feedback = outcome; feedbackResult = result; render();
    timer = setTimeout(() => { feedback = null; feedbackResult = null; timer = undefined; render(); }, 3000);
}
function showLiveSaveErrorImpl(id: string): void {
    if (!alive || id !== accountId) return;
    clearFeedback(); feedback = 'failed'; render();
    timer = setTimeout(() => { feedback = null; feedbackResult = null; timer = undefined; render(); }, 3000);
}
function ensureBadgeImpl(): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    if (badge) { if (!badge.isConnected) (document.body || document.documentElement).append(badge); return badge; }
    const element = document.createElement('div');
    badge = element; badge.id = 'geminiExportBadge'; alive = true;
    badge.setAttribute('role', 'button'); badge.tabIndex = 0;
    // Restore main's styled badge and pulse; keep v2 identity/count/drag lifecycle.
    // The stylesheet is already injected by manifest.json. Inline styles here previously overrode it.
    const pulse = document.createElement('span'); pulse.className = 'pulse';
    const label = document.createElement('span'); label.id = 'geminiExportBadgeText';
    badge.append(pulse, label);
    let moved = false, startX = 0, startY = 0, left = 0, top = 0;
    badge.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        dragging = true; moved = false; startX = event.clientX; startY = event.clientY;
        const rect = element.getBoundingClientRect(); left = rect.left; top = rect.top;
        element.setPointerCapture(event.pointerId);
    });
    badge.addEventListener('pointermove', event => {
        if (!dragging || Math.hypot(event.clientX - startX, event.clientY - startY) < 4 && !moved) return;
        moved = true; positionChanged = true; position(left + event.clientX - startX, top + event.clientY - startY);
    });
    badge.addEventListener('pointerup', event => {
        if (!dragging) return; dragging = false;
        element.releasePointerCapture(event.pointerId);
        if (moved) {
            const rect = element.getBoundingClientRect();
            void chrome.runtime.sendMessage({ action: 'updateBadgePosition',
                position: { left: Math.round(rect.left), top: Math.round(rect.top) } })
                .then((reply: unknown) => {
                    if (reply && typeof reply === 'object' && 'ok' in reply && reply.ok === true) return;
                    throw new Error(reply && typeof reply === 'object' && 'error' in reply && typeof reply.error === 'string'
                        ? reply.error : 'Badge position update failed');
                })
                .catch(console.warn);
        }
    });
    badge.addEventListener('pointercancel', () => { dragging = false; moved = true; });
    const open = () => {
        void resolveCurrentAccount().catch(() => null)
            .then(context => chrome.runtime.sendMessage({ action: 'openOptions', accountId: context?.accountId ?? null }))
            .catch(console.warn);
    };
    badge.addEventListener('click', event => { if (moved) { moved = false; event.preventDefault(); return; } open(); });
    badge.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    (document.body || document.documentElement).append(badge); render();
    let previousPosition: string | undefined;
    const refreshSettings = async () => {
        const settings = await getSettings();
        if (!alive) return;
        useSettings(settings, false);
        if (badge) badge.dataset.theme = settings.theme === 'light' ? 'light' : 'dark';
        render();
        const signature = JSON.stringify(settings.badgePosition);
        if (signature !== previousPosition && !dragging && !positionChanged && settings.badgePosition) position(settings.badgePosition.left, settings.badgePosition.top);
        previousPosition = signature;
    };
    const stop = observeSettings(() => { positionChanged = dragging; void refreshSettings().catch(console.warn); });
    const resize = () => { if (badge) { const rect = badge.getBoundingClientRect(); position(rect.left, rect.top); } };
    window.addEventListener('resize', resize);
    // Account changes come from Runtime; count refresh scheduling belongs entirely to Badge.
    const route = () => { void refreshAccount().catch(() => { accountId = null; count = null; clearFeedback(); stopCountPolling(); render(); }); };
    const visibility = () => {
        if (document.hidden) { stopCountPolling(); return; }
        const priorAccount = accountId;
        void refreshAccount().then(() => {
            if (!alive || document.hidden) return;
            if (accountId && accountId === priorAccount) void refreshIndexCount(accountId);
            startCountPolling();
        }).catch(() => { accountId = null; count = null; clearFeedback(); stopCountPolling(); render(); });
    };
    window.addEventListener('gemini:locationchange', route); window.addEventListener('popstate', route);
    document.addEventListener('visibilitychange', visibility);
    registerCleanup(() => {
        alive = false; clearFeedback(); stopCountPolling(); stop(); window.removeEventListener('resize', resize);
        window.removeEventListener('gemini:locationchange', route); window.removeEventListener('popstate', route);
        document.removeEventListener('visibilitychange', visibility);
        badge?.remove(); badge = null; accountId = null; count = null; extensionContextInvalidated = false; positionChanged = false; dragging = false;
    });
    void refreshSettings().catch(console.warn); route(); return badge;
}
// Public Badge API remains frozen; implementation owns display and count timing.
const ensureBadge: () => HTMLElement | null = ensureBadgeImpl;
const showLiveSaveResult: (result: ExportResult | null, accountId: string) => void = showLiveSaveResultImpl;
const showLiveSaveError: (accountId: string) => void = showLiveSaveErrorImpl;
export const BadgeView = { ensureBadge, refreshAccount, showLiveSaveResult, showLiveSaveError };
