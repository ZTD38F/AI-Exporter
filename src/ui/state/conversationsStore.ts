import type { Conversation } from '../../types/conversation.js';
import type { ExportRecord, IConversationsStore } from '../../types/ui.js';
import { __resolveModule } from '../../core/utils/moduleOverrides.js';

import StorageService from '../../core/storage/storageService.js';
import GeminiUtils, {
    normId as utilsNormId,
    deduplicateConversations as utilsDeduplicateConversations,
    isTakeoutConversation
} from '../../core/utils/utils.js';
import { STORAGE_KEYS } from '../../core/utils/constants.js';

let conversations: Conversation[] = [];
let exportedIds: Record<string, ExportRecord> = {};
let currentSlot: string = 'u0';
let accountSlots: Record<string, any> = {};

const getStorage = (): any => __resolveModule('StorageService', StorageService);
const getUtils = (): any => __resolveModule('GeminiUtils', GeminiUtils);

export const normId = (id?: string | null): string => {
    const utils = getUtils();
    if (utils && typeof utils.normId === 'function') return utils.normId(id);
    return utilsNormId(id);
};

export function getConversations(): Conversation[] { return conversations; }
export function setConversations(list: Conversation[]): void { conversations = list || []; }
export function getExportedIds(): Record<string, ExportRecord> { return exportedIds; }

// Fold legacy alias keys ('c_<id>' / raw id) into canonical normId keys for consistent in-memory lookups
function collapseExportAliases(map: Record<string, any>): void {
    for (const k of Object.keys(map)) {
        const ck = normId(k);
        if (!ck || ck === k) continue;
        if (!(ck in map)) {
            map[ck] = map[k];
        }
        delete map[k];
    }
}

export function setExportedIds(map: Record<string, ExportRecord>): void {
    const next = map || {};
    collapseExportAliases(next);
    exportedIds = next;
 }
export function getCurrentSlot(): string { return currentSlot; }
export function setCurrentSlot(slot: string): void { currentSlot = slot || 'u0'; }
export function getAccountSlots(): Record<string, any> { return accountSlots; }
export function setAccountSlots(map: Record<string, any>): void { accountSlots = map || {}; }

export function getExportedRecord(id?: string | null): ExportRecord | null {
    if (!id || !exportedIds) return null;
    return exportedIds[normId(id)] || null;
}

export function getSignature(list?: Conversation[]): string {
    const l = list || conversations;
    if (!l || !l.length) return 'empty';
    try {
        const items = l.map(c => `${c.id}:${(c.title || '').slice(0, 15)}`);
        if (items.length <= 6) return items.join('|') + '|' + items.length;
        const titleSum = l.reduce((acc, c) => acc + (c.title ? c.title.charCodeAt(0) : 0), 0);
        return items.slice(0, 3).join(',') + '|' + items.slice(-3).join(',') + '|len=' + items.length + '|ts=' + titleSum;
    } catch {
        return 'err-' + (l.length || 0);
    }
}

export async function loadStore(slotOverride?: string): Promise<{
    conversations: Conversation[];
    exportedIds: Record<string, ExportRecord>;
    slot: string;
    accountSlots: Record<string, any>;
}> {
    let slot = slotOverride || currentSlot || 'u0';
    const storage = getStorage();
    const slots = storage ? await storage.getAccountSlots() : ((await chrome.storage.local.get([STORAGE_KEYS.ACCOUNT_SLOTS]))[STORAGE_KEYS.ACCOUNT_SLOTS] || {});
    setAccountSlots(slots);

    let incoming = (storage ? await storage.getConversations(slot) : []) || [];
    // Only fall back to another slot on initial cold launch if no slot was requested
    if (!slotOverride && !currentSlot && (!incoming || !incoming.length)) {
        const candidates = ['u0', ...Object.keys(slots || {})].filter(s => s !== slot);
        for (const cand of candidates) {
            const candConvs = storage ? await storage.getConversations(cand) : [];
            if (candConvs && candConvs.length > 0) {
                slot = cand;
                incoming = candConvs;
                break;
            }
        }
    }
    setCurrentSlot(slot);

    const expIds = storage ? await storage.getExportedIds(slot) : {};
    setExportedIds(expIds);
    setConversations(incoming);
    return { conversations: incoming, exportedIds: expIds, slot, accountSlots: slots };
}

export async function getLastSync(slot?: string): Promise<{ timestamp: number | null; count: number }> {
    const s = slot || currentSlot || 'u0';
    const storage = getStorage();
    if (storage?.getLastSync) return await storage.getLastSync(s);
    return { timestamp: null, count: 0 };
}

