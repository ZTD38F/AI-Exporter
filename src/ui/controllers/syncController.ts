import type { SyncControllerContract } from '../../types/ui.js';
import type { DeepScanMessage, StopDeepScanMessage } from '../../types/messages.js';
import GeminiProtocol from '../../core/protocol/protocol.js';
import { isRateLimited } from '../../core/engine/export/rateLimiter.js';
import { $, t, hasI18n, setWorkbenchControlsDisabled } from '../uiCommon.js';
import { sendTypedMessage } from '../../core/utils/messaging.js';

let scanRunning = false;

export function isScanning(): boolean {
    return scanRunning;
}

export function setScanRunning(running: boolean): void {
    scanRunning = !!running;
    setWorkbenchControlsDisabled(running);
    const btnStop = $('btnStopScan');
    if (btnStop) btnStop.style.display = running ? 'inline-flex' : 'none';
}

function isConnectionError(err: string): boolean {
    const str = String(err || '');
    return str.includes('Receiving end does not exist') || str.includes('Could not establish connection');
}

export function formatSyncErrorMessage(err: string): string {
    const errStr = String(err || '');
    if (isConnectionError(errStr)) {
        const refreshHint = hasI18n() ? t('syncConnectionFailedRefresh') : '未能与 Gemini 建立连接，请刷新 gemini.google.com 页面后重试';
        return hasI18n() ? t('syncFailed', refreshHint) : `同步失败: ${refreshHint}`;
    }
    return hasI18n() ? t('syncFailed', errStr) : `同步失败: ${errStr}`;
}

// Detects HTTP 429 rate limits, quota exhaustion, and Google server limits via unified rateLimiter.
export function isServerRateOrQuotaLimit(text?: string | null): boolean {
    return isRateLimited(text);
}

function _runScan(
    mode: 'incremental' | 'full',
    slot: string,
    { onStart, onProgress, onLog, onFinished, onError }: any = {},
    i18nKey: string,
    fallbackMsgFn: (count: number) => string
): void {
    if (scanRunning) return;
    setScanRunning(true);
    if (onStart) onStart();

    // UI-to-background timeout is buffered higher than the background tab RPC timeout
    // (300s full, 90s incremental) to prevent scanRunning from getting permanently stuck.
    const uiTimeoutMs = mode === 'full' ? 330000 : 120000;
    const msg: DeepScanMessage = { action: 'deepScan', mode, accountSlot: slot || 'u0' };
    sendTypedMessage(msg, uiTimeoutMs).then((res: any) => {
        setScanRunning(false);

        const slidingLimit = (GeminiProtocol.LIMITS?.SLIDING_WINDOW) || 500;
        const hitGoogleLimit = !!(
            res?.hitGoogleLimit ||
            res?.diagnostics?.hitGoogleLimit ||
            (mode === 'full' && ((res?.count >= slidingLimit) || (res?.total >= slidingLimit))) ||
            isServerRateOrQuotaLimit(res?.diagnostics?.stopReason) ||
            isServerRateOrQuotaLimit(res?.error)
        );

        if (res && res.success) {
            const count = res.count || res.total || 0;
            let finishMsg: string;
            if (hitGoogleLimit) {
                finishMsg = typeof t === 'function'
                    ? t('syncFinishedWithLimit', count)
                    : `已拉取约 ${count} 条会话（已达 Google 网页端上限），更早记录建议使用 Google Takeout 导入补全。`;
            } else {
                finishMsg = typeof t === 'function' ? t(i18nKey, count) : fallbackMsgFn(count);
            }
            if (onLog) onLog(finishMsg, 'info');
            if (onFinished) onFinished({ count, res, message: finishMsg, hitGoogleLimit });
        } else {
            const err = (res && res.error) || '未知错误';
            const errMsg = formatSyncErrorMessage(err);
            if (onLog) onLog(errMsg, 'error');
            if (onError) onError(new Error(err), errMsg, { hitGoogleLimit, res });
        }
    }).catch((err: any) => {
        setScanRunning(false);
        const errMsg = formatSyncErrorMessage(err?.message || String(err));
        if (onLog) onLog(errMsg, 'error');
        if (onError) onError(err instanceof Error ? err : new Error(String(err)), errMsg);
    });
}

export function startIncrementalScan(slot: string, callbacks: any = {}): void {
    _runScan('incremental', slot, callbacks, 'syncFinished', count => `增量同步完成，共 ${count} 条`);
}

export function startDeepScan(slot: string, callbacks: any = {}): void {
    _runScan('full', slot, callbacks, 'deepSyncFinished', count => `全量拉取完成，共 ${count} 条`);
}

export function stopScan(slot: string, { onStopped, onLog }: any = {}): void {
    const msg: StopDeepScanMessage = { action: 'stopDeepScan', accountSlot: slot || 'u0' };
    chrome.runtime.sendMessage(msg, () => {
        const stopMsg = typeof t === 'function' ? t('stoppingSync') : '正在终止同步...';
        if (onLog) onLog(stopMsg, 'warn');
        setScanRunning(false);
        if (onStopped) onStopped({ message: stopMsg });
    });
}

export const SyncController: SyncControllerContract & { formatSyncErrorMessage?: (err: string) => string } = {
    isScanning,
    setScanRunning,
    startIncrementalScan,
    startDeepScan,
    stopScan,
    formatSyncErrorMessage
};

export default SyncController;
