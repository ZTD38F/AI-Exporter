import type { ExportControllerContract } from '../../types/ui.js';
import ExportEngine from '../../core/engine/exportEngine.js';
import { PdfExporter } from "../../core/export/pdf/pdfExporter.js";
import { ProgressView } from '../views/progressView.js';
import { $, setWorkbenchControlsDisabled } from '../uiCommon.js';
import { normId } from '../../core/utils/pathUtils.js';

let activeEngine: any = null;
let exportRunning = false;

export function estimateMemoryUsage(selected: any[], conversations: any[]): number {
    if (!Array.isArray(selected) || !selected.length) return 0;
    const convMap = new Map<string, any>((conversations || []).map((c: any) => [normId(c?.id), c]));
    let totalAttachments = 0;
    let totalMessages = 0;
    for (const item of selected) {
        const rawId = typeof item === 'string' ? item : item?.id;
        const norm = normId(rawId);
        const conv = (norm ? convMap.get(norm) : null) || (typeof item === 'object' ? item : null);
        if (conv) {
            totalAttachments += (conv.attachmentCount || conv.attachments?.length || 0);
            totalMessages += (conv.messageCount || conv.messages?.length || 0);
        }
    }
    return Math.round((totalAttachments * 1.8) + (totalMessages * 0.02) + (selected.length * 0.05));
}

export function setRunning(running: boolean): void {
    exportRunning = !!running;
    setWorkbenchControlsDisabled(running);
    const btnCancel = $('btnCancel');
    if (btnCancel) btnCancel.style.display = running ? '' : 'none';
    const banner = $('exportSessionBanner');
    if (running && banner) {
        banner.style.display = 'none';
    }
}

export function isRunning(): boolean {
    return exportRunning;
}

export function getActiveEngine(): any {
    return activeEngine;
}

export function abort(): void {
    if (activeEngine) {
        try {
            activeEngine.abort();
        } catch {}
    }
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ action: 'cancelExport' }, () => {
                if (chrome.runtime.lastError) {}
            });
        }
    } catch (e) {
        if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:exportController.ts]", e);
    }
    setRunning(false);
    ProgressView.hide();
}


export async function runExport(
    options: any,
    callbacks: any
): Promise<any> {
    setRunning(true);
    try {
        activeEngine = new ExportEngine();
        if (options && options.format === 'pdf') {
            activeEngine = new PdfExporter();
        }
        const result = await activeEngine.run(options, callbacks);
        return result;
    } finally {
        try {
            activeEngine?.dispose?.();
        } finally {
            activeEngine = null;
            setRunning(false);
        }
    }
}

export const ExportController: ExportControllerContract = {
    setRunning,
    isRunning,
    getActiveEngine,
    runExport,
    abort,
    estimateMemoryUsage
};

export default ExportController;
