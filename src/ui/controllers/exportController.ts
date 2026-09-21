// src/ui/controllers/exportController.ts - Orchestrates ExportEngine, no direct DOM except callbacks
import type { ExportControllerContract } from '../../types/ui.js';
import ExportEngine from '../../core/engine/exportEngine.js';

const getExportEngineClass = (): any => {
    if (typeof (globalThis as any).ExportEngine !== 'undefined') {
        return (globalThis as any).ExportEngine.ExportEngine || (globalThis as any).ExportEngine;
    }
    return ExportEngine;
};

let activeEngine: any = null;
let exportRunning = false;

function $(id: string): HTMLElement | null {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
}

export function setRunning(running: boolean): void {
    exportRunning = !!running;
    const btnExport = $('btnExport') as HTMLButtonElement | null;
    const btnCancel = $('btnCancel');
    const btnIncrementalScan = $('btnIncrementalScan') as HTMLButtonElement | null;
    const btnDeepScan = $('btnDeepScan') as HTMLButtonElement | null;
    const btnImportTakeout = $('btnImportTakeout') as HTMLButtonElement | null;
    const btnSetDir = $('btnSetDir') as HTMLButtonElement | null;
    const btnClearExported = $('btnClearExported') as HTMLButtonElement | null;
    const btnClearAll = $('btnClearAll') as HTMLButtonElement | null;
    const banner = $('exportSessionBanner');

    if (btnExport) btnExport.disabled = !!running;
    if (btnCancel) btnCancel.style.display = running ? '' : 'none';
    if (btnIncrementalScan) btnIncrementalScan.disabled = !!running;
    if (btnDeepScan) btnDeepScan.disabled = !!running;
    if (btnImportTakeout) btnImportTakeout.disabled = !!running;
    if (btnSetDir) btnSetDir.disabled = !!running;
    if (btnClearExported) btnClearExported.disabled = !!running;
    if (btnClearAll) btnClearAll.disabled = !!running;

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
        } catch { /* intentional */ }
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
    const pw = $('progWrap');
    if (pw) pw.style.display = 'none';
}

export async function runExport(
    { selected, format, skip, includeIndex, includeAssets, useZip, dirHandle, currentSlot, conversations, exportedIds, takeoutEngine }: any,
    callbacks: any
): Promise<any> {
    setRunning(true);
    const engineClass = getExportEngineClass();

    if (!engineClass) {
        setRunning(false);
        throw new Error('ExportEngine is not loaded');
    }
    activeEngine = new engineClass();
    try {
        const result = await activeEngine.run({ selected, format, skip, includeIndex, includeAssets, useZip, dirHandle, currentSlot, conversations, exportedIds, takeoutEngine }, callbacks);
        return result;
    } finally {
        setRunning(false);
        activeEngine = null;
    }
}

export const ExportController: ExportControllerContract = {
    setRunning,
    isRunning,
    getActiveEngine,
    runExport,
    abort
};

(ExportController as any).ExportController = ExportController;
(ExportController as any).default = ExportController;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).ExportController = ExportController;
}
if (typeof module === 'object' && module.exports) {
    module.exports = ExportController;
}

export default ExportController;
