import { showRatingPromptIfEligible } from '../shared/ratingPrompt.js';
import { createBackoffNotice } from '../shared/backoffNotice.js';
import { elementById as el, requiredElement as control } from '../shared/elements.js';
import { exportSummary } from '../shared/exportSummary.js';
import { sendTabMessage } from '../../runtime/capabilities/tabService.js';
import { isAccountId } from '../../l2/accountRegistry.js';
import { PLATFORM_HOSTS, ACTIVE_SOURCE_PLATFORMS, type SourcePlatform } from '../../shared/platformHosts.js';
import { hasPlatformAccess } from '../../runtime/capabilities/platformAuthorization.js';
import { mountPlatformAuthorization } from '../shared/platformAuthorization.js';
import { AUTHORIZATION_STEP } from '../guidance/tourSteps.js';
import { conversationKey, type ConversationKey } from '../../l2/conversationKey.js';
import { getIndex } from '../../l3a/storageService.js';
import { updateSettings, type GlobalSettings } from '../../application/settings/index.js';
import { ensureV2Ready } from '../../runtime/api/runtimeReady.js';
import { warmLocalFontCache } from '../../l4/format/pdf/typst/fonts/localFontProvider.js';
import { runExport } from '../options/controllers/exportController.js';
import { EXPORT_FORMATS, readSettings, observeSettings, useSettings, text, errorText, labelPage, labelThemeToggle } from '../shared/settings.js';

/** Only the explicitly opened Popup inspects its active tab; URLs never establish Account identity. */
export function platformForTabUrl(url: string | undefined): SourcePlatform | null {
    if (!url) return null;
    try {
        const origin = new URL(url).origin;
        return ACTIVE_SOURCE_PLATFORMS.find(platform =>
            PLATFORM_HOSTS[platform].pages.some(page => new URL(page).origin === origin)) ?? null;
    } catch { return null; }
}

/** Current source identity comes only from trusted Content; never infer Account from a tab URL. */
async function readActiveSource(activeTab?: chrome.tabs.Tab): Promise<{ accountId: string; key: ConversationKey | null } | null> {
    const tab = activeTab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (tab?.id === undefined) return null;
    const expectedProvider = platformForTabUrl(tab.url);
    if (!expectedProvider) return null;
    const response: unknown = await sendTabMessage(tab.id, { action: 'getAccountContext' }, 3000);
    if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true
        || !('accountContext' in response) || !response.accountContext || typeof response.accountContext !== 'object')
        return null;
    const context = response.accountContext;
    if (!('accountId' in context) || !isAccountId(context.accountId)
        || !('providerId' in context) || context.providerId !== expectedProvider) return null;
    const rawId = 'conversationId' in response ? response.conversationId : null;
    let key: ConversationKey | null = null;
    if (typeof rawId === 'string') {
        try { key = conversationKey(context.accountId, rawId); }
        catch { /* A malformed conversation ID must not discard the verified Account. */ }
    }
    return { accountId: context.accountId, key };
}

export async function readActiveKey(activeTab?: chrome.tabs.Tab): Promise<ConversationKey | null> {
    return (await readActiveSource(activeTab))?.key ?? null;
}

