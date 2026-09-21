// src/ui/views/dialogView.ts - Dialog and Banner Views
import type { IDialogView } from '../../types/ui.js';
import StorageService from '../../core/storage/storageService.js';
import ConversationsStore from '../state/conversationsStore.js';

function $(id: string): HTMLElement | null {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
}

const t = (key: string, ...args: any[]): string => {
    if (typeof I18n !== 'undefined' && I18n.t) {
        return I18n.t(key, ...args);
    }
    return key;
};

const getStorage = () => {
    if (typeof (globalThis as any).StorageService !== 'undefined') return (globalThis as any).StorageService;
    return StorageService;
};

const getStore = () => {
    if (typeof (globalThis as any).ConversationsStore !== 'undefined') return (globalThis as any).ConversationsStore;
    return ConversationsStore;
};

export function renderExportBanner(session: any, currentSlot: string, isRunning: boolean): void {
    const banner = $('exportSessionBanner');
    const bannerText = $('exportSessionText');
    const btnResume = $('btnResumeExport');
    if (!banner || !bannerText) return;

    if (isRunning || !session || !session.total) {
        banner.style.display = 'none';
        return;
    }

    const slot = currentSlot || 'u0';
    if (session.slot && session.slot !== slot) {
        banner.style.display = 'none';
        return;
    }

    const remaining = Math.max(0, session.total - (session.current || 0));

    if (session.status === 'running' || session.status === 'interrupted' || session.status === 'aborted') {
        if (remaining <= 0) {
            banner.style.display = 'none';
            return;
        }
        banner.style.display = 'flex';
        banner.style.borderColor = '#f59e0b';
        banner.style.background = '#221c12';
        let msg = typeof t === 'function'
            ? t('exportSessionInterrupted', session.total, session.current || 0, remaining)
            : `⚠️ <b>发现未完成的导出任务</b>：共 ${session.total} 条，已处理 ${session.current || 0} 条，剩余 ${remaining} 条未导出。`;
        bannerText.innerHTML = msg;
        // lastChatTitle is remote-controlled conversation metadata persisted from a
        // Gemini response — append it as a text node so a crafted title such as
        // "<svg onload=...>" can never execute inside the options page.
        const lastChatTitle = typeof session.lastChatTitle === 'string' ? session.lastChatTitle.slice(0, 20) : '';
        if (lastChatTitle) {
            const suffix = typeof t === 'function'
                ? t('exportSessionLastChat', lastChatTitle)
                : ` (上次停在: 「${lastChatTitle}」)`;
            bannerText.appendChild(document.createTextNode(suffix));
        }
        if (btnResume) btnResume.style.display = remaining > 0 ? '' : 'none';
    } else if (session.status === 'completed' || session.status === 'completed_with_errors') {
        const timeDiff = Date.now() - (session.updatedAt || 0);
        if (timeDiff < 300000) {
            banner.style.display = 'flex';
            banner.style.borderColor = session.failedCount > 0 ? '#f59e0b' : '#10b981';
            banner.style.background = session.failedCount > 0 ? '#221c12' : '#0e231b';
            let baseDone = typeof t === 'function'
                ? t('exportSessionCompleted', session.current || session.total)
                : `✅ <b>上次导出已完成</b>：共导出 ${session.current || session.total} 条会话`;
            if (session.failedCount > 0) {
                baseDone += typeof t === 'function'
                    ? t('exportSessionCompletedWithErrors', session.failedCount)
                    : ` (其中 ${session.failedCount} 条失败)`;
            }
            bannerText.innerHTML = baseDone;
            if (btnResume) btnResume.style.display = 'none';
        } else {
            banner.style.display = 'none';
        }
    } else {
        banner.style.display = 'none';
    }
}

export function dismissExportBanner(): void {
    const banner = $('exportSessionBanner');
    if (banner) banner.style.display = 'none';
    try {
        chrome.storage.local.remove(['gemini_last_export_session']);
    } catch (e) {
        console.warn("[GemExporter:storage] Storage operation failed:", e);
    }
}

export function showDirectWritePrompt(count: number, onConfirmFolder: () => void, onContinueZip: () => void): void {
    const modal = $('directWriteModal');
    const textEl = $('directWritePromptText');
    const btnFolder = $('btnModalSwitchFolder');
    const btnZip = $('btnModalContinueZip');
    const btnClose = $('btnDirectWriteClose');
    if (!modal) return;

    if (textEl && typeof t === 'function') {
        textEl.textContent = t('directWritePromptDesc', count);
    }

    modal.style.display = 'flex';

    const cleanup = () => {
        modal.style.display = 'none';
        if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
        if (btnFolder) btnFolder.onclick = null;
        if (btnZip) btnZip.onclick = null;
        if (btnClose) btnClose.onclick = null;
    };

    const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            cleanup();
        }
    };
    if (typeof window !== 'undefined') window.addEventListener('keydown', onKey);

    if (btnClose) {
        btnClose.onclick = () => {
            cleanup();
        };
    }

    if (btnFolder) {
        btnFolder.onclick = () => {
            cleanup();
            if (onConfirmFolder) onConfirmFolder();
        };
    }

    if (btnZip) {
        btnZip.onclick = () => {
            cleanup();
            if (onContinueZip) onContinueZip();
        };
    }
}

