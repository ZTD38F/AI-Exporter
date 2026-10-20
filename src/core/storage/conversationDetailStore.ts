import type { ChatMessage, Turn } from '../../types/conversation.js';
import { normId } from '../utils/pathUtils.js';
import { IDB_DATABASES } from '../utils/constants.js';

export const DETAIL_DB_NAME = IDB_DATABASES.DETAILS;
export const DETAIL_DB_VERSION = 1;
export const DETAIL_STORE = 'conversation_details';

export interface ConversationDetailRecord {
    id: string;
    messages?: ChatMessage[];
    turns?: Turn[];
    updatedAt?: number | string;
    savedAt?: number;
}

export interface ConversationDetailStoreModule {
    DETAIL_DB_NAME: string;
    DETAIL_DB_VERSION: number;
    DETAIL_STORE: string;
    openDetailDB: () => Promise<IDBDatabase>;
    getConversationDetail: (id: string) => Promise<ConversationDetailRecord | null>;
    saveConversationDetail: (id: string, detail: Partial<ConversationDetailRecord>) => Promise<boolean>;
    saveConversationDetailsBatch: (records: Record<string, Partial<ConversationDetailRecord>> | ConversationDetailRecord[]) => Promise<boolean>;
    removeConversationDetails: (ids: string[]) => Promise<number>;
    hasConversationDetail: (id: string) => Promise<boolean>;
    clearAllDetails: () => Promise<boolean>;
    __getMemoryStore: () => Map<string, ConversationDetailRecord>;
    __clearMemoryStore: () => void;
}

// In-memory fallback map for environments where IndexedDB is unavailable (e.g. Node tests)
const _memoryDetailStore = new Map<string, ConversationDetailRecord>();

export function __getMemoryStore(): Map<string, ConversationDetailRecord> {
    return _memoryDetailStore;
}

export function __clearMemoryStore(): void {
    _memoryDetailStore.clear();
}

export function openDetailDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            return reject(new Error('IndexedDB is not available in current environment'));
        }
        const req = indexedDB.open(DETAIL_DB_NAME, DETAIL_DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(DETAIL_STORE)) {
                db.createObjectStore(DETAIL_STORE, { keyPath: 'id' });
            }
        };
        req.onblocked = () => {
            console.warn(
                '[ConversationDetailStore] IndexedDB open is blocked by an unclosed connection. ' +
                'Connections must be closed after each transaction.'
            );
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function withDetailDB<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    const db = await openDetailDB();
    try {
        const tx = db.transaction(DETAIL_STORE, mode);
        const store = tx.objectStore(DETAIL_STORE);
        const txDone = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        });
        const result = await fn(store);
        await txDone;
        return result;
    } finally {
        try {
            db.close();
        } catch {}
    }
}

export async function getConversationDetail(id: string): Promise<ConversationDetailRecord | null> {
    const nid = normId(id);
    if (!nid) return null;

    if (typeof indexedDB === 'undefined') {
        const item = _memoryDetailStore.get(nid);
        return item ? { ...item } : null;
    }

    try {
        return await withDetailDB('readonly', (store) => new Promise((resolve, reject) => {
            const req = store.get(nid);
            req.onsuccess = () => resolve(req.result ? { ...req.result } : null);
            req.onerror = () => reject(req.error);
        }));
    } catch (e) {
        console.warn('[ConversationDetailStore] getConversationDetail failed:', e);
        const mem = _memoryDetailStore.get(nid);
        return mem ? { ...mem } : null;
    }
}

function isExistingDetailLonger(
    existing: ConversationDetailRecord | undefined | null,
    incoming: ConversationDetailRecord
): boolean {
    if (!existing) return false;
    const incomingLen = Math.max(
        Array.isArray(incoming.messages) ? incoming.messages.length : 0,
        Array.isArray(incoming.turns) ? incoming.turns.length : 0
    );
    const existingLen = Math.max(
        Array.isArray(existing.messages) ? existing.messages.length : 0,
        Array.isArray(existing.turns) ? existing.turns.length : 0
    );
    return existingLen > incomingLen;
}

export async function saveConversationDetail(id: string, detail: Partial<ConversationDetailRecord>): Promise<boolean> {
    const nid = normId(id);
    if (!nid) return false;

    const record: ConversationDetailRecord = {
        id: nid,
        messages: Array.isArray(detail.messages) ? detail.messages : [],
        turns: Array.isArray(detail.turns) ? detail.turns : [],
        updatedAt: detail.updatedAt,
        savedAt: Date.now()
    };

    if (typeof indexedDB === 'undefined') {
        const existing = _memoryDetailStore.get(nid);
        if (isExistingDetailLonger(existing, record)) {
            return true;
        }
        _memoryDetailStore.set(nid, record);
        return true;
    }

    try {
        return await withDetailDB('readwrite', async (store) => {
            return new Promise<boolean>((resolve, reject) => {
                const getReq = store.get(nid);
                getReq.onerror = () => reject(getReq.error);
                getReq.onsuccess = () => {
                    const existing = getReq.result as ConversationDetailRecord | undefined;
                    if (isExistingDetailLonger(existing, record)) {
                        resolve(true);
                        return;
                    }
                    const putReq = store.put(record);
                    putReq.onerror = () => reject(putReq.error);
                    putReq.onsuccess = () => resolve(true);
                };
            });
        });
    } catch (e) {
        console.error('[ConversationDetailStore] saveConversationDetail failed:', e);
        const existing = _memoryDetailStore.get(nid);
        if (!isExistingDetailLonger(existing, record)) {
            _memoryDetailStore.set(nid, record);
        }
        throw e;
    }
}

