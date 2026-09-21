// src/ui/options/options.ts - Gemini Exporter workbench single entrypoint & coordinator
import '../../core/protocol/protocol.js';
import '../../core/utils/constants.js';
import '../../core/utils/utils.js';
import '../../core/utils/tabService.js';
import '../../core/utils/locales/zh.js';
import '../../core/utils/locales/en.js';
import '../../core/utils/i18n.js';
import '../../core/storage/storageService.js';
import '../../core/storage/formatStore.js';
import '../../core/engine/writers/zipWriter.js';
import '../../core/engine/writers/fsWriter.js';
import '../../core/engine/writers/writerInterface.js';
import '../../core/engine/chatFormatter.js';
import '../../core/api/parser/extractors.js';
import '../../core/api/parser/attachments.js';
import '../../core/api/parser/parseList.js';
import '../../core/api/parser/parseDetail.js';
import '../../core/api/geminiParser.js';
import '../../core/api/client/credentialManager.js';
import '../../core/api/client/retryPolicy.js';
import '../../core/api/client/rpcClient.js';
import '../../core/api/client/pagination.js';
import '../../core/api/geminiClient.js';
import '../../core/engine/takeout/zipBombGuard.js';
import '../../core/engine/takeout/mediaIndex.js';
import '../../core/engine/takeout/takeoutParser.js';
import '../../core/engine/takeoutEngine.js';
import '../../core/engine/assetPipeline.js';
import '../../core/engine/export/progressReporter.js';
import '../../core/engine/export/sessionRecovery.js';
import '../../core/engine/export/rateLimiter.js';
import '../../core/engine/export/batchWorker.js';
import '../../core/engine/export/exportOrchestrator.js';
import '../../core/engine/exportEngine.js';
import { OptionsInit } from './modules/optionsInit.js';
import { OptionsExport } from './modules/optionsExport.js';
import { OptionsSync } from './modules/optionsSync.js';
import { OptionsTakeout } from './modules/optionsTakeout.js';
import { OptionsSettings } from './modules/optionsSettings.js';
import { ConversationsStore } from '../state/conversationsStore.js';
import { ListView } from '../views/listView.js';
import { AccountView } from '../views/accountView.js';
import { DialogView } from '../views/dialogView.js';
import { LogView } from '../views/logView.js';
import { DirHandleController } from '../controllers/dirHandleController.js';
import { TakeoutController } from '../controllers/takeoutController.js';
import { SyncController } from '../controllers/syncController.js';
import { ExportController } from '../controllers/exportController.js';
import { TourGuide } from '../tour/tourGuide.js';

// Logging helpers
export function log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    if (OptionsInit && OptionsInit.log) OptionsInit.log(msg, level);
    else console.log(`[LOG ${level}]`, msg);
}

export function clearLog(): void {
    if (OptionsInit && OptionsInit.clearLog) OptionsInit.clearLog();
}

export function renderLog(): void {
    if (OptionsInit && OptionsInit.renderLog) OptionsInit.renderLog();
}

// Facade delegations & static regression test anchors:
// 1. compareConversations SSoT delegation (verified by tests/run_tests.py)
export const compareConversations = (a: any, b: any) => (OptionsInit && OptionsInit.compareConversations ? OptionsInit.compareConversations(a, b) : 0);

// 2. isBad title scrubbing delegation (verified by tests/regression_p0.test.js)
export const isBad = (t: string | null | undefined, id?: string | null) => (OptionsInit && OptionsInit.isBad ? OptionsInit.isBad(t, id) : false);

// 3. checkPendingTakeoutPrompt & gemini_pending_takeout_prompt check (verified by tests/run_tests.py)
export async function checkPendingTakeoutPrompt(): Promise<void> {
    if (OptionsTakeout && OptionsTakeout.checkPendingTakeoutPrompt) {
        return await OptionsTakeout.checkPendingTakeoutPrompt();
    }
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const data = await chrome.storage.local.get(['gemini_pending_takeout_prompt']);
        if (data && data.gemini_pending_takeout_prompt) {
            await chrome.storage.local.remove('gemini_pending_takeout_prompt');
        }
    }
}

// 4. isTakeoutPromptCompleted check (verified by tests/run_tests.py)
export async function isTakeoutPromptCompleted(): Promise<boolean> {
    return OptionsTakeout ? await OptionsTakeout.isTakeoutPromptCompleted() : false;
}

// 5. loadStore facade & window binding
export async function loadStore(force: boolean = false): Promise<any> {
    if (typeof window !== 'undefined') {
        (window as any).__workbenchLoadStore = loadStore;
    }
    if (OptionsInit && OptionsInit.loadStore) {
        return await OptionsInit.loadStore(force);
    }
}

