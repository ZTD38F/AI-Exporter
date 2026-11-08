import { showRatingPromptIfEligible } from '../shared/ratingPrompt.js';
import { createBackoffNotice } from '../shared/backoffNotice.js';
import type { Diagnostic } from '../../shared/diagnostics/diagnostic.js';
import { ACTIVE_SOURCE_PLATFORMS } from '../../shared/platformHosts.js';
import { hasPlatformAccess } from '../../runtime/capabilities/platformAuthorization.js';
import { ScanConnectionError } from '../../runtime/capabilities/scanConnection.js';
import { elementById as el, requiredElement as control } from '../shared/elements.js';
import { observeDomainChanges } from '../../runtime/api/domainChanges.js';
import { exportSummary } from '../shared/exportSummary.js';
import { ensureV2Ready } from '../../runtime/api/runtimeReady.js';
import { updateSettings, isLiveSaveEffective, type GlobalSettings } from '../../application/settings/index.js';
import * as Cleanup from '../../application/localCleanup.js';
import { warmLocalFontCache } from '../../l4/format/pdf/typst/fonts/localFontProvider.js';
import { ConversationViewState } from './state/conversationsStore.js';
import type { UIExportRequest } from './controllers/exportController.js';
import { runExportSession, type ExportRunDiagnostic } from './controllers/exportSession.js';
import { startSync } from './controllers/syncController.js';
import type { ScanResult } from '../../application/sync/scanController.js';
import { importOpenAI } from '../../l1/imports/openai/importOpenAI.js';
import { createSourceResourceContext } from '../../l1/resources/sourceResources.js';
import { handleTakeoutImport } from './controllers/takeoutController.js';
import * as Directory from '../../runtime/capabilities/dirHandleController.js';
import { resolveScanTarget } from '../../runtime/capabilities/tabService.js';
import { renderList, unmountList } from './views/listView.js';
import { ExportIssueCollector } from './state/exportIssues.js';
import { copyExportFailures } from './views/exportFailures.js';
import { EXPORT_FORMATS, readSettings, observeSettings, useSettings, labelPage, labelThemeToggle, text, errorText } from '../shared/settings.js';
import { TourGuide, consumeTourIntent } from '../guidance/tourGuide.js';
import { getLatestEligibleFeature } from '../guidance/featureReleases.js';
import { DIRECT_WRITE_THRESHOLD, FEEDBACK_URL } from '../../shared/utils/constants.js';
import { showDirectWritePrompt } from './views/directWritePrompt.js';
import { confirmCleanup } from './views/cleanupPrompt.js';
import { isAccountId } from '../../l2/accountRegistry.js';
import type { ForegroundTask, TaskFeedback, UiMessage } from './state/foregroundTask.js';
import { mountTaskPanel } from './views/taskPanelView.js';

type Level = 'info' | 'warn' | 'error';
type Action = 'export' | 'takeout' | 'cleanup';
interface LogEntry { at: number; level: Level; message: string }
const resolveUiMessage = (message: UiMessage): string => typeof message === 'function' ? message() : message;

