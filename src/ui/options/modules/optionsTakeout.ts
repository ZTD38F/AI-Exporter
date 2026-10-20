import type { OptionsTakeoutOptions } from '../../../types/ui.js';
import {
    getStore,
    getDialogs,
    getStorage,
    getTakeoutCtrl
} from '../optionsContext.js';
import { $ } from '../../uiCommon.js';
import { STORAGE_KEYS } from '../../../core/utils/constants.js';

let __loadStore: ((force?: boolean) => Promise<any> | void) | null = null;
let __log: ((msg: string, level?: 'info' | 'warn' | 'error') => void) | null = null;
let _isImporting = false;

export function isImporting(): boolean {
    return _isImporting;
}

export function log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    if (__log) __log(msg, level);
    else console.log(`[TAKEOUT ${level}]`, msg);
}

export async function isTakeoutPromptCompleted(): Promise<boolean> {
    try {
        const Storage = getStorage();
        return (Storage && Storage.isTakeoutPromptCompleted)
            ? await Storage.isTakeoutPromptCompleted()
            : false;
    } catch {
        return false;
    }
}

export async function maybePromptTakeout(count: number = 600, hitGoogleLimit: boolean = false): Promise<void> {
    try {
        const isCompleted = await isTakeoutPromptCompleted();
        const Store = getStore();
        const Storage = getStorage();
        const Dialogs = getDialogs();
        const hasTakeout = (Store && Store.hasTakeoutData && Store.hasTakeoutData()) ||
            (Storage && Storage.hasTakeoutData && await Storage.hasTakeoutData());
        if (!isCompleted && !hasTakeout && Dialogs && Dialogs.showTakeoutLimitPrompt) {
            void Dialogs.showTakeoutLimitPrompt({
                count: count || 600,
                hitGoogleLimit: !!hitGoogleLimit,
                onImportTakeout: () => ($('takeoutFileInput') as HTMLInputElement | null)?.click(),
                onDismiss: () => {
                    if (Storage && Storage.setTakeoutPromptCompleted) {
                        void Storage.setTakeoutPromptCompleted(true);
                    }
                }
            });
        }
    } catch (e) {
        console.debug('[workbench:takeout] maybePromptTakeout error', e);
    }
}

export async function checkPendingTakeoutPrompt(): Promise<void> {
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            const data = await chrome.storage.local.get([STORAGE_KEYS.PENDING_TAKEOUT_PROMPT]);
            if (data && data[STORAGE_KEYS.PENDING_TAKEOUT_PROMPT]) {
                const info = data[STORAGE_KEYS.PENDING_TAKEOUT_PROMPT];
                await chrome.storage.local.remove(STORAGE_KEYS.PENDING_TAKEOUT_PROMPT);
                await maybePromptTakeout((info as any).count || 600, !!(info as any).hitGoogleLimit);
            }
        }
    } catch (e) {
        console.debug('[workbench:takeout] checkPendingTakeoutPrompt error', e);
    }
}

export function processTakeoutImport(f: File, input?: HTMLInputElement | null): void {
    const TakeoutCtrl = getTakeoutCtrl();
    if (!f || !TakeoutCtrl || _isImporting) return;
    _isImporting = true;

    const progWrap = $('progWrap');
    const bar = $('bar');
    const progText = $('progText');
    if (progWrap) progWrap.style.display = 'block';
    if (bar) bar.style.width = '15%';

    const finalize = () => {
        _isImporting = false;
        if (input) {
            try { input.value = ''; } catch { /* noop */ }
        }
    };

    void Promise.resolve(TakeoutCtrl.handleTakeoutImport(f, {
        onProgress: (pct: number, txt: string) => {
            if (bar) bar.style.width = `${pct}%`;
            if (progText) progText.textContent = txt;
        },
        onLog: (txt: string, lvl?: 'info' | 'warn' | 'error') => log(txt, lvl || 'info'),
        onFinished: ({ message }: any) => {
            if (progText) progText.textContent = message;
            if (progWrap) progWrap.style.display = 'none';
            finalize();
            if (__loadStore) void __loadStore();
        },
        onError: (err: any, errMsg?: string) => {
            if (progText) progText.textContent = errMsg || err.message;
            if (progWrap) progWrap.style.display = 'none';
            finalize();
        }
    })).catch((err: any) => {
        if (progText) progText.textContent = err?.message || String(err);
        if (progWrap) progWrap.style.display = 'none';
        finalize();
    });
}

export function init({ loadStore, log: logFn }: OptionsTakeoutOptions = {}): void {
    __loadStore = loadStore || null;
    __log = logFn || null;

    const modal = $('takeoutImportModal');
    const closeBtn = $('btnTakeoutImportClose');
    const dropZone = $('takeoutDropZone');
    const selectBtn = $('btnTakeoutSelectFile');
    const fileInput = $('takeoutFileInput') as HTMLInputElement | null;

    const openImportModal = () => {
        if (modal) modal.style.display = 'flex';
    };
    const closeImportModal = () => {
        if (modal) modal.style.display = 'none';
    };

    $('btnImportTakeout')?.addEventListener('click', openImportModal);
    closeBtn?.addEventListener('click', closeImportModal);

    modal?.addEventListener('click', (e) => {
        if (e.target === modal) closeImportModal();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal && modal.style.display === 'flex') {
            closeImportModal();
        }
    });

    selectBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput?.click();
    });

    if (dropZone) {
        dropZone.addEventListener('click', (e) => {
            if (e.target !== selectBtn) {
                fileInput?.click();
            }
        });
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.style.borderColor = 'var(--accent, #6366f1)';
            dropZone.style.background = 'rgba(99, 102, 241, 0.08)';
        });
        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.style.borderColor = 'var(--border)';
            dropZone.style.background = 'var(--card-inner)';
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.style.borderColor = 'var(--border)';
            dropZone.style.background = 'var(--card-inner)';
            const files = e.dataTransfer?.files;
            if (files && files.length > 0) {
                closeImportModal();
                processTakeoutImport(files[0], fileInput);
            }
        });
    }

    fileInput?.addEventListener('change', (e: Event) => {
        const input = e.target as HTMLInputElement;
        const f = input.files && input.files[0];
        if (f) {
            closeImportModal();
            processTakeoutImport(f, input);
        }
    });
}

export const OptionsTakeout = {
    init,
    maybePromptTakeout,
    checkPendingTakeoutPrompt,
    isTakeoutPromptCompleted
};



export default OptionsTakeout;
