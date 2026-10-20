import { StorageService } from '../core/storage/storageService.js';
import { ensureStorageReady } from '../core/storage/schemaMigration.js';
import { GeminiUtils } from '../core/utils/utils.js';
import { STORAGE_KEYS } from '../core/utils/constants.js';
import { contentContext } from './contentContext.js';
import { GeminiProtocol } from '../core/protocol/protocol.js';
import { ensureCreds } from './bootstrap.js';
import { SyncEngine } from './syncEngine.js';
import { PageObserver } from './pageObserver.js';
import { MessageRouter } from './messageRouter.js';
import { BadgeView } from './badgeView.js';
import { MessageBridge } from './messageBridge.js';
import { DomScraper } from './domScraper.js';
import { AssetFetcher } from './assetFetcher.js';
import { LiveSaveObserver } from './liveSaveObserver.js';
import { LiveSaveCoordinator } from './liveSaveCoordinator.js';
import { LiveStorageManager } from '../core/storage/liveStorageManager.js';
import { ChatFormatter } from '../core/engine/chatFormatter.js';
import { FsWriter } from '../core/engine/writers/fsWriter.js';
import { runCleanups, registerCleanup } from './cleanupRegistry.js';

(() => {
    'use strict';

    if (typeof window === 'undefined') return;

    const w = window as any;

    if (typeof w.__gemExporterDeepScanPromise === 'undefined') w.__gemExporterDeepScanPromise = null;

    if (w.__gemExporterInjected) {
        // Clean up previous bundle listeners before re-initializing
        runCleanups();
        try {
            document.getElementById('geminiExportBadge')?.remove();
        } catch {
            /* intentional: best-effort cleanup */
        }
        if (PageObserver && PageObserver.cleanup) {
            PageObserver.cleanup();
        }
        if (LiveSaveObserver && LiveSaveObserver.cleanup) {
            LiveSaveObserver.cleanup();
        }
        w.__gemExporterInjected = false;
        w.__gemExporterScrollAll = null;
    }
    w.__gemExporterInjected = true;
    contentContext.setInjected(true);

    const Sync = SyncEngine;
    const Observer = PageObserver;
    const Router = MessageRouter;
    const Badge = BadgeView;
    const Bridge = MessageBridge;
    const Storage = StorageService as any;
    const Scraper = DomScraper;
    const Assets = AssetFetcher;
    const Utils = GeminiUtils as any;

    function getAccountSlot(): string {
        return Sync ? Sync.getAccountSlot() : 'u0';
    }

    function isZh(): boolean {
        return Sync ? Sync.isZh() : true;
    }

    function ensureBadge(): HTMLElement | null {
        if (Badge && Badge.ensureBadge) {
            const b = Badge.ensureBadge({ isZh, onClick: undefined }) as any;
            if (b && !b.__initialRefreshed) {
                b.__initialRefreshed = true;
                if (Sync && Sync.refreshInitialBadge) {
                    void Sync.refreshInitialBadge();
                }
            }
            return b;
        }
        return document.getElementById('geminiExportBadge');
    }

    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get([STORAGE_KEYS.LANG, STORAGE_KEYS.DEV_MODE], d => {
                const lang = String(d[STORAGE_KEYS.LANG] || ((navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'));
                if (Sync && Sync.setLanguage) Sync.setLanguage(lang);
                contentContext.setDevMode(!!d[STORAGE_KEYS.DEV_MODE]);
                w.__gemExporterDevMode = !!d[STORAGE_KEYS.DEV_MODE];
                if (Sync && Sync.refreshInitialBadge) void Sync.refreshInitialBadge();
            });
            const onStorageChanged = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
                if (area === 'local' && changes[STORAGE_KEYS.LANG]) {
                    const newLang = String(changes[STORAGE_KEYS.LANG].newValue || 'zh');
                    if (Sync && Sync.setLanguage) Sync.setLanguage(newLang);
                    if (Sync && Sync.refreshInitialBadge) void Sync.refreshInitialBadge();
                }
                if (area === 'local' && changes[STORAGE_KEYS.DEV_MODE]) {
                    const devMode = !!changes[STORAGE_KEYS.DEV_MODE].newValue;
                    contentContext.setDevMode(devMode);
                    w.__gemExporterDevMode = devMode;
                }
            };
            chrome.storage.onChanged.addListener(onStorageChanged);
            registerCleanup(() => {
                try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { /* already gone */ }
            });
        }
    } catch (e) {
        if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:content.ts]', e);
    }

    if (LiveSaveCoordinator && LiveSaveObserver) {
        LiveSaveCoordinator.init({
            storageManager: LiveStorageManager,
            scraper: Scraper,
            formatter: ChatFormatter,
            fsWriterClass: FsWriter,
            utils: Utils,
            badge: Badge
        });

        LiveSaveObserver.init({
            debounceMs: 300,
            onTurnComplete: (cid, reason) => {
                void LiveSaveCoordinator.executeLiveSave(cid, reason);
            }
        });
    }

    if (Bridge && Bridge.init && Sync) {
        Bridge.init({
            upsertConversations: Sync.upsertConversations,
            touchActiveConversation: Sync.touchActiveConversation,
            extractActiveChatTitle: Sync.extractActiveChatTitle,
            getAccountSlot,
            isRealTitle: Utils?.isRealTitle || ((t: string, id: string) => !!(t && String(t).trim().length > 1)),
            cleanTitle: Utils?.cleanTitle || ((t: string) => (t || '').trim()),
            updateBadge: Sync.updateBadge,
            ensureBadge,
            Storage,
            protocol: GeminiProtocol,
            onStreamStart: (cid) => {
                if (LiveSaveObserver && typeof LiveSaveObserver.notifyStreamStart === 'function') {
                    LiveSaveObserver.notifyStreamStart(cid);
                }
            },
            onStreamComplete: (cid) => {
                if (LiveSaveObserver && typeof LiveSaveObserver.notifyStreamComplete === 'function') {
                    LiveSaveObserver.notifyStreamComplete(cid);
                }
            }
        });
    }

    if (Router && Router.init) {
        Router.init({
            syncEngine: Sync,
            scraper: Scraper,
            assets: Assets,
            storage: Storage,
            utils: Utils
        });
    }

    async function autoInitSync(): Promise<void> {
        ensureBadge();
        if (Sync) {
            try {
                await ensureStorageReady();
            } catch (e) {
                if (contentContext.isDevMode()) console.debug('[GemExporter:content] storage not ready', e);
                return;
            }
            await Sync.refreshInitialBadge();
            await Sync.syncOnce();
        }
    }

    // Test-only hook (paired with the MAIN-world __geminiExporterSyncOnce in
    // hookCredentials.ts): lets Playwright specs trigger a real Sync.syncOnce()
    // against the live DOM. DOM events cross the isolated/main world boundary,
    // so no script injection is needed. No production behavior.
    document.addEventListener('gemini-exporter:test-sync-once', () => {
        if (Sync) void Sync.syncOnce();
    });

    if (Observer && Observer.init) {
        Observer.init({
            onSync: () => {
                if (Sync) void Sync.syncOnce();
            }
        });
    }

    void ensureCreds();

    if (document.readyState !== 'loading') {
        void autoInitSync();
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            ensureBadge();
            void autoInitSync();
        }, { once: true });
    }

    console.log('[Gemini Exporter Content Coordinator] ready');
})();