export function hideDirectWritePrompt(): void {
    const modal = $('directWriteModal');
    if (modal) modal.style.display = 'none';
}

export async function showTakeoutLimitPrompt(options: { count?: number; hitGoogleLimit?: boolean; force?: boolean; onImportTakeout?: () => void } = {}): Promise<void> {
    const modal = $('takeoutLimitModal');
    const titleEl = $('takeoutLimitPromptTitle');
    const textEl = $('takeoutLimitPromptText');
    const btnImport = $('btnModalImportTakeout');
    const btnOpenWeb = $('btnModalOpenTakeoutWeb');
    const btnDismiss = $('btnModalDismissTakeout');
    const btnClose = $('btnTakeoutLimitClose');
    if (!modal) return;

    const storage = getStorage();
    const store = getStore();

    if (!options.force) {
        if (storage) {
            if (storage.isTakeoutPromptCompleted) {
                try {
                    const isCompleted = await storage.isTakeoutPromptCompleted();
                    if (isCompleted) return;
                } catch (e) {
                    console.warn("[GemExporter:storage] Storage operation failed:", e);
                }
            }
            if (storage.hasTakeoutData) {
                try {
                    const hasTakeout = await storage.hasTakeoutData();
                    if (hasTakeout) return;
                } catch (e) {
                    console.warn("[GemExporter:storage] Storage operation failed:", e);
                }
            }
        }
        if (store && store.hasTakeoutData) {
            try {
                if (store.hasTakeoutData()) return;
            } catch (e) {
                if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:dialogView.ts]", e);
            }
        }
    }

    const count = options.count || 600;
    const hitGoogleLimit = !!options.hitGoogleLimit;
    const onImportTakeout = options.onImportTakeout;

    if (titleEl && typeof t === 'function') {
        titleEl.textContent = hitGoogleLimit
            ? t('takeoutLimitPromptTitle')
            : t('takeoutBrowsingLimitTitle');
    }
    if (textEl && typeof t === 'function') {
        textEl.textContent = hitGoogleLimit
            ? t('takeoutLimitPromptDesc', count)
            : (t('takeoutBrowsingLimitDesc', count) || t('takeoutLimitPromptDesc', count));
    }
    if (btnOpenWeb && typeof t === 'function') {
        btnOpenWeb.textContent = t('btnModalOpenTakeoutWeb');
    }
    if (btnDismiss && typeof t === 'function') {
        btnDismiss.textContent = t('btnModalDismissTakeout');
    }

    modal.style.display = 'flex';

    const markCompleted = () => {
        if (storage && storage.setTakeoutPromptCompleted) {
            storage.setTakeoutPromptCompleted(true);
        }
    };

    const cleanup = () => {
        modal.style.display = 'none';
        if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
        if (btnImport) btnImport.onclick = null;
        if (btnOpenWeb) btnOpenWeb.onclick = null;
        if (btnDismiss) btnDismiss.onclick = null;
        if (btnClose) btnClose.onclick = null;
        markCompleted();
    };

    const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            cleanup();
        }
    };
    if (typeof window !== 'undefined') window.addEventListener('keydown', onKey);

    if (btnClose) {
        btnClose.onclick = () => {
            cleanup();
        };
    }

    if (btnDismiss) {
        btnDismiss.onclick = () => {
            cleanup();
        };
    }

    if (btnOpenWeb) {
        btnOpenWeb.onclick = () => {
            markCompleted();
        };
    }

    if (btnImport) {
        btnImport.onclick = () => {
            cleanup();
            if (onImportTakeout) {
                onImportTakeout();
            } else {
                const input = $('takeoutFileInput');
                if (input) input.click();
            }
        };
    }
}

export function hideTakeoutLimitPrompt(): void {
    const modal = $('takeoutLimitModal');
    if (modal) modal.style.display = 'none';
}

export const DialogView: IDialogView = {
    renderExportBanner,
    dismissExportBanner,
    showDirectWritePrompt,
    hideDirectWritePrompt,
    showTakeoutLimitPrompt,
    hideTakeoutLimitPrompt
};

(DialogView as any).DialogView = DialogView;
(DialogView as any).default = DialogView;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).DialogView = DialogView;
}
if (typeof module === 'object' && module.exports) {
    module.exports = DialogView;
}

export default DialogView;