export async function saveConversationDetailsBatch(
    records: Record<string, Partial<ConversationDetailRecord>> | ConversationDetailRecord[]
): Promise<boolean> {
    const rawEntries: ConversationDetailRecord[] = [];

    if (Array.isArray(records)) {
        for (const r of records) {
            if (!r || !r.id) continue;
            const nid = normId(r.id);
            if (!nid) continue;
            rawEntries.push({
                id: nid,
                messages: Array.isArray(r.messages) ? r.messages : [],
                turns: Array.isArray(r.turns) ? r.turns : [],
                updatedAt: r.updatedAt,
                savedAt: Date.now()
            });
        }
    } else if (records && typeof records === 'object') {
        for (const [id, r] of Object.entries(records)) {
            if (!id || !r) continue;
            const nid = normId(id);
            if (!nid) continue;
            rawEntries.push({
                id: nid,
                messages: Array.isArray(r.messages) ? r.messages : [],
                turns: Array.isArray(r.turns) ? r.turns : [],
                updatedAt: r.updatedAt,
                savedAt: Date.now()
            });
        }
    }

    if (rawEntries.length === 0) return true;

    // Intra-batch dedup: retain fuller record if same ID appears multiple times
    const dedupedMap = new Map<string, ConversationDetailRecord>();
    for (const entry of rawEntries) {
        const prev = dedupedMap.get(entry.id);
        if (prev && isExistingDetailLonger(prev, entry)) {
            continue;
        }
        dedupedMap.set(entry.id, entry);
    }
    const entries = Array.from(dedupedMap.values());

    const setMemoryMonotonic = (entry: ConversationDetailRecord) => {
        const existing = _memoryDetailStore.get(entry.id);
        if (isExistingDetailLonger(existing, entry)) return;
        _memoryDetailStore.set(entry.id, entry);
    };

    if (typeof indexedDB === 'undefined') {
        for (const entry of entries) {
            setMemoryMonotonic(entry);
        }
        return true;
    }

    try {
        return await withDetailDB('readwrite', async (store) => {
            await Promise.all(entries.map(entry => new Promise<void>((resolve, reject) => {
                const getReq = store.get(entry.id);
                getReq.onerror = () => reject(getReq.error);
                getReq.onsuccess = () => {
                    const existing = getReq.result as ConversationDetailRecord | undefined;
                    if (isExistingDetailLonger(existing, entry)) {
                        resolve();
                        return;
                    }
                    const putReq = store.put(entry);
                    putReq.onerror = () => reject(putReq.error);
                    putReq.onsuccess = () => resolve();
                };
            })));
            return true;
        });
    } catch (e) {
        console.error('[ConversationDetailStore] saveConversationDetailsBatch failed:', e);
        for (const entry of entries) {
            setMemoryMonotonic(entry);
        }
        throw e;
    }
}

export async function removeConversationDetails(ids: string[]): Promise<number> {
    if (!ids || ids.length === 0) return 0;
    const nids = Array.from(new Set(ids.map(normId).filter(Boolean)));
    if (nids.length === 0) return 0;

    let removed = 0;
    if (typeof indexedDB === 'undefined') {
        for (const nid of nids) {
            if (_memoryDetailStore.delete(nid)) removed++;
        }
        return removed;
    }

    try {
        return await withDetailDB('readwrite', async (store) => {
            for (const nid of nids) {
                store.delete(nid);
                removed++;
            }
            return removed;
        });
    } catch (e) {
        console.warn('[ConversationDetailStore] removeConversationDetails failed:', e);
        for (const nid of nids) {
            if (_memoryDetailStore.delete(nid)) removed++;
        }
        return removed;
    }
}

export async function hasConversationDetail(id: string): Promise<boolean> {
    const nid = normId(id);
    if (!nid) return false;

    if (typeof indexedDB === 'undefined') {
        return _memoryDetailStore.has(nid);
    }

    try {
        return await withDetailDB('readonly', (store) => new Promise((resolve, reject) => {
            const req = store.count(nid);
            req.onsuccess = () => resolve(req.result > 0);
            req.onerror = () => reject(req.error);
        }));
    } catch (e) {
        return _memoryDetailStore.has(nid);
    }
}

export async function clearAllDetails(): Promise<boolean> {
    _memoryDetailStore.clear();
    if (typeof indexedDB === 'undefined') return true;

    try {
        return await withDetailDB('readwrite', async (store) => {
            store.clear();
            return true;
        });
    } catch (e) {
        console.warn('[ConversationDetailStore] clearAllDetails failed:', e);
        return false;
    }
}

export const ConversationDetailStore: ConversationDetailStoreModule = {
    DETAIL_DB_NAME,
    DETAIL_DB_VERSION,
    DETAIL_STORE,
    openDetailDB,
    getConversationDetail,
    saveConversationDetail,
    saveConversationDetailsBatch,
    removeConversationDetails,
    hasConversationDetail,
    clearAllDetails,
    __getMemoryStore,
    __clearMemoryStore
};

export default ConversationDetailStore;