export async function initPopup(): Promise<void> {
    const button = control('button', 'btnCurrent');
    const status = el('status');
    let currentStatus: (() => string) | null = null;
    const showStatus = (message: () => string) => { currentStatus = message; status.textContent = message(); };
    const showError = (error: unknown) => {
        console.error('[Popup]', error);
        showStatus(() => errorText(error));
    };
    let settings: GlobalSettings;
    let key: ConversationKey | null = null;
    let indexTitle: string | null = null;
    let identityLoaded = false;
    let busy = false, active = true;
    let themeSaving = false;
    let permissionPlatform: SourcePlatform | null = null;
    let stopPermission: (() => void) | null = null;
    const buttons = [...document.getElementsByTagName('button')].filter(button => button.dataset.format !== undefined);
    const formatName: Record<GlobalSettings['defaultFormat'], string> = { markdown: 'Markdown', html: 'HTML', pdf: 'PDF', docx: 'Word', json: 'JSON' };
    const render = () => {
        labelPage();
        if (permissionPlatform) {
            el('popupPermissionTitle').textContent = AUTHORIZATION_STEP.title();
            el('popupPermissionDescription').textContent = AUTHORIZATION_STEP.description();
        }
        labelThemeToggle(control('button', 'btnThemeToggle'), settings);
        // Appearance is independent of exporting or updating another preference.
        control('button', 'btnThemeToggle').disabled = !settings || themeSaving;
        if (identityLoaded) el('currentChatTitle').textContent = indexTitle || (key
            ? text('Current conversation', '当前对话')
            : text('No current supported conversation', '当前没有受支持的对话'));
        button.disabled = busy || !key;
        for (const btn of buttons) {
            const current = btn.dataset.format === settings?.defaultFormat;
            btn.disabled = busy || !settings;
            btn.classList.toggle('active', current);
            btn.setAttribute('aria-pressed', String(current));
        }
        if (settings) {
            el('activeFormatLabel').textContent = formatName[settings.defaultFormat];
        }
        if (currentStatus) status.textContent = currentStatus();
    };
    const refresh = async () => { settings = await readSettings(); if (active) render(); };
    const stop = observeSettings(() => { void refresh().catch(e => { showError(e); }); });
    window.addEventListener('pagehide', () => { active = false; stop(); stopPermission?.(); }, { once: true });
    el('btnOptions').addEventListener('click', () => {
        void readActiveSource().catch(() => null).then(source =>
            chrome.runtime.sendMessage({ action: 'openOptions', accountId: source?.accountId ?? null }))
            .catch(showError);
    });
    const changeSettings = (patch: Partial<GlobalSettings>) => {
        if (busy) return;
        const prior = settings;
        busy = true; settings = { ...settings, ...patch }; useSettings(settings); render();
        void updateSettings(patch).then(refresh).catch(e => {
            settings = prior; useSettings(prior); showError(e);
        }).finally(() => { busy = false; render(); });
    };
    control('button', 'btnThemeToggle').addEventListener('click', () => {
        if (!settings || themeSaving) return;
        const previousTheme = settings.theme;
        const theme = previousTheme === 'light' ? 'dark' : 'light';
        themeSaving = true;
        settings = { ...settings, theme };
        useSettings(settings); render();
        void updateSettings({ theme }).then(refresh)
            .catch(error => {
                settings = { ...settings, theme: previousTheme };
                useSettings(settings);
                showError(error);
            })
            .finally(() => { themeSaving = false; render(); });
    });
    for (const btn of buttons) btn.addEventListener('click', () => {
        const format = EXPORT_FORMATS.find(value => value === btn.dataset.format);
        if (format) changeSettings({ defaultFormat: format });
    });
    button.addEventListener('click', () => {
        if (busy || !key || !settings) return;
        const format = settings.defaultFormat;
        // Local Font Access starts inside this gesture, before any await.
        const fonts = format === 'pdf' ? warmLocalFontCache() : Promise.resolve();
        busy = true; render();
        const backoff = createBackoffNotice();
        const exportMessage = () => backoff.message() ?? text('Preparing export…', '正在准备导出…');
        showStatus(exportMessage);
        const backoffTimer = setInterval(() => { if (active && backoff.message()) showStatus(exportMessage); }, 1000);
        void (async () => {
            const [current, latest] = await Promise.all([readActiveKey(), readSettings(), fonts]);
            if (!current) { key = null; throw new Error('No trusted current conversation'); }
            const result = await runExport({ keys: [current], format, delivery: 'browserDownload',
                includeAssets: latest.includeAssets, skipUnchanged: false }, {
                onDiagnostic: diagnostic => {
                    backoff.observe(diagnostic);
                    if (active && (['CHATGPT_BACKOFF_WAIT', 'CHATGPT_BACKOFF_END', 'CHATGPT_RATE_LIMITED', 'CHATGPT_COOLDOWN_ACTIVE'].includes(diagnostic.code))) showStatus(exportMessage);
                },
            });
            if (!active) return;
            showStatus(() => result.rateLimitedUntil ? exportSummary(result) : result.aborted ? text('Cancelled', '已取消')
                : result.failed.length || !result.exported ? text('Export failed. Try Options.', '导出失败，请在工作台重试。')
                : result.partial ? exportSummary(result)
                : text('Download initiated', '已发起下载'));
            if (result.exported > 0 && !result.partial && !result.failed.length && !result.aborted) void showRatingPromptIfEligible().catch(error => console.warn('[Rating prompt]', error));
        })().catch(e => { if (active) showError(e); })
            .finally(() => {
                clearInterval(backoffTimer);
                if (active) { busy = false; render(); }
            });
    });
    const showCurrentConversation = async (tab?: chrome.tabs.Tab) => {
        permissionPlatform = null;
        stopPermission?.();
        stopPermission = null;
        key = null;
        indexTitle = null;
        try {
            key = await readActiveKey(tab);
            const index = key ? await getIndex(key) : null;
            indexTitle = index?.title || null;
            if (!key) showStatus(() => text('Open a supported conversation first', '请先打开受支持的对话'));
        } catch (error) {
            showError(error);
        }
        if (!active) return;
        identityLoaded = true;
        el('popupPermission').hidden = true;
        el('popupMain').hidden = false;
        render();
    };
    render();
    try {
        await ensureV2Ready();
        await refresh();
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const platform = platformForTabUrl(tab?.url);
        if (platform && !await hasPlatformAccess(platform)) {
            permissionPlatform = platform;
            el('popupMain').hidden = true;
            el('popupPermission').hidden = false;
            stopPermission = mountPlatformAuthorization(el('popupPermissionControls'), {
                selectedPlatforms: [platform],
                granted: selected => {
                    if (selected.includes(platform)) void showCurrentConversation(tab);
                },
            });
        } else {
            await showCurrentConversation(tab);
        }
    } catch (error) {
        el('popupPermission').hidden = true;
        el('popupMain').hidden = false;
        showError(error);
    }
    render();
}
const start = () => { void initPopup(); };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
