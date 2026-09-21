// storageService.ts - Unified multi-account Chrome storage access and key management
import type { Conversation } from "../../types/index.js";

export interface StorageKeys {
    slot: string;
    convKey: string;
    expKey: string;
    syncKey: string;
    countKey: string;
}

export interface SyncStatus {
    timestamp: number | null;
    count: number;
}

export interface ReconcileResult {
    kept: number;
    removed: number;
    removedIds: string[];
}

export interface StorageServiceModule {
    normSlot: (slot?: string | null) => string;
    normId: (id?: string | null) => string;
    getStorageKeys: (slot?: string | null) => StorageKeys;
    getConversations: (slot?: string | null) => Promise<Conversation[]>;
    setConversations: (slot: string | null | undefined, list: Conversation[]) => Promise<void>;
    removeConversation: (slot: string | null | undefined, conversationId: string) => Promise<boolean>;
    reconcileConversations: (slot: string | null | undefined, activeCloudList: any[], options?: any) => Promise<ReconcileResult>;
    getExportedIds: (slot?: string | null) => Promise<Record<string, any>>;
    setExportedIds: (slot: string | null | undefined, map: Record<string, any>) => Promise<void>;
    saveExportRecord: (slot: string | null | undefined, id: string, record: any) => Promise<Record<string, any>>;
    saveExportRecordsBatch: (slot: string | null | undefined, records: Record<string, any>) => Promise<Record<string, any>>;
    getLastSync: (slot?: string | null) => Promise<SyncStatus>;
    setLastSync: (slot: string | null | undefined, timestamp?: number | null, count?: number) => Promise<void>;
    getAccountSlots: () => Promise<Record<string, any>>;
    setAccountSlots: (map: Record<string, any>) => Promise<void>;
    updateAccountSlot: (slot: string | null | undefined, info: any) => Promise<Record<string, any>>;
    getCredentialsMap: () => Promise<Record<string, any>>;
    setCredentialsMap: (map: Record<string, any>) => Promise<void>;
    clearCredentials: (sid?: string | null) => Promise<void>;
    getDevMode: () => Promise<boolean>;
    setDevMode: (enabled: boolean) => Promise<void>;
    isTourCompleted: () => Promise<boolean>;
    setTourCompleted: (completed?: boolean) => Promise<void>;
    getLastSeenFeatureVersion: () => Promise<string>;
    setLastSeenFeatureVersion: (version: string) => Promise<void>;
    isVersionGreater: (v1: string, v2: string) => boolean;
    isTakeoutPromptCompleted: () => Promise<boolean>;
    setTakeoutPromptCompleted: (completed?: boolean) => Promise<void>;
    hasTakeoutData: (slot?: string | null) => Promise<boolean>;
    setHasImportedTakeout: (imported?: boolean) => Promise<void>;
}