export async function saveConversations(slot: string, list: Conversation[]): Promise<void> {
    const s = slot || currentSlot;
    const storage = getStorage();
    if (storage?.setConversations) await storage.setConversations(s, list);
    if (s === currentSlot) setConversations(list);
}

export async function clearExported(slot: string): Promise<void> {
    const s = slot || currentSlot;
    const storage = getStorage();
    if (storage?.removeExportRecords) {
        // P1-3: clear via the transactional delete path instead of a bare
        // whole-map overwrite. removeExportRecords re-reads the map inside the
        // storage write chain and deletes only the listed ids, so records
        // written concurrently by saveExportRecord can neither be clobbered
        // (overwrite race) nor resurrected (delete-then-write race).
        const cur = (storage?.getExportedIds ? await storage.getExportedIds(s) : null) || {};
        await storage.removeExportRecords(s, Object.keys(cur));
    }
    if (s === currentSlot) setExportedIds({});
}

export async function clearAll(slot: string): Promise<void> {
    const s = slot || currentSlot;
    const storage = getStorage();
    if (storage?.clearConversations) {
        await storage.clearConversations(s);
    } else if (storage?.setConversations) {
        await storage.setConversations(s, []);
    }
    if (s === currentSlot) {
        setConversations([]);
        setExportedIds({});
    }
}

export async function getDevMode(): Promise<boolean> {
    const storage = getStorage();
    if (storage?.getDevMode) return await storage.getDevMode();
    return false;
}

export async function setDevMode(devOn: boolean): Promise<void> {
    const storage = getStorage();
    if (storage?.setDevMode) await storage.setDevMode(devOn);
}

export async function removeConversation(id: string): Promise<Conversation[]> {
    if (!id) return conversations;
    const nid = normId(id);
    const storage = getStorage();
    // Write-through: persist to storage first so a storage failure does not
    // leave the in-memory cache out of sync (item gone from cache but still
    // in chrome.storage). If the await throws, memory stays untouched.
    if (storage?.removeConversation) {
        await storage.removeConversation(currentSlot, nid);
    }
    conversations = (conversations || []).filter(c => normId(c.id) !== nid);
    return conversations;
}

export async function reconcileWithCloud(activeCloudList: any[], options: any = {}): Promise<{ kept: number; removed: number; removedIds: string[] }> {
    const storage = getStorage();
    if (storage && storage.reconcileConversations) {
        const res = await storage.reconcileConversations(currentSlot, activeCloudList, options);
        const activeIdSet = new Set((activeCloudList || []).map(c => normId(c.id)));
        const keepTakeout = options.keepTakeout !== false;
        conversations = (conversations || []).filter(c => {
            const nid = normId(c.id);
            const isTakeout = keepTakeout && isTakeoutConversation(c);
            return activeIdSet.has(nid) || isTakeout;
        });
        return res;
    }
    return { kept: conversations.length, removed: 0, removedIds: [] };
}

export function normalizeAndDeduplicate(incoming: Conversation[]): { processed: Conversation[]; hasDirtyTitles: boolean; changedCount: number } {
    if (!Array.isArray(incoming)) return { processed: [], hasDirtyTitles: false, changedCount: 0 };
    const utils = getUtils();
    if (utils && typeof utils.deduplicateConversations === 'function') {
        const res = utils.deduplicateConversations(incoming);
        return { processed: res.processed, hasDirtyTitles: res.hasDirtyTitles, changedCount: res.changedCount || 0 };
    }

    const res = utilsDeduplicateConversations(incoming);
    return { processed: res.processed, hasDirtyTitles: res.hasDirtyTitles, changedCount: res.changedCount || 0 };
}

export function hasTakeoutData(): boolean {
    return (conversations || []).some(c => c && isTakeoutConversation(c));
}

export const ConversationsStore: IConversationsStore = {
    getConversations,
    setConversations,
    removeConversation,
    reconcileWithCloud,
    getExportedIds,
    setExportedIds,
    getCurrentSlot,
    setCurrentSlot,
    getAccountSlots,
    setAccountSlots,
    getExportedRecord,
    getSignature,
    loadStore,
    getLastSync,
    saveConversations,
    clearExported,
    clearAll,
    getDevMode,
    setDevMode,
    normalizeAndDeduplicate,
    hasTakeoutData,
    normId
};

export default ConversationsStore;