// Expose early for external callers and tests
if (typeof window !== 'undefined') {
    (window as any).__workbenchLoadStore = loadStore;
}

/**
 * Single assembly coordinator function for UI workbench
 */
export async function initWorkbench(): Promise<void> {
    if (typeof window !== 'undefined') {
        (window as any).__workbenchLoadStore = loadStore;
    }

    // Initialize sub-modules in lifecycle order
    if (OptionsTakeout && OptionsTakeout.init) {
        OptionsTakeout.init({ loadStore, log });
    }

    if (OptionsInit && OptionsInit.init) {
        OptionsInit.init({
            onCheckPendingTakeout: () => checkPendingTakeoutPrompt()
        });
    }

    if (OptionsExport && OptionsExport.init) {
        await OptionsExport.init({
            loadStore,
            log,
            getSearchFilter: () => (OptionsInit ? OptionsInit.getSearchFilter() : '')
        });
    }

    if (OptionsSync && OptionsSync.init) {
        await OptionsSync.init({
            loadStore,
            log,
            maybePromptTakeout: (count: number, hitLimit: boolean) => (OptionsTakeout ? (OptionsTakeout.maybePromptTakeout(count, hitLimit) as Promise<void>) : undefined)
        });
    }

    if (OptionsSettings && OptionsSettings.init) {
        await OptionsSettings.init({
            loadStore,
            log,
            clearLog,
            renderLog,
            updateZipUi: () => (OptionsExport ? OptionsExport.updateZipUi() : null),
            checkExportSession: () => (OptionsInit ? (OptionsInit.checkExportSession() as unknown as Promise<void>) : undefined),
            updateAccountSlotSelector: () => (OptionsInit ? OptionsInit.updateAccountSlotSelector() : null),
            getSearchFilter: () => (OptionsInit ? OptionsInit.getSearchFilter() : '')
        });
    }

    // Initial store load
    await loadStore();

    // Check for welcome / onboarding tour
    if (OptionsSettings && OptionsSettings.checkOnboardingTour) {
        OptionsSettings.checkOnboardingTour();
    }
}

export const initOptionsApp = initWorkbench;

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initWorkbench);
    } else {
        initWorkbench();
    }
}

// Expose global exports for backward compatibility and test scripts
const OptionsModule = {
    initWorkbench,
    initOptionsApp,
    loadStore,
    log,
    clearLog,
    renderLog,
    compareConversations,
    isBad,
    checkPendingTakeoutPrompt,
    isTakeoutPromptCompleted,
    ConversationsStore,
    ListView,
    AccountView,
    DialogView,
    LogView,
    DirHandleController,
    TakeoutController,
    SyncController,
    ExportController,
    TourGuide,
    OptionsInit,
    OptionsExport,
    OptionsSync,
    OptionsTakeout,
    OptionsSettings
};

(OptionsModule as any).OptionsModule = OptionsModule;
(OptionsModule as any).default = OptionsModule;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).OptionsModule = OptionsModule;
    (globalThis as any).OptionsInit = OptionsInit;
    (globalThis as any).OptionsExport = OptionsExport;
    (globalThis as any).OptionsSync = OptionsSync;
    (globalThis as any).OptionsTakeout = OptionsTakeout;
    (globalThis as any).OptionsSettings = OptionsSettings;
    (globalThis as any).TourGuide = TourGuide;
    (globalThis as any).ConversationsStore = ConversationsStore;
    (globalThis as any).ListView = ListView;
    (globalThis as any).AccountView = AccountView;
    (globalThis as any).DialogView = DialogView;
    (globalThis as any).LogView = LogView;
    (globalThis as any).__workbenchLoadStore = loadStore;
}
if (typeof window !== 'undefined') {
    (window as any).TourGuide = TourGuide;
    (window as any).__workbenchLoadStore = loadStore;
    (window as any).ConversationsStore = ConversationsStore;
    (window as any).ListView = ListView;
    (window as any).AccountView = AccountView;
    (window as any).DialogView = DialogView;
    (window as any).LogView = LogView;
    (window as any).OptionsInit = OptionsInit;
    (window as any).OptionsExport = OptionsExport;
    (window as any).OptionsSync = OptionsSync;
    (window as any).OptionsTakeout = OptionsTakeout;
    (window as any).OptionsSettings = OptionsSettings;
}
if (typeof module === 'object' && module.exports) {
    module.exports = OptionsModule;
}

export { OptionsModule };
export default OptionsModule;
