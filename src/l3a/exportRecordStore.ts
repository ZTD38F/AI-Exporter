import type { Account } from '../l2/accountRegistry.js';
import type { ConversationKey } from '../l2/conversationKey.js';
import type { ExportRecord } from '../application/export/types.js';
import { inStore, readOne, putOne } from './idb.js';
import { conversationAddress } from './conversationStore.js';

export async function getExportRecord(key: ConversationKey): Promise<ExportRecord | null> {
    return (await readOne('exportRecords', conversationAddress(key)))?.value ?? null;
}
export function listExportRecords(accountId: Account['id']): Promise<Record<string, ExportRecord>> {
    return inStore('exportRecords', 'readonly', (store, done) => {
        const request = store.getAll(IDBKeyRange.bound([accountId], [accountId, []]));
        request.onsuccess = () => {
            done(Object.fromEntries(request.result.map(row => [row.conversationId, row.value])));
        };
    });
}
export function putExportRecord(key: ConversationKey, record: ExportRecord): Promise<void> {
    return putOne('exportRecords', { ...key, value: record });
}
/** Remove only this account's export history in one transaction. */
export function clearStoredAccountExportRecords(accountId: Account['id']): Promise<void> {
    return inStore('exportRecords', 'readwrite', store => {
        store.delete(IDBKeyRange.bound([accountId], [accountId, []]));
    });
}
