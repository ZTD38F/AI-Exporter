// NOTE (re-audit 2026-09-17, main=d601f83): all 33 former bare side-effect imports
// were verified removable. A static-import-graph BFS from this entrypoint reaches all
// 33 modules (82 files total), and no reader uses a `(globalThis as any).ModuleName`
// mount for them anymore — #437 migrated the AssetPipeline reader to the
// moduleOverrides seam with a static default import
// (exportOrchestrator.ts:46 `import { AssetPipeline as AssetPipelineStatic }`, used via
// `__resolveModule('AssetPipeline', AssetPipelineStatic)`), so the module stays in the
// esbuild bundle through that chain: options.ts -> optionsContext.ts ->
// controllers/exportController.ts -> exportEngine.js -> export/exportOrchestrator.js ->
// assetPipeline.js.
import { FsWriterModule as FsWriter } from '../../core/engine/writers/fsWriter.js';
import { ensureStorageReady } from '../../core/storage/schemaMigration.js';
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
import { t } from '../uiCommon.js';
import { initMitexWasm, isMitexReady, convertMathWithMitex } from '../../core/export/typst/mathConverter.js';

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

export const compareConversations = (a: any, b: any) => (OptionsInit && OptionsInit.compareConversations ? OptionsInit.compareConversations(a, b) : 0);

export const isBad = (t: string | null | undefined, id?: string | null) => (OptionsInit && OptionsInit.isBad ? OptionsInit.isBad(t, id) : false);

// Delegates checkPendingTakeoutPrompt (gemini_pending_takeout_prompt) to OptionsTakeout
export async function checkPendingTakeoutPrompt(): Promise<void> {
    if (OptionsTakeout && OptionsTakeout.checkPendingTakeoutPrompt) {
        return await OptionsTakeout.checkPendingTakeoutPrompt();
    }
}

export async function isTakeoutPromptCompleted(): Promise<boolean> {
    return OptionsTakeout ? await OptionsTakeout.isTakeoutPromptCompleted() : false;
}

export async function loadStore(force: boolean = false, customSelected?: Set<string>): Promise<any> {
    await ensureStorageReady();
    if (OptionsInit && OptionsInit.loadStore) {
        return await OptionsInit.loadStore(force, customSelected);
    }
}

if (typeof window !== 'undefined') {
    (window as any).__workbenchLoadStore = loadStore;
}

export async function initWorkbench(): Promise<void> {
    if (typeof window !== 'undefined') {
        (window as any).__workbenchLoadStore = loadStore;
    }

    await ensureStorageReady();

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
            getSearchFilter: () => (OptionsInit ? OptionsInit.getSearchFilter() : ''),
            getChatFilterType: () => (OptionsInit ? OptionsInit.getChatFilterType() : 'all')
        });
    }

    await loadStore();

    if (OptionsSettings && OptionsSettings.checkOnboardingTour) {
        OptionsSettings.checkOnboardingTour();
    }
}

export const initOptionsApp = initWorkbench;

function startWorkbench(): void {
    try {
        const p = initWorkbench();
        if (p && typeof (p as Promise<void>).catch === 'function') {
            (p as Promise<void>).catch((e) => {
                console.error('[workbench] initWorkbench failed', e);
                try {
                    const el = typeof document !== 'undefined' ? document.getElementById('logList') : null;
                    if (el) {
                        const div = document.createElement('div');
                        div.className = 'log-line log-error';
                        const errText = (e && (e as Error).message) || String(e);
                        div.textContent = typeof t === 'function' ? t('workbenchInitFailed', errText) : `工作台初始化失败: ${errText}`;
                        el.prepend(div);
                    }
                } catch { /* last-resort: console.error above already recorded it */ }
            });
        }
    } catch (e) {
        console.error('[workbench] initWorkbench threw synchronously', e);
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startWorkbench);
    } else {
        startWorkbench();
    }
}

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

// E2E / Live test hooks (read by Playwright specs & live harness actions.py):
// __workbenchLoadStore, DialogView, ConversationsStore, TourGuide, FsWriter,
// TakeoutController, SyncController. Other module mounts removed — use static imports.
if (typeof window !== 'undefined') {
    (window as any).__workbenchLoadStore = loadStore;
    (window as any).ConversationsStore = ConversationsStore;
    (window as any).DialogView = DialogView;
    (window as any).TourGuide = TourGuide;
    (window as any).FsWriter = FsWriter;
    (window as any).TakeoutController = TakeoutController;
    (window as any).SyncController = SyncController;
    (window as any).ExportController = ExportController;
    (window as any).__mitex = { initMitexWasm, isMitexReady, convertMathWithMitex };
}

export { OptionsModule };
export default OptionsModule;