export async function initWorkbench(): Promise<void> {
    const installationTour = consumeTourIntent();
    const state = new ConversationViewState();
    const importedResources = createSourceResourceContext();
    let settings: GlobalSettings;
    let directoryAvailable = false;
    let foreground: ForegroundTask = { kind: 'idle' };
    const isBusy = () => foreground.kind !== 'idle';
    const taskPanel = mountTaskPanel();
    let scanController: AbortController | null = null;
    let advanceTutorialScan: (() => void) | undefined;
    let currentScanStatus: UiMessage | null = null;
    let themeSaving = false;
    let presentationSaving = false;
    let lastRequest: UIExportRequest | null = null;
    let failed: UIExportRequest['keys'] = [];
    let dismissedFailures = false;
    let currentIssues = new ExportIssueCollector();
    let folderSuggestionPending = false;
    let connectionError: string | null = null;
    // Browser batches are only staged until their final download is initiated.
    const preparedExportKeys = new Set<string>();
    const log: LogEntry[] = [];
    let feedback: TaskFeedback = { kind: 'empty' };
    let percent = 0;
    let scanSlow = false;
    const exportRuns: ExportRunDiagnostic[] = [];
    let droppedExportRuns = 0;
    const scanRuns: { startedAt: number; finishedAt: number; accountId: string | null; forceFull: boolean; result: ScanResult; diagnostics: Diagnostic[] }[] = [];

    const renderLog = () => {
        const level = control('select', 'logLevel').value;
        const query = control('input', 'logFilter').value.trim().toLowerCase();
        const rows = log.filter(entry => {
            if (level === 'error' && entry.level !== 'error') return false;
            if (level === 'warn' && entry.level === 'info') return false;
            const matched = (entry.message + ' ' + entry.level).toLowerCase();
            return query.startsWith('-') ? !matched.includes(query.slice(1)) : matched.includes(query);
        });
        el('log').textContent = rows.map(entry => `[${new Date(entry.at).toLocaleTimeString()}] [${entry.level}] ${entry.message}`).join('\n') || text('Ready', '就绪');
        el('log').scrollTop = el('log').scrollHeight;
    };
    const status = (message: UiMessage, level: Level = 'info', rawLogMessage?: string) => {
        connectionError = null;
        feedback = { kind: 'status', message, level };
        paintTaskPanel();
        // Log entries keep their event-time text; display messages localize on render.
        log.push({ at: Date.now(), level, message: rawLogMessage ?? resolveUiMessage(message) });
        if (log.length > 400) log.shift();
        renderLog();
    };
    const statusError = (error: unknown, level: Level = 'error') =>
        status(() => errorText(error), level, error instanceof Error ? error.message : String(error));
    const reportScan = (message: UiMessage, level: Level = 'info', rawLogMessage?: string) => {
        currentScanStatus = message;
        paintTaskPanel();
        log.push({ at: Date.now(), level, message: rawLogMessage ?? resolveUiMessage(message) });
        if (log.length > 400) log.shift();
        renderLog();
    };
    const progress = (message: UiMessage, nextPercent?: number) => {
        if (foreground.kind === 'idle' || foreground.phase !== 'running' || foreground.controller.signal.aborted) return;
        feedback = { kind: 'progress', message };
        if (nextPercent !== undefined && Number.isFinite(nextPercent)) percent = Math.max(0, Math.min(100, nextPercent));
        paintTaskPanel();
    };
    const failureGroups = () => currentIssues.groups();
    const paintTaskPanel = () => taskPanel.render({
        task: foreground, feedback, percent,
        scanMessage: currentScanStatus === null ? null : resolveUiMessage(currentScanStatus), scanSlow,
        groups: failureGroups(), failedCount: failed.length, dismissed: dismissedFailures,
        developerMode: settings?.developerMode ?? false, ready: !!settings,
        onCancel: cancel, onRetry: retryFailed, onDismiss: dismissFailures, onCopy: copyFailures,
    });
    const renderConversations = () => renderList(state, isBusy(),
        foreground.kind === 'export' ? preparedExportKeys : undefined,
        new Set(failed.filter(key => key.accountId === state.accountId).map(key => key.conversationId)));
    const render = () => {
        labelPage();
        el('btnPlatformPermissions').textContent = text('Site access', '网站授权');
        const moreButton = control('button', 'btnMoreActions');
        moreButton.setAttribute('aria-label', text('More actions', '更多操作'));
        moreButton.title = text('More actions', '更多操作');
        moreButton.disabled = isBusy() || !settings;
        if (moreButton.disabled) {
            el('moreActionsMenu').hidden = true;
            moreButton.setAttribute('aria-expanded', 'false');
        }
        labelThemeToggle(control('button', 'btnThemeToggle'), settings);
        control('button', 'btnThemeToggle').disabled = !settings || themeSaving;
        document.body.dataset.busy = String(isBusy() || scanController !== null);
        document.body.dataset.foregroundBusy = String(isBusy());
        document.body.dataset.scanning = String(scanController !== null);
        document.body.classList.toggle('dev-mode', settings?.developerMode ?? false);
        const controls = [
            ['select', ['accountIdSelect', 'format', 'chatFilterSelect']],
            ['input', ['skipExported', 'includeAssets', 'liveSaveDiskToggle', 'chatSearchInput', 'btnSelectAll']],
            ['button', ['btnSetDir', 'btnExport', 'btnClearExported', 'btnClearScan',
                'btnSyncAll', 'btnForceFullScan', 'btnImportTakeout', 'btnTourGuide', 'btnPlatformPermissions']],
        ] as const;
        for (const [tag, ids] of controls) for (const id of ids) control(tag, id).disabled = isBusy() || !settings;
        control('select', 'accountIdSelect').disabled ||= scanController !== null;
        control('button', 'btnPlatformPermissions').disabled ||= scanController !== null;
        control('button', 'btnTourGuide').disabled ||= scanController !== null;
        for (const id of ['devToggle', 'langToggle'])
            control('input', id).disabled = !settings || presentationSaving;
        el('delivery').setAttribute('aria-label', text('Export to', '导出到'));
        const folderSelected = settings?.exportDelivery === 'folderWriter';
        for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="delivery"]')) {
            radio.checked = radio.value === (settings?.exportDelivery ?? 'browserDownload');
            radio.disabled = isBusy() || !settings;
        }
        el('localFolderControls').classList.toggle('is-disabled', !folderSelected);
        el('localFolderControls').dataset.authorized = String(folderSelected && directoryAvailable);
        const selector = control('select', 'accountIdSelect');
        selector.setAttribute('aria-label', text('Account', '账户'));
        el('chatSearchInput').setAttribute('aria-label', text('Search title or ID', '搜索标题或 ID'));
        selector.replaceChildren();
        for (const account of state.accounts) {
            const option = document.createElement('option');
            option.value = account.id;
            const provider = account.providerId === 'chatgpt' ? 'ChatGPT' : account.providerId === 'grok' ? 'Grok'
                : account.providerId === 'claude' ? 'Claude' : 'Gemini';
            option.textContent = `${provider} · ${account.displayName || account.email || account.providerAccountId}`;
            selector.append(option);
        }
        selector.value = state.accountId ?? '';
        selector.style.display = state.accounts.length ? 'inline-flex' : 'none';
        const account = state.accounts.find(a => a.id === state.accountId);
        const name = account?.displayName || account?.email || account?.providerAccountId || text('No local account', '暂无本地账户');
        el('accountName').textContent = state.accounts.length ? '' : text('Connect a platform', '请先连接平台');
        el('accountName').style.display = state.accounts.length ? 'none' : 'inline-flex';
        el('btnImportTakeout').title = text('Import a ZIP archive for the selected platform', '导入当前所选平台的 ZIP 压缩包');
        const zipSupported = !state.accountId || account?.providerId === 'gemini' || account?.providerId === 'chatgpt';
        el('takeoutAccountName').textContent = state.accountId
            ? zipSupported ? `→ ${name}` : text('ZIP import is unavailable for this platform.', '此平台暂不支持 ZIP 导入。')
            : text('First import', '首次导入');
        el('takeoutAccountName').title = state.accountId ? name : text('Creates a default Gemini account after choosing a ZIP', '选定 ZIP 后创建 Gemini 默认账户');
        selector.title = name;
        el('ver').textContent = chrome.runtime.getManifest().version;
        if (settings) {
            control('select', 'format').value = settings.defaultFormat;
            control('input', 'skipExported').checked = settings.skipExported;
            control('input', 'includeAssets').checked = settings.includeAssets;
            control('input', 'devToggle').checked = settings.developerMode;
            const en = !document.documentElement.lang.startsWith('zh');
            control('input', 'langToggle').checked = en;
            el('labelLangEn').style.color = en ? 'var(--text)' : 'var(--muted)';
            el('labelLangZh').style.color = en ? 'var(--muted)' : 'var(--text)';
            // Changing the export destination or format pauses Live Save without forgetting intent.
            control('input', 'liveSaveDiskToggle').checked = settings.enabledDisk;
            control('input', 'liveSaveDiskToggle').disabled =
                isBusy() || !folderSelected || settings.defaultFormat !== 'markdown' || !directoryAvailable;
            const liveStatus = el('liveSaveStatus');
            liveStatus.hidden = !settings.enabledDisk;
            liveStatus.textContent = isLiveSaveEffective(settings, directoryAvailable)
                ? text('Live Save active', '实时保存已开启')
                : !folderSelected
                    ? text('Paused: select local folder to resume', '已暂停 · 选择本地文件夹后恢复')
                    : settings.defaultFormat !== 'markdown'
                        ? text('Paused: Markdown only; switch back to resume', '已暂停 · 仅支持 Markdown，切回后恢复')
                        : text('Paused: authorize a folder to resume', '已暂停 · 请选择或重新授权文件夹');
        }
        // The folder picker and Live Save share a handle and depend on folder delivery.
        control('button', 'btnSetDir').disabled = isBusy() || !folderSelected;
        const handle = Directory.getDirHandle();
        const pending = Directory.getPendingPermissionHandle();
        const folderName = handle?.name || pending?.name;
        el('dirLabel').textContent = folderName || text('No folder selected', '未选择文件夹');
        el('dirLabel').title = folderName || text('No folder selected', '尚未选择文件夹');
        el('dirPermissionLabel').textContent = handle && directoryAvailable
            ? text('Authorized', '已授权')
            : pending ? text('Permission needs renewal', '需要重新授权')
                : text('Not authorized', '尚未授权');
        control('button', 'btnSetDir').textContent = pending
            ? text('Reauthorize', '重新授权')
            : handle ? text('Change', '更换') : text('Choose folder', '选择文件夹');
        control('button', 'btnImportTakeout').disabled = isBusy() || scanController !== null || !settings ||
            !zipSupported;
        for (const id of ['btnClearExported', 'btnClearScan']) control('button', id).disabled = isBusy() || scanController !== null || !state.accountId;
        control('button', 'btnForceFullScan').disabled = isBusy() || scanController !== null || !settings || !state.accountId;
        const syncButton = control('button', 'btnSyncAll');
        syncButton.disabled = scanController ? scanController.signal.aborted : isBusy() || !settings;
        syncButton.textContent = scanController
            ? scanController.signal.aborted ? text('Stopping sync…', '正在停止同步…') : text('Stop sync', '停止同步')
            : text('Sync All', '同步会话');
        syncButton.title = scanController
            ? text('Stop syncing; already saved conversations are kept', '停止同步，已保存的对话会保留')
            : text('Scan and sync conversations for the current account', '扫描并同步当前账号的会话');
        renderConversations();
        control('button', 'btnExport').disabled ||= !settings || folderSuggestionPending;
        paintTaskPanel();
    };
    const refresh = async (changedAccountId?: string) => {
        if (await state.refresh(changedAccountId)) render();
        advanceTutorialScan?.();
        const previousError = connectionError;
        const accountId = state.accountId;
        if (!previousError || isBusy() || scanController || !accountId) return;
        try {
            const connected = await resolveScanTarget(accountId);
            // An intervening operation/account switch must keep its own status.
            if (connected === accountId && state.accountId === accountId && !isBusy() && !scanController && connectionError === previousError)
                reportScan(() => text('Account connected. Sync conversations to refresh history.', '账号已连接，可同步会话更新历史。'));
        } catch { /* Keep actionable guidance until a verified Content source is available. */ }
    };
    const select = async (id: string) => {
        if (id !== state.accountId) { lastRequest = null; failed = []; currentIssues = new ExportIssueCollector(); dismissedFailures = false; }
        state.selectAccount(id); render(); await refresh();
    };
    const perform = async (kind: Action, task: (signal: AbortSignal) => Promise<void>) => {
        if (isBusy()) return;
        const taskController = new AbortController();
        foreground = { kind, phase: 'running', controller: taskController };
        feedback = { kind: 'empty' }; percent = 0;
        render();
        try { await task(taskController.signal); }
        catch (error) { statusError(error); }
        finally {
            // Keep conflicting operations locked until the final persisted facts are read.
            foreground = { kind, phase: 'refreshing', controller: taskController };
            paintTaskPanel();
            try { await refresh(); } catch (error) { statusError(error); }
            foreground = { kind: 'idle' }; render();
        }
    };
    const exportRequest = async (request: UIExportRequest, fonts: Promise<void>) => {
        if (isBusy()) return;
        const finishTutorialExport = TourGuide.beginExport();
        let tutorialExportSucceeded = false;
        let successfulExports = 0;
        await perform('export', async (signal) => {
            lastRequest = { ...request, keys: request.keys.map(key => ({ ...key })) };
            const run: ExportRunDiagnostic = { startedAt: Date.now(), request: lastRequest,
                items: [], diagnostics: [], issues: new ExportIssueCollector(), droppedDiagnostics: 0 };
            currentIssues = run.issues;
            exportRuns.push(run);
            if (exportRuns.length > 10) { exportRuns.shift(); droppedExportRuns++; }
            const titleFor = (key: UIExportRequest['keys'][number] | undefined) => key
                && state.indexes.find(index => index.key.accountId === key.accountId
                    && index.key.conversationId === key.conversationId)?.title;
            failed = []; dismissedFailures = false; preparedExportKeys.clear(); render();
            const { result, deliveredCount } = await runExportSession(run, {
                signal, importedResources, titleFor,
                prepare: async () => {
                    await fonts;
                    if (request.delivery === 'folderWriter' && !await Directory.verifyDirPermission(Directory.getDirHandle()))
                        throw new Error('Authorize a folder first');
                },
                onStart: status, onProgress: progress, onIssuesChanged: paintTaskPanel,
                onBodyDelivered: key => {
                    if (key.accountId === state.accountId) preparedExportKeys.delete(key.conversationId);
                    renderConversations();
                },
                onItemUpdate: update => {
                    if (update.status === 'failed' && !failed.some(key =>
                        key.accountId === update.key.accountId && key.conversationId === update.key.conversationId))
                        failed = [...failed, update.key];
                    if (update.status === 'exported')
                        failed = failed.filter(key => key.accountId !== update.key.accountId || key.conversationId !== update.key.conversationId);
                    if (update.key.accountId === state.accountId) {
                        if (update.status === 'prepared') preparedExportKeys.add(update.key.conversationId);
                        else preparedExportKeys.delete(update.key.conversationId);
                        if (update.status === 'exported') state.records[update.key.conversationId] = update.record;
                    }
                    if (update.status !== 'skipped') renderConversations();
                },
            });
            successfulExports = result.exported - result.partial;
            tutorialExportSucceeded = !result.failed.length && !result.aborted && !result.partial;
            preparedExportKeys.clear();
            percent = 100;
            failed = [...result.failed];
            status(() => exportSummary(result) + (deliveredCount > result.exported
                ? text(`; Documents already delivered: ${deliveredCount}`, `；已交付正文 ${deliveredCount} 条，文件已保留`)
                : ''), failed.length || result.aborted || result.partial ? 'warn' : 'info');
        });
        finishTutorialExport?.(tutorialExportSucceeded);
        if (successfulExports > 0 && tutorialExportSucceeded) void showRatingPromptIfEligible().catch(error => console.warn('[Rating prompt]', error));
    };
    const scan = async (forceFull = false) => {
        if (isBusy() || scanController) return;
        feedback = { kind: 'empty' };
        const taskController = new AbortController();
        scanController = taskController;
        const signal = taskController.signal;
        render();
        let connectionFailure: ScanConnectionError | undefined;
        const finishTutorialScan = TourGuide.beginScan();
        let scanHasResults = false;
        advanceTutorialScan = finishTutorialScan ? () => {
            if (!scanHasResults || !state.indexes.length) return;
            advanceTutorialScan = undefined;
            finishTutorialScan(true);
        } : undefined;
        try {
            const selected = state.accounts.find(a => a.id === state.accountId);
            const platform = ACTIVE_SOURCE_PLATFORMS.find(platform => platform === selected?.providerId);
            const access = platform ? await hasPlatformAccess(platform) : true;
            signal.throwIfAborted();
            if (selected && platform && !access) {
                TourGuide.showAccountConnection(platform, selected.id, selected.email || selected.displayName || platform,
                    () => { void scan(forceFull); });
                return;
            }
            const startedAt = Date.now();
            reportScan(() => text('Resolving conversation source…', '正在确认会话来源…'));
            const backoff = createBackoffNotice();
            const diagnostics: Diagnostic[] = [];
            let scanProgressMessage = () => text('Resolving conversation source…', '正在确认会话来源…');
            const paintScanProgress = () => reportScan(() => scanProgressMessage() + (backoff.message() ? ` · ${backoff.message()}` : ''));
            const backoffTimer = setInterval(() => { if (backoff.message()) paintScanProgress(); }, 1000);
            const result = await startSync(state.accountId ?? undefined, { signal, forceFull,
                onDiagnostic: diagnostic => {
                    if (diagnostics.length < 1000) diagnostics.push(diagnostic);
                    backoff.observe(diagnostic);
                    if (['CHATGPT_BACKOFF_WAIT', 'CHATGPT_BACKOFF_END', 'CHATGPT_RATE_LIMITED', 'CHATGPT_COOLDOWN_ACTIVE'].includes(diagnostic.code)) paintScanProgress();
                },
                onTarget: select, onProgress: p => {
                    if (signal.aborted) return;
                    scanProgressMessage = () => text(`Committed ${p.pagesFetched} pages, ${p.conversationsFetched} source entries`,
                        `已接纳 ${p.pagesFetched} 页、${p.conversationsFetched} 条来源记录`);
                    paintScanProgress();
                    if (advanceTutorialScan && p.conversationsFetched > 0) {
                        scanHasResults = true;
                        // A concurrent domain refresh may supersede this read. Every
                        // completed refresh checks the committed list before advancing.
                        void refresh().catch(statusError);
                    }
                    scanSlow = p.conversationsFetched > 200 && state.accounts.find(a => a.id === state.accountId)?.providerId === 'gemini';
                    paintTaskPanel();
                } }).finally(() => clearInterval(backoffTimer));
            scanHasResults ||= result.conversationsFetched > 0;
            scanRuns.push({ startedAt, finishedAt: Date.now(), accountId: state.accountId, forceFull, result, diagnostics });
            if (scanRuns.length > 10) scanRuns.shift();
            const reasons = new Map(Object.entries({
                provider_limit: () => text('Gemini online history limited; import My Activity (Gemini Apps) from Google Takeout', 'Gemini 在线历史受限；请从 Google Takeout 导入“我的活动 → Gemini 应用”'),
                max_pages: () => state.accounts.find(a => a.id === state.accountId)?.providerId === 'claude'
                    ? text('Claude list coverage cannot yet be verified', 'Claude 列表完整性尚无法验证')
                    : text('Local page budget reached', '已达到本地页数预算'),
                invalid_response: () => text('Scan failed: invalid Gemini response', '扫描失败：Gemini 返回无效响应'),
                aborted: () => text('Scan cancelled', '扫描已取消'), error: () => text('Scan failed', '扫描失败')
            }));
            const reason = result.diagnostics?.failure ?? result.reason ?? result.status;
            const succeeded = result.status === 'complete' || result.status === 'up_to_date';
            const completionSummary = () => {
                if (!result.indexChanges) return text('Sync complete', '同步完成');
                const { added, updated } = result.indexChanges;
                return added === 0 && updated === 0
                    ? text('Sync complete · All conversations are up to date', '同步完成 · 所有对话均为最新')
                    : text(`Sync complete · ${added} new ${added === 1 ? 'conversation' : 'conversations'} · ${updated} ${updated === 1 ? 'conversation' : 'conversations'} updated`,
                        `同步完成 · 新发现 ${added} 个对话 · 更新 ${updated} 个对话信息`);
            };
            reportScan(() => succeeded ? completionSummary()
                : `${reasons.get(reason)?.() ?? (result.status === 'error' ? text('Scan failed', '扫描失败') : text('Scan finished', '扫描已结束'))} · ${result.pagesFetched} / ${result.conversationsFetched}`,
                result.status === 'error' ? 'error' : result.status === 'aborted' || result.status === 'partial_limit' ? 'warn' : 'info',
                // Keep upstream diagnostic details in the log without exposing untranslated UI text.
                result.status === 'error' ? `Scan failed (${result.reason ?? 'unknown'}) · ${result.pagesFetched} / ${result.conversationsFetched}` : undefined);
            settings = await readSettings();
            if (state.accounts.find(a => a.id === state.accountId)?.providerId === 'gemini'
                && (result.status === 'partial_limit' || result.conversationsFetched > 150) && !settings.takeoutPromptCompleted) {
                TourGuide.showTakeoutPrompt(result.conversationsFetched,
                    () => {},
                    () => { fileInput.click(); },
                    () => { window.open('https://takeout.google.com/settings/takeout', '_blank', 'noopener,noreferrer'); },
                    () => {
                        // Mark only actual display, including a prompt deferred until the tutorial ends.
                        settings = { ...settings, takeoutPromptCompleted: true };
                        void updateSettings({ takeoutPromptCompleted: true }).catch(e => statusError(e));
                    });
            }
        } catch (error) {
            if (signal.aborted) reportScan(() => text('Sync stopped', '同步已停止'));
            else {
                reportScan(() => errorText(error), 'error', error instanceof Error ? error.message : String(error));
                if (error instanceof ScanConnectionError) connectionFailure = error;
                if (error instanceof Error &&
                    (error.message === 'Open Gemini, ChatGPT, Claude or Grok and connect an account before scanning.'
                        || error.message === 'Open Gemini, log in and refresh the page before scanning.'))
                    connectionError = error.message;
            }
        } finally {
            try { await refresh(); } catch (error) { reportScan(() => errorText(error), 'error'); }
            scanController = null;
            scanSlow = false;
            render();
            advanceTutorialScan?.();
            finishTutorialScan?.(false);
        }
        const account = state.accounts.find(a => a.id === state.accountId);
        if (connectionFailure && account) {
            TourGuide.showAccountConnection(connectionFailure.platform, account.id, account.email || account.displayName || connectionFailure.platform,
                () => { void scan(forceFull); });
        }
    };
    const moreActionsButton = control('button', 'btnMoreActions');
    const moreActionsMenu = el('moreActionsMenu');
    const closeMoreActions = () => {
        moreActionsMenu.hidden = true;
        moreActionsButton.setAttribute('aria-expanded', 'false');
    };
    moreActionsButton.addEventListener('click', () => {
        if (isBusy() || !settings) return;
        moreActionsMenu.hidden = !moreActionsMenu.hidden;
        moreActionsButton.setAttribute('aria-expanded', String(!moreActionsMenu.hidden));
    });
    moreActionsMenu.addEventListener('click', event => {
        if (event.target instanceof Element && event.target.closest('button')) {
            closeMoreActions();
            moreActionsButton.focus();
        }
    });
    control('dialog', 'cleanupModal').addEventListener('close', () => {
        if (moreActionsMenu.hidden) moreActionsButton.focus();
    });
    document.addEventListener('pointerdown', event => {
        if (event.target instanceof Node && !moreActionsButton.parentElement?.contains(event.target))
            closeMoreActions();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !moreActionsMenu.hidden) {
            closeMoreActions();
            moreActionsButton.focus();
        }
    });
    el('btnSyncAll').addEventListener('click', () => {
        if (scanController) {
            scanController.abort();
            reportScan(() => text('Stopping sync…', '正在停止同步…'), 'warn');
            render();
        } else void scan();
    });
    el('btnForceFullScan').addEventListener('click', () => { void scan(true); });
    const cancel = () => {
        if (foreground.kind !== 'export' || foreground.phase !== 'running') return;
        foreground = { ...foreground, phase: 'cancelling' };
        foreground.controller.abort();
        status(() => text('Cancelling…', '正在取消…'), 'warn');
    };
    el('btnExport').addEventListener('click', () => {
        const keys = document.body.dataset.guidedSelection === 'true' ? state.keys().slice(0, 1) : state.keys();
        if (isBusy() || folderSuggestionPending || !keys.length || !settings) return;
        const request: UIExportRequest = { keys, format: settings.defaultFormat,
            delivery: settings.exportDelivery ?? 'browserDownload',
            includeAssets: settings.includeAssets, skipUnchanged: settings.skipExported };
        const start = (delivery: UIExportRequest['delivery']) => {
            const fonts = request.format === 'pdf' ? warmLocalFontCache() : Promise.resolve();
            void exportRequest({ ...request, delivery }, fonts);
        };
        if (request.delivery === 'browserDownload' && keys.length > DIRECT_WRITE_THRESHOLD
            && !settings.directWritePromptCompleted && !TourGuide.isActive()) {
            const shown = showDirectWritePrompt(keys.length, () => {
                // The picker/reauthorization must start in the modal button's user gesture.
                const permission = Directory.getPendingPermissionHandle()
                    ? Directory.reauthorizeDirHandle() : Directory.requestDirHandle();
                folderSuggestionPending = true; render();
                void (async () => {
                    try {
                        if (!await permission || !await Directory.verifyDirPermission(Directory.getDirHandle()))
                            throw new Error('Folder permission denied');
                        directoryAvailable = true;
                        await updateSettings({ exportDelivery: 'folderWriter' });
                        settings = await readSettings(); render();
                        start('folderWriter');
                    } catch (error) { statusError(error, 'warn'); }
                    finally { folderSuggestionPending = false; render(); }
                })();
            }, () => start('browserDownload'));
            if (shown) {
                // Mark at first display, not on which option the user picks (or whether they close).
                settings = { ...settings, directWritePromptCompleted: true };
                void updateSettings({ directWritePromptCompleted: true })
                    .catch(error => statusError(error));
                return;
            }
        }
        start(request.delivery);
    });
    const retryFailed = () => {
        if (isBusy() || !lastRequest || !failed.length) return;
        const fonts = lastRequest.format === 'pdf' ? warmLocalFontCache() : Promise.resolve();
        void exportRequest({ ...lastRequest, keys: [...failed], skipUnchanged: false }, fonts);
    };
    const dismissFailures = () => { dismissedFailures = true; paintTaskPanel(); };
    const copyFailures = () => {
        void navigator.clipboard.writeText(copyExportFailures(failureGroups()))
            .catch(e => statusError(e));
    };
    el('btnSetDir').addEventListener('click', () => {
        if (isBusy() || settings?.exportDelivery !== 'folderWriter') return;
        const permission = Directory.getPendingPermissionHandle() ? Directory.reauthorizeDirHandle() : Directory.requestDirHandle();
        void perform('cleanup', async () => {
            if (!await permission) throw new Error('Folder permission denied');
            directoryAvailable = await Directory.verifyDirPermission(Directory.getDirHandle());
            status(() => text('Folder authorized', '目录已授权'));
        });
    });
    el('delivery').addEventListener('change', event => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || input.name !== 'delivery') return;
        if (isBusy() || !settings || input.disabled) { render(); return; }
        if (!input.checked) return;
        const exportDelivery: UIExportRequest['delivery'] =
            input.value === 'folderWriter' ? 'folderWriter' : 'browserDownload';
        if (settings.exportDelivery === exportDelivery) return;
        // Start the native picker directly in the radio's user gesture.
        const permission = exportDelivery === 'folderWriter' && !directoryAvailable && TourGuide.isLiveSaveStep()
            ? Directory.getPendingPermissionHandle() ? Directory.reauthorizeDirHandle() : Directory.requestDirHandle()
            : undefined;
        const previous = settings;
        settings = { ...settings, exportDelivery };
        void perform('cleanup', async () => {
            try {
                if (permission) {
                    try {
                        if (!await permission) throw new Error('Folder permission denied');
                        directoryAvailable = await Directory.verifyDirPermission(Directory.getDirHandle());
                        if (!directoryAvailable) throw new Error('Folder permission denied');
                        status(() => text('Folder authorized. Enable Live Save to continue.', '目录已授权，开启实时保存即可继续。'));
                    } catch (error) {
                        if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
                        status(() => text('Folder selection cancelled. Choose a folder to continue.', '已取消选择目录，请点击「选择文件夹」重试。'));
                    }
                }
                await updateSettings({ exportDelivery }); settings = await readSettings();
            } catch (error) { settings = previous; throw error; }
        });
    });
    const fileInput = control('input', 'takeoutFileInput');
    const importButton = control('button', 'btnImportTakeout');
    const importFile = (file: File) => {
        if (isBusy() || importButton.disabled) return;
        const accountId = state.accountId;
        const account = state.accounts.find(a => a.id === accountId);
        return perform('takeout', async () => {
            try {
                if (account?.providerId === 'chatgpt') {
                    status(() => text('Importing OpenAI ZIP…', '正在导入 OpenAI ZIP…'));
                    const result = await importOpenAI(file, account.id,
                        percent => progress(() => text(`Importing ${percent}%`, `正在导入 ${percent}%`), percent), importedResources);
                    if (result.status === 'empty') status(() => text(
                        'This OpenAI ZIP contains no conversation bodies. No conversations were imported.',
                        '此 OpenAI ZIP 没有聊天正文，未导入任何会话。'), 'warn');
                    else status(() => text(
                        `Imported ${result.imported} conversations; skipped ${result.skipped}; unavailable attachments ${result.missingAssets}.${result.status === 'partial' ? ' Import partially completed.' : ''}`,
                        `已导入 ${result.imported} 条会话；跳过 ${result.skipped} 条；${result.missingAssets} 个附件不可用。${result.status === 'partial' ? '导入部分完成。' : ''}`),
                        result.status === 'partial' ? 'warn' : 'info');
                } else {
                    status(() => text('Importing Takeout ZIP…', '正在导入 Takeout ZIP…'));
                    const result = await handleTakeoutImport(file, accountId, { onTarget: select,
                        onProgress: percent => progress(() => text(`Importing ${percent}%`, `正在导入 ${percent}%`), percent) });
                    status(() => text(`Imported ${result.imported} conversations (${result.status})`,
                        `已提交 ${result.imported} 条对话（${result.status === 'ok' ? '完成' : result.status === 'partial' ? '部分完成' : '未知'}）`));
                }
            } finally { fileInput.value = ''; }
        });
    };
    importButton.addEventListener('click', () => { if (!isBusy() && !importButton.disabled) fileInput.click(); });
    fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) void importFile(file); });
    importButton.addEventListener('dragover', event => event.preventDefault());
    importButton.addEventListener('drop', event => {
        event.preventDefault();
        const file = event.dataTransfer?.files[0];
        if (file) void importFile(file);
    });
    for (const [id, scanRecords] of [['btnClearExported', false], ['btnClearScan', true]] as const)
        el(id).addEventListener('click', async () => {
            const accountId = state.accountId;
            if (!accountId || isBusy() || scanController) return;
            const account = state.accounts.find(a => a.id === accountId);
            const name = account?.displayName || account?.email || account?.providerAccountId || accountId;
            if (!await confirmCleanup(scanRecords, name) || isBusy() || scanController || state.accountId !== accountId) return;
            void perform('cleanup', async () => {
                if (scanRecords) {
                    const keys = state.indexes.map(index => index.key);
                    await Cleanup.clearLocalScanRecords(accountId);
                    for (const key of keys) importedResources.releaseConversation(key);
                }
                else await Cleanup.clearLocalExportRecords(accountId);
                failed = []; currentIssues = new ExportIssueCollector(); dismissedFailures = false;
                status(() => text('Records cleared', '记录已清除'));
            });
        });
    control('select', 'accountIdSelect').addEventListener('change', () => {
        if (isBusy() || scanController) { render(); return; }
        void select(control('select', 'accountIdSelect').value).catch(e => statusError(e));
    });
    control('input', 'chatSearchInput').addEventListener('input', () => {
        state.search = control('input', 'chatSearchInput').value; renderConversations();
    });
    control('select', 'chatFilterSelect').addEventListener('change', () => {
        state.filter = control('select', 'chatFilterSelect').value; renderConversations();
    });
    control('input', 'btnSelectAll').addEventListener('change', () => {
        if (isBusy() || document.body.dataset.guidedSelection === 'true') return;
        if (control('input', 'btnSelectAll').checked) state.selectVisible();
        else state.selected.clear();
        renderConversations();
    });
    const changeControlSetting = (input: HTMLInputElement | HTMLSelectElement, patch: Partial<GlobalSettings>) => {
        // A disabled Live Save switch must never mutate persisted intent.
        if (isBusy() || input.disabled) { render(); return; }
        const finishTutorialSetting = patch.defaultFormat ? TourGuide.beginFormatSelection()
            : patch.enabledDisk === true ? TourGuide.beginLiveSave() : undefined;
        const prior = settings; settings = { ...settings, ...patch };
        let saved = false;
        void perform('cleanup', async () => {
            try {
                await updateSettings(patch); settings = await readSettings();
                saved = patch.defaultFormat ? settings.defaultFormat === patch.defaultFormat
                    : settings.enabledDisk && settings.exportDelivery === 'folderWriter'
                        && settings.defaultFormat === 'markdown' && directoryAvailable;
            }
            catch (error) { settings = prior; throw error; }
        }).then(() => finishTutorialSetting?.(saved));
    };
    const formatControl = control('select', 'format');
    formatControl.addEventListener('change', () => {
        const format = EXPORT_FORMATS.find(value => value === formatControl.value);
        if (format) changeControlSetting(formatControl, { defaultFormat: format });
    });
    const checkboxSettings: readonly (readonly [HTMLInputElement, 'skipExported' | 'includeAssets' | 'enabledDisk'])[] = [
        [control('input', 'skipExported'), 'skipExported'],
        [control('input', 'includeAssets'), 'includeAssets'],
        [control('input', 'liveSaveDiskToggle'), 'enabledDisk'],
    ];
    for (const [input, field] of checkboxSettings) input.addEventListener('change', () => {
        changeControlSetting(input, { [field]: input.checked });
    });
    control('button', 'btnThemeToggle').addEventListener('click', () => {
        if (!settings || themeSaving) return;
        const previous = settings;
        const theme = settings.theme === 'light' ? 'dark' : 'light';
        themeSaving = true;
        settings = { ...settings, theme };
        useSettings(settings);
        render();
        void updateSettings({ theme }).then(async () => { settings = await readSettings(); })
            .catch(error => { settings = previous; useSettings(previous); statusError(error); })
            .finally(() => { themeSaving = false; render(); });
    });
    const savePresentation = async (patch: Pick<GlobalSettings, 'developerMode'> | Pick<GlobalSettings, 'language'>) => {
        if (!settings || presentationSaving) { render(); return; }
        const prior = settings;
        presentationSaving = true;
        settings = { ...settings, ...patch }; useSettings(settings); render();
        // Display preferences must not acquire or reset the running foreground task.
        try { await updateSettings(patch); settings = await readSettings(); }
        catch (error) { settings = prior; useSettings(prior); statusError(error); }
        finally { presentationSaving = false; render(); }
    };
    control('input', 'devToggle').addEventListener('change', () => {
        void savePresentation({ developerMode: control('input', 'devToggle').checked });
    });
    control('input', 'langToggle').addEventListener('change', () => {
        void savePresentation({ language: control('input', 'langToggle').checked ? 'en' : 'zh' });
    });
    el('logFilter').addEventListener('input', renderLog);
    el('logLevel').addEventListener('change', renderLog);
    el('btnCopyLog').addEventListener('click', () => {
        void navigator.clipboard.writeText(el('log').textContent ?? '').catch(e => statusError(e));
    });
    el('btnClearLog').addEventListener('click', () => { log.length = 0; renderLog(); });
    el('btnExportDiag').addEventListener('click', () => {
        void (async () => {
            let grantedPermissions: chrome.permissions.Permissions | null = null;
            try { grantedPermissions = await chrome.permissions.getAll(); } catch { /* Diagnostic export still works without permission inspection. */ }
            const currentExportIssues = state.indexes.flatMap(index => {
                const record = state.records[index.key.conversationId];
                return record?.status === 'partial' ? [{ key: index.key, title: index.title, record,
                    reasonAvailability: 'Stored outcome only; exact causes require a captured export run' }] : [];
            });
            const payload = JSON.stringify({ schemaVersion: 2, diagnosticRevision: 2, generatedAt: Date.now(),
                environment: { online: navigator.onLine, grantedPermissions },
                extensionVersion: chrome.runtime.getManifest().version, userAgent: navigator.userAgent,
                accountId: state.accountId, scanRuns, exportRuns, droppedExportRuns,
                currentExportIssues, logs: log }, null, 2);
            const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
            const link = document.createElement('a'); link.href = url; link.download = 'gemini-exporter-ui-diagnostics.json';
            link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        })().catch(statusError);
    });
    el('btnPlatformPermissions').addEventListener('click', () => { if (!isBusy() && !scanController) TourGuide.showPlatformAuthorization(select); });
    const prepareTourLiveSave = async () => {
        if (settings?.defaultFormat === 'markdown') return;
        try {
            await updateSettings({ defaultFormat: 'markdown' });
            settings = await readSettings();
            render();
        } catch (error) { statusError(error); throw error; }
    };
    const startWorkbenchTour = async () => {
        const firstSelected = state.selected.values().next().value;
        state.selected.clear();
        if (firstSelected !== undefined) state.selected.add(firstSelected);
        renderConversations();
        await TourGuide.startTour(select, prepareTourLiveSave);
    };
    el('btnTourGuide').addEventListener('click', () => { if (!isBusy() && !scanController) void startWorkbenchTour(); });
    const applyOpenedAccount = async (value: unknown) => {
        if (!isAccountId(value)) return;
        // Consume once: directly opening Options later must not reuse a previous source.
        await chrome.storage.session.remove('openOptionsAccountId');
        if (isBusy() || scanController) return;
        if (!state.accounts.some(account => account.id === value)) await refresh();
        if (!isBusy() && !scanController && state.accounts.some(account => account.id === value)) await select(value);
    };
    const onOpenedAccountChange = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
        if (area === 'session' && changes.openOptionsAccountId)
            void applyOpenedAccount(changes.openOptionsAccountId.newValue).catch(error => statusError(error));
    };
    const stopSettings = observeSettings(() => {
        void readSettings().then(next => {
            const changed = !settings || ([
                'defaultFormat', 'skipExported', 'includeAssets', 'enabledDisk',
                'exportDelivery', 'developerMode', 'theme', 'language',
            ] as const).some(field => settings[field] !== next[field]);
            settings = next;
            if (changed) render();
        }).catch(e => statusError(e));
    });
    const onFocus = () => {
        if (isBusy()) return;
        void (async () => {
            await refresh();
            const previous = directoryAvailable;
            try { directoryAvailable = await Directory.verifyDirPermission(Directory.getDirHandle()); }
            catch (error) { directoryAvailable = false; statusError(error, 'warn'); }
            if (directoryAvailable !== previous) render();
        })().catch(e => statusError(e));
    };
    const pendingDomainAccounts = new Set<string>();
    let domainRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let domainRefreshing = false;
    const scheduleDomainRefresh = () => {
        if (!pendingDomainAccounts.size || domainRefreshTimer !== undefined || domainRefreshing) return;
        domainRefreshTimer = setTimeout(() => {
            domainRefreshTimer = undefined;
            domainRefreshing = true;
            void (async () => {
                // Notifications during a read request one trailing read, never parallel reads.
                while (pendingDomainAccounts.size) {
                    const accounts = [...pendingDomainAccounts]; pendingDomainAccounts.clear();
                    await refresh(accounts.includes(state.accountId ?? '') ? undefined : accounts[0]);
                }
            })().catch(e => statusError(e)).finally(() => {
                domainRefreshing = false;
                scheduleDomainRefresh();
            });
        }, 16);
    };
    const stopDomainChanges = observeDomainChanges(accountId => {
        pendingDomainAccounts.add(accountId); scheduleDomainRefresh();
    });
    window.addEventListener('focus', onFocus);
    window.addEventListener('pagehide', () => {
        taskPanel.unmount();
        unmountList();
        importedResources.release();
        stopSettings(); stopDomainChanges(); chrome.storage.onChanged.removeListener(onOpenedAccountChange);
        clearTimeout(domainRefreshTimer); pendingDomainAccounts.clear();
        window.removeEventListener('focus', onFocus); TourGuide.destroy();
    }, { once: true });
    renderLog(); render();
    await ensureV2Ready();
    settings = await readSettings();
    renderLog(); // Localize initial 'Ready' once; subsequent toggles never retranslate the log.
    // First paint must unlock Settings even when the account registry is empty.
    await state.refresh(); render();
    chrome.storage.onChanged.addListener(onOpenedAccountChange);
    await applyOpenedAccount((await chrome.storage.session.get('openOptionsAccountId')).openOptionsAccountId);
    try {
        await Directory.restoreSavedDirHandle();
        directoryAvailable = await Directory.verifyDirPermission(Directory.getDirHandle());
    } catch (error) {
        directoryAvailable = false;
        status(() => text('Folder permission could not be restored: ', '无法恢复文件夹权限：') + errorText(error),
            'warn', 'Folder permission could not be restored: ' + (error instanceof Error ? error.message : String(error)));
    }
    render();
    if (installationTour) await startWorkbenchTour();
    else {
        const current = chrome.runtime.getManifest().version;
        const feature = getLatestEligibleFeature(settings.lastSeenFeatureVersion ?? current, current);
        const shown = feature && ('stepId' in feature
            ? TourGuide.startFeatureSpotlight(feature.version, feature.stepId, () => {})
            : feature.kind === 'platforms' ? TourGuide.showPlatformHighlights()
            : TourGuide.showV2UpgradeSpotlight(() => { void chrome.tabs.create({ url: FEEDBACK_URL }); }));
        if (shown) {
            // Persist on display, not dismissal; each announced feature is shown at most once.
            void updateSettings({ lastSeenFeatureVersion: feature.version })
                .catch(error => statusError(error));
        }
    }
}
if (typeof document !== 'undefined') {
    const start = () => {
        void initWorkbench().catch(error => {
            const status = document.getElementById('status');
            if (status) status.textContent = errorText(error);
        });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
}
