import { SessionStore } from '../../storage/sessionStore.js';

export interface ProgressReporterOptions {
    totalChats?: number;
    onProgress?: ((info: any) => void) | null;
    onLog?: ((msg: string, level?: string) => void) | null;
}

export interface ProgressReporterModule {
    ProgressReporter: typeof ProgressReporter;
    calculateProgress: typeof calculateProgress;
    updateStorageSession: typeof updateStorageSession;
}

function calculateProgress(current: number, total: number, downloadedAssets: number = 0, totalAssets: number = 0): number {
    const safeTotal = Number(total) || 0;
    const safeCurrent = Math.min(Number(current) || 0, safeTotal);
    let pct = safeTotal ? Math.floor((safeCurrent / safeTotal) * 100) : 0;
    if (totalAssets > 0 && downloadedAssets > 0 && pct < 100) {
        const chatRatio = safeTotal ? (safeCurrent / safeTotal) : 0;
        const assetRatio = Math.min(1, downloadedAssets / totalAssets);
        pct = Math.min(99, Math.floor((chatRatio * 0.75 + assetRatio * 0.25) * 100));
    }
    return pct;
}

async function updateStorageSession(sessionData: any): Promise<void> {
    await SessionStore.updateSession(sessionData);
}

class ProgressReporter {
    totalChats: number;
    currentExportIdx: number;
    currentExportTitle: string;
    onProgress: (info: any) => void;
    onLog: (msg: string, level?: string) => void;
    // Monotonic percentage tracker to prevent backward progress jumps
    private lastPct: number = 0;

    static ProgressReporter = ProgressReporter;
    static calculateProgress = calculateProgress;
    static updateStorageSession = updateStorageSession;

    constructor({ totalChats = 0, onProgress = null, onLog = null }: ProgressReporterOptions = {}) {
        this.totalChats = totalChats;
        this.currentExportIdx = 0;
        this.currentExportTitle = '';
        this.onProgress = onProgress || (() => {});
        this.onLog = onLog || (() => {});
    }

    log(message: string, level: string = 'info'): void {
        try {
            this.onLog(message, level);
        } catch (e) {
            if (typeof console !== 'undefined' && console.debug) {
                console.debug('[GemExporter:progressReporter.js] log callback error', e);
            }
        }
    }

    update(chatIdx?: number, chatTitle?: string, { downloadedAssets = 0, totalAssets = 0 } = {}): number {
        if (typeof chatIdx === 'number') this.currentExportIdx = chatIdx;
        if (typeof chatTitle === 'string' && chatTitle) this.currentExportTitle = chatTitle;

        const current = Math.min(this.currentExportIdx, this.totalChats);
        const rawPct = calculateProgress(current, this.totalChats, downloadedAssets, totalAssets);
        const pct = Math.max(this.lastPct, rawPct);
        this.lastPct = pct;

        try {
            this.onProgress({
                current,
                total: this.totalChats,
                pct,
                title: this.currentExportTitle,
                assetsDownloaded: downloadedAssets,
                assetsTotal: totalAssets
            });
        } catch (e) {
            if (typeof console !== 'undefined' && console.debug) {
                console.debug('[GemExporter:progressReporter.js] progress callback error', e);
            }
        }
        return pct;
    }

    async updateSession(data: any): Promise<void> {
        await updateStorageSession(data);
    }
}

export {
    ProgressReporter,
    calculateProgress,
    updateStorageSession
};

export const progressReporterModule: ProgressReporterModule = {
    ProgressReporter,
    calculateProgress,
    updateStorageSession
};

export default progressReporterModule;
