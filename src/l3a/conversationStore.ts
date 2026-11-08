import type { Account } from '../l2/accountRegistry.js';
import type { ConversationKey } from '../l2/conversationKey.js';
import type { DomainConversationIndex } from '../l2/conversationIndex.js';
import type { DomainConversationDetail } from '../l2/conversationDetail.js';
import type { DetailIngestResult } from '../l2/ingestion.js';
import { inStore, inStores, readOne } from './idb.js';

export const conversationAddress = (key: ConversationKey): [string, string] => [key.accountId, key.conversationId];

/** L2 has already verified the source event; Storage atomically removes only this key. */
export function deleteStoredConversation(key: ConversationKey): Promise<void> {
    return inStores<void>(['indexes', 'details', 'exportRecords'], 'readwrite', (tx, done) => {
        const address = conversationAddress(key);
        tx.objectStore('indexes').delete(address);
        tx.objectStore('details').delete(address);
        tx.objectStore('exportRecords').delete(address);
        done(undefined);
    });
}
export function getIndex(key: ConversationKey): Promise<DomainConversationIndex | null> {
    return readOne('indexes', conversationAddress(key));
}
export function listIndexes(accountId: Account['id']): Promise<DomainConversationIndex[]> {
    return inStore('indexes', 'readonly', (store, done) => {
        const request = store.getAll(IDBKeyRange.bound([accountId], [accountId, []]));
        request.onsuccess = () => done(request.result);
    });
}
export async function putIndexes(accepted: readonly DomainConversationIndex[]): Promise<void> {
    if (!accepted.length) return;
    await inStore('indexes', 'readwrite', store => { for (const index of accepted) store.put(index); });
}
export function getDetail(key: ConversationKey): Promise<DomainConversationDetail | null> {
    return readOne('details', conversationAddress(key));
}

/** L2 supplies all decisions; both reads and writes stay inside one native IDB transaction. */
export function updateIndexesAtomically(keys: readonly ConversationKey[],
    decide: (old: readonly (DomainConversationIndex | null)[]) => readonly DomainConversationIndex[]): Promise<void> {
    const addresses = keys.map(key => JSON.stringify(conversationAddress(key)));
    const allowed = new Set(addresses);
    if (allowed.size !== keys.length) return Promise.reject(new TypeError('Duplicate Index admission key'));
    return inStores<void>(['indexes'], 'readwrite', (tx, done, fail) => {
        const store = tx.objectStore('indexes');
        if (keys.length === 0) {
            try {
                if (decide([]).length !== 0) throw new TypeError('Index decision key mismatch');
                done(undefined);
            } catch (error) { fail(error); }
            return;
        }
        const previous: (DomainConversationIndex | null)[] = new Array<DomainConversationIndex | null>(keys.length);
        let remaining = keys.length;
        keys.forEach((key, i) => {
            const request = store.get(conversationAddress(key));
            request.onsuccess = () => {
                previous[i] = request.result ?? null;
                if (--remaining !== 0) return;
                try {
                    const accepted = decide(previous);
                    const written = new Set<string>();
                    for (const row of accepted) {
                        const address = JSON.stringify(conversationAddress(row.key));
                        if (!allowed.has(address)) throw new TypeError('Index decision key mismatch');
                        if (written.has(address)) throw new TypeError('Duplicate Index decision key');
                        written.add(address);
                        store.put(row);
                    }
                    done(undefined);
                } catch (error) { fail(error); }
            };
        });
    });
}

/** The Index get-or-create and Detail selection commit atomically across both stores. */
export function updateConversationAtomically<R extends DetailIngestResult | void = DetailIngestResult>(key: ConversationKey,
    decide: (oldIndex: DomainConversationIndex | null, oldDetail: DomainConversationDetail | null) =>
        { index?: DomainConversationIndex; detail?: DomainConversationDetail; result: R }): Promise<R> {
    return inStores<R>(['indexes', 'details'], 'readwrite', (tx, done, fail) => {
        const indexes = tx.objectStore('indexes'), details = tx.objectStore('details');
        let oldIndex: DomainConversationIndex | null = null, oldDetail: DomainConversationDetail | null = null;
        let remaining = 2;
        const decideAndWrite = () => {
            if (--remaining !== 0) return;
            try {
                const accepted = decide(oldIndex, oldDetail);
                for (const row of [accepted.index, accepted.detail]) {
                    if (row && (row.key.accountId !== key.accountId || row.key.conversationId !== key.conversationId))
                        throw new TypeError('Conversation decision key mismatch');
                }
                if (accepted.detail && !accepted.index && !oldIndex)
                    throw new TypeError('Detail requires a matching Index');
                if (accepted.index) indexes.put(accepted.index);
                if (accepted.detail) details.put(accepted.detail);
                done(accepted.result);
            } catch (error) { fail(error); }
        };
        const indexRequest = indexes.get(conversationAddress(key));
        indexRequest.onsuccess = () => { oldIndex = indexRequest.result ?? null; decideAndWrite(); };
        const detailRequest = details.get(conversationAddress(key));
        detailRequest.onsuccess = () => { oldDetail = detailRequest.result ?? null; decideAndWrite(); };
    });
}