declare global {
    var StorageService: any;
}



    function normSlot(slot?: string | null): string {
        if (!slot || slot === 'default' || slot === 'u0') return 'u0';
        const m = String(slot).match(/u(\d+)/i);
        return m ? ('u' + m[1]) : 'u0';
    }

    function normId(id?: string | null): string {
        if (!id) return '';
        return String(id).replace(/^c_/, '').trim();
    }

    function getStorageKeys(slot?: string | null): StorageKeys {
        const s = normSlot(slot);
        return {
            slot: s,
            convKey: s === 'u0' ? 'gemini_conversations' : `gemini_conversations_${s}`,
            expKey: s === 'u0' ? 'exportedIds' : `gemini_exported_${s}`,
            syncKey: s === 'u0' ? 'gemini_last_sync' : `gemini_last_sync_${s}`,
            countKey: s === 'u0' ? 'gemini_last_count' : `gemini_last_count_${s}`
        };
    }

    async function getConversations(slot?: string | null): Promise<Conversation[]> {
        const { convKey, slot: s } = getStorageKeys(slot);
        const keys = [convKey];
        if (s === 'u0') {
            keys.push('gemini_conversations_u0');
        }
        const data = await chrome.storage.local.get(keys);
        return ((data[convKey] || (s === 'u0' ? data.gemini_conversations_u0 : null) || []) as Conversation[]);
    }

    async function setConversations(slot: string | null | undefined, list: Conversation[]): Promise<void> {
        const { convKey } = getStorageKeys(slot);
        await chrome.storage.local.set({ [convKey]: list || [] });
    }

    let _convChain: Promise<any> = Promise.resolve();
    function withConversationLock<T>(fn: () => Promise<T>): Promise<T> {
        const p = _convChain.then(fn, fn);
        _convChain = p.then(() => {}, () => {});
        return p;
    }

    async function removeConversation(slot: string | null | undefined, conversationId: string): Promise<boolean> {
        return withConversationLock(async () => {
            if (!conversationId) return false;
            const targetId = normId(conversationId);
            const list = await getConversations(slot);
            const initialLen = list.length;
            const filtered = list.filter(c => {
                if (!c || !c.id) return false;
                return normId(c.id) !== targetId;
            });
            if (filtered.length !== initialLen) {
                await setConversations(slot, filtered);
                const { countKey } = getStorageKeys(slot);
                await chrome.storage.local.set({ [countKey]: filtered.length });
                await updateAccountSlot(slot, { count: filtered.length });
                return true;
            }
            return false;
        });
    }

    async function reconcileConversations(slot: string | null | undefined, activeCloudList: any[], options: any = {}): Promise<ReconcileResult> {
        return withConversationLock(async () => {
            const keepTakeout = options.keepTakeout !== false;
            const existing = await getConversations(slot);
            if (!Array.isArray(existing) || existing.length === 0) {
                return { kept: 0, removed: 0, removedIds: [] };
            }

            const activeIdSet = new Set<string>();
            (activeCloudList || []).forEach(c => {
                if (c && c.id) {
                    activeIdSet.add(normId(c.id));
                }
            });

            const kept: Conversation[] = [];
            const removedIds: string[] = [];

            for (const conv of existing) {
                if (!conv || !conv.id) continue;
                const nid = normId(conv.id);
                const isTakeout = keepTakeout && (
                    (conv as any).source === 'takeout' ||
                    conv.titleSource === 'takeout' ||
                    (conv as any).isTakeoutOnly ||
                    (conv.titles && (conv.titles as any).takeout && !(conv.titles as any).rpc && !(conv.titles as any).dom)
                );

                if (activeIdSet.has(nid) || isTakeout) {
                    kept.push(conv);
                } else {
                    removedIds.push(nid);
                }
            }

            if (removedIds.length > 0) {
                await setConversations(slot, kept);
                const { countKey } = getStorageKeys(slot);
                await chrome.storage.local.set({ [countKey]: kept.length });
                await updateAccountSlot(slot, { count: kept.length });
            }

            return {
                kept: kept.length,
                removed: removedIds.length,
                removedIds
            };
        });
    }

    async function getExportedIds(slot?: string | null): Promise<Record<string, any>> {
        const { expKey, slot: s } = getStorageKeys(slot);
        const keys = [expKey, 'exportedIds', 'gemini_exported_u0'];
        if (s !== 'u0') {
            keys.push(`gemini_exported_${s}`);
        }
        const data = await chrome.storage.local.get(keys);
        const merged: Record<string, any> = {};
        if (data.exportedIds && typeof data.exportedIds === 'object') {
            Object.assign(merged, data.exportedIds);
        }
        if (data.gemini_exported_u0 && typeof data.gemini_exported_u0 === 'object') {
            Object.assign(merged, data.gemini_exported_u0);
        }
        if (data[expKey] && typeof data[expKey] === 'object') {
            Object.assign(merged, data[expKey]);
        }
        return merged;
    }

    async function setExportedIds(slot: string | null | undefined, map: Record<string, any>): Promise<void> {
        const { expKey, slot: s } = getStorageKeys(slot);
        const updates: Record<string, any> = { [expKey]: map || {} };
        if (s === 'u0') {
            updates['exportedIds'] = map || {};
        }
        await chrome.storage.local.set(updates);
    }

    let _saveRecordChain: Promise<any> = Promise.resolve();

    async function saveExportRecord(slot: string | null | undefined, id: string, record: any): Promise<Record<string, any>> {
        return saveExportRecordsBatch(slot, { [id]: record, [normId(id)]: record, ['c_' + normId(id)]: record });
    }

    async function saveExportRecordsBatch(slot: string | null | undefined, records: Record<string, any>): Promise<Record<string, any>> {
        return new Promise((resolve, reject) => {
            _saveRecordChain = _saveRecordChain.then(async () => {
                const { expKey, slot: s } = getStorageKeys(slot);
                const cur = await getExportedIds(slot);
                Object.assign(cur, records);
                // Ensure nid single-key canonical form; keep aliases for backward compat but write once
                const updates: Record<string, any> = { [expKey]: cur };
                if (s !== 'u0') {
                    const globalData = await chrome.storage.local.get(['exportedIds']);
                    const globalExp: Record<string, any> = (globalData.exportedIds && typeof globalData.exportedIds === 'object') ? globalData.exportedIds as Record<string, any> : {};
                    Object.assign(globalExp, records);
                    updates['exportedIds'] = globalExp;
                } else {
                    updates['exportedIds'] = cur;
                }
                await chrome.storage.local.set(updates);
                return cur;
            }).then(resolve).catch(reject);
        });
    }

    async function getLastSync(slot?: string | null): Promise<SyncStatus> {
        const { syncKey, countKey } = getStorageKeys(slot);
        const data = await chrome.storage.local.get([syncKey, countKey]);
        return {
            timestamp: (data[syncKey] as number) || null,
            count: (data[countKey] as number) || 0
        };
    }

    async function setLastSync(slot: string | null | undefined, timestamp?: number | null, count?: number): Promise<void> {
        const { syncKey, countKey } = getStorageKeys(slot);
        await chrome.storage.local.set({
            [syncKey]: timestamp || Date.now(),
            [countKey]: typeof count === 'number' ? count : 0
        });
    }

    async function getAccountSlots(): Promise<Record<string, any>> {
        const data = await chrome.storage.local.get(['gemini_account_slots']);
        return data.gemini_account_slots || {};
    }

    async function setAccountSlots(map: Record<string, any>): Promise<void> {
        await chrome.storage.local.set({ gemini_account_slots: map || {} });
    }

    async function updateAccountSlot(slot: string | null | undefined, info: any): Promise<Record<string, any>> {
        const s = normSlot(slot);
        const map = await getAccountSlots();
        map[s] = { ...(map[s] || {}), ...(info || {}) };
        await setAccountSlots(map);
        return map;
    }

    function getCredStorage(): chrome.storage.StorageArea | null {
        if (typeof chrome !== 'undefined' && chrome.storage) {
            if (chrome.storage.session) return chrome.storage.session;
            return chrome.storage.local;
        }
        return null;
    }

    async function getCredentialsMap(): Promise<Record<string, any>> {
        const storage = getCredStorage();
        if (!storage) return {};
        const data = await storage.get(['gemini_credentials_map']);
        let map = data.gemini_credentials_map || {};
        if (Object.keys(map).length === 0 && storage !== chrome.storage.local && chrome.storage.local) {
            try {
                const localData = await chrome.storage.local.get(['gemini_credentials_map']);
                if (localData && localData.gemini_credentials_map) {
                    map = localData.gemini_credentials_map;
                    await storage.set({ gemini_credentials_map: map });
                    await chrome.storage.local.remove(['gemini_credentials_map', 'gemini_credentials']);
                }
            } catch { /* intentional: migration fallback */ }
        }
        return map;
    }

    async function setCredentialsMap(map: Record<string, any>): Promise<void> {
        const storage = getCredStorage();
        if (!storage) return;
        await storage.set({ gemini_credentials_map: map || {} });
        if (storage !== chrome.storage.local && chrome.storage.local) {
            try {
                await chrome.storage.local.remove(['gemini_credentials_map', 'gemini_credentials']);
            } catch { /* intentional: local purge */ }
        }
    }

    async function clearCredentials(sid?: string | null): Promise<void> {
        const storage = getCredStorage();
        if (!storage) return;
        if (sid) {
            const map = await getCredentialsMap();
            delete map[sid];
            await setCredentialsMap(map);
        } else {
            await storage.remove(['gemini_credentials_map', 'gemini_credentials']);
        }
        if (storage !== chrome.storage.local && chrome.storage.local) {
            try {
                await chrome.storage.local.remove(['gemini_credentials_map', 'gemini_credentials']);
            } catch { /* intentional: local purge */ }
        }
    }

    async function getDevMode(): Promise<boolean> {
        const data = await chrome.storage.local.get(['gemini_dev_mode']);
        return !!data.gemini_dev_mode;
    }

    async function setDevMode(enabled: boolean): Promise<void> {
        await chrome.storage.local.set({ gemini_dev_mode: !!enabled });
    }

    async function isTourCompleted(): Promise<boolean> {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return false;
        try {
            const data = await chrome.storage.local.get(['has_completed_tour']);
            return !!data.has_completed_tour;
        } catch {
            return false;
        }
    }

    async function setTourCompleted(completed: boolean = true): Promise<void> {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
        try {
            await chrome.storage.local.set({ has_completed_tour: !!completed });
        } catch (e) { console.warn("[GemExporter:storage] Storage operation failed:", e); }
    }

    /**
     * Compare two semantic versions: returns true if v1 > v2.
     * E.g. isVersionGreater('1.5.0', '1.4.3') => true
     */
    function isVersionGreater(v1: string, v2: string): boolean {
        if (!v1) return false;
        if (!v2) return true;
        const p1 = String(v1).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
        const p2 = String(v2).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
        const maxLen = Math.max(p1.length, p2.length);
        for (let i = 0; i < maxLen; i++) {
            const num1 = p1[i] || 0;
            const num2 = p2[i] || 0;
            if (num1 > num2) return true;
            if (num1 < num2) return false;
        }
        return false;
    }

    async function getLastSeenFeatureVersion(): Promise<string> {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return '0.0.0';
        try {
            const data = await chrome.storage.local.get(['last_seen_feature_version']);
            return String(data.last_seen_feature_version || '0.0.0');
        } catch {
            return '0.0.0';
        }
    }

    async function setLastSeenFeatureVersion(version: string): Promise<void> {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
        try {
            await chrome.storage.local.set({ last_seen_feature_version: version });
        } catch (e) { console.warn("[GemExporter:storage] Storage operation failed:", e); }
    }

    async function isTakeoutPromptCompleted(): Promise<boolean> {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return false;
        try {
            const data = await chrome.storage.local.get(['has_completed_takeout_prompt']);
            return !!data.has_completed_takeout_prompt;
        } catch {
            return false;
        }
    }

    async function setTakeoutPromptCompleted(completed: boolean = true): Promise<void> {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
        try {
            await chrome.storage.local.set({ has_completed_takeout_prompt: !!completed });
        } catch (e) { console.warn("[GemExporter:storage] Storage operation failed:", e); }
    }

    async function setHasImportedTakeout(imported: boolean = true): Promise<void> {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
        try {
            await chrome.storage.local.set({ has_imported_takeout: !!imported });
        } catch (e) { console.warn("[GemExporter:storage] Storage operation failed:", e); }
    }

    async function hasTakeoutData(slot: string | null = 'u0'): Promise<boolean> {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return false;
        try {
            const data = await chrome.storage.local.get(['has_imported_takeout']);
            if (data && data.has_imported_takeout) return true;
            const convs = await getConversations(slot);
            return (convs || []).some(c => (
                c && (
                    (c as any).source === 'takeout' ||
                    c.titleSource === 'takeout' ||
                    (c as any).isTakeoutOnly ||
                    (c.titles && (c.titles as any).takeout)
                )
            ));
        } catch {
            return false;
        }
    }

