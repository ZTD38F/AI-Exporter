import type { Account } from '../l2/accountRegistry.js';
import type { DomainConversationIndex } from '../l2/conversationIndex.js';
import type { DomainConversationDetail } from '../l2/conversationDetail.js';
import type { StreamCoverage } from '../l2/streamCoverage.js';
import type { DetailIngestResult } from '../l2/ingestion.js';
import type { ExportRecord } from '../application/export/types.js';

const DATABASE_NAME = 'gemini_exporter_v2';
const DATABASE_VERSION = 1;

interface CoverageRow { accountId: string; streamId: string; value: StreamCoverage }
interface ExportRow { accountId: string; conversationId: string; value: ExportRecord }

interface StoreValueMap {
    accounts: Account;
    indexes: DomainConversationIndex;
    details: DomainConversationDetail;
    coverage: CoverageRow;
    exportRecords: ExportRow;
    directoryHandles: FileSystemDirectoryHandle | null;
}
type StoreName = keyof StoreValueMap;

interface TypedObjectStore<V> extends Omit<IDBObjectStore, 'get' | 'getAll' | 'index' | 'put' | 'add'> {
    get(query: IDBValidKey | IDBKeyRange): IDBRequest<V | undefined>;
    getAll(query?: IDBValidKey | IDBKeyRange | null, count?: number): IDBRequest<V[]>;
    put(value: V, key?: IDBValidKey): IDBRequest<IDBValidKey>;
    add(value: V, key?: IDBValidKey): IDBRequest<IDBValidKey>;
    index(name: string): Omit<IDBIndex, 'get'> & {
        get(query: IDBValidKey | IDBKeyRange): IDBRequest<V | undefined>;
    };
}

interface TypedIDBTransaction extends Omit<IDBTransaction, 'objectStore'> {
    objectStore<S extends StoreName>(name: S): TypedObjectStore<StoreValueMap[S]>;
}

declare global {
    interface IDBDatabase {
        transaction(storeNames: StoreName | readonly StoreName[], mode?: IDBTransactionMode, options?: IDBTransactionOptions): TypedIDBTransaction;
    }
}

type StoreQueryResult = void | boolean | string | Account | Account[] | DomainConversationIndex | DomainConversationIndex[]
    | DomainConversationDetail | CoverageRow | ExportRow | Record<string, ExportRecord>
    | FileSystemDirectoryHandle | DetailIngestResult | null;

/** Call from an extension-origin context. Browser Runtime owns IPC routing. */
export function openStorageDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            db.createObjectStore('accounts', { keyPath: 'id' })
                .createIndex('providerIdentity', ['providerId', 'providerAccountId'], { unique: true });
            db.createObjectStore('indexes', { keyPath: ['key.accountId', 'key.conversationId'] });
            db.createObjectStore('details', { keyPath: ['key.accountId', 'key.conversationId'] });
            db.createObjectStore('coverage', { keyPath: ['accountId', 'streamId'] });
            db.createObjectStore('exportRecords', { keyPath: ['accountId', 'conversationId'] });
            db.createObjectStore('directoryHandles');
        };
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => db.close();
            resolve(db);
        };
        request.onerror = () => reject(request.error);
    });
}

/** Run synchronous IDB requests in one store-scoped transaction, resolving only after commit. */
export async function inStores<T extends StoreQueryResult = void>(names: readonly StoreName[], mode: IDBTransactionMode,
    run: (tx: TypedIDBTransaction, result: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    const db = await openStorageDB();
    try {
        return await new Promise<T>((resolve, reject) => {
            const tx = db.transaction([...names], mode);
            let value: T, failure: unknown;
            const fail = (error: unknown) => {
                failure = error;
                try { tx.abort(); } catch { reject(error); }
            };
            tx.oncomplete = () => resolve(value);
            tx.onabort = () => reject(failure ?? tx.error ?? new Error('Storage transaction aborted'));
            try { run(tx, result => { value = result; }, fail); }
            catch (error) { fail(error); }
        });
    } finally { db.close(); }
}
export function inStore<S extends StoreName, T extends StoreQueryResult = void>(name: S, mode: IDBTransactionMode,
    run: (store: TypedObjectStore<StoreValueMap[S]>, result: (value: T) => void) => void): Promise<T> {
    return inStores([name], mode, (tx, done) => run(tx.objectStore(name), done));
}

export function readOne<S extends StoreName>(store: S, key: IDBValidKey): Promise<StoreValueMap[S] | null> {
    return inStore(store, 'readonly', (table, done) => {
        const request = table.get(key);
        request.onsuccess = () => done(request.result ?? null);
    });
}
export function putOne<S extends StoreName>(store: S, value: StoreValueMap[S], key?: IDBValidKey): Promise<void> {
    return inStore(store, 'readwrite', table => {
        // In-line keyPath stores require a value-only put; out-of-line stores use an explicit key.
        if (key === undefined) table.put(value);
        else table.put(value, key);
    });
}