export {
    normSlot,
    normId,
    getStorageKeys,
    getConversations,
    setConversations,
    removeConversation,
    reconcileConversations,
    getExportedIds,
    setExportedIds,
    saveExportRecord,
    saveExportRecordsBatch,
    getLastSync,
    setLastSync,
    getAccountSlots,
    setAccountSlots,
    updateAccountSlot,
    getCredentialsMap,
    setCredentialsMap,
    clearCredentials,
    getDevMode,
    setDevMode,
    isTourCompleted,
    setTourCompleted,
    getLastSeenFeatureVersion,
    setLastSeenFeatureVersion,
    isVersionGreater,
    isTakeoutPromptCompleted,
    setTakeoutPromptCompleted,
    hasTakeoutData,
    setHasImportedTakeout
};

export const StorageService: StorageServiceModule = {
    normSlot,
    normId,
    getStorageKeys,
    getConversations,
    setConversations,
    removeConversation,
    reconcileConversations,
    getExportedIds,
    setExportedIds,
    saveExportRecord,
    saveExportRecordsBatch,
    getLastSync,
    setLastSync,
    getAccountSlots,
    setAccountSlots,
    updateAccountSlot,
    getCredentialsMap,
    setCredentialsMap,
    clearCredentials,
    getDevMode,
    setDevMode,
    isTourCompleted,
    setTourCompleted,
    getLastSeenFeatureVersion,
    setLastSeenFeatureVersion,
    isVersionGreater,
    isTakeoutPromptCompleted,
    setTakeoutPromptCompleted,
    hasTakeoutData,
    setHasImportedTakeout
};

if (typeof globalThis !== 'undefined' && !(globalThis as any).StorageService) {
    (globalThis as any).StorageService = StorageService;
}
if (typeof module === 'object' && module.exports) module.exports = StorageService;

export default StorageService;
