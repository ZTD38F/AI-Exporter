import type { Account } from '../l2/accountRegistry.js';
import type { StreamCoverage } from '../l2/streamCoverage.js';
import { inStores, readOne } from './idb.js';

export async function getCoverage(accountId: Account['id'], streamId: string): Promise<StreamCoverage | null> {
    return (await readOne('coverage', [accountId, streamId]))?.value ?? null;
}

/** Serialize Coverage read -> L2 decision -> optional write against scan cleanup. */
export function updateCoverageAtomically<R extends boolean | string | void = void>(accountId: Account['id'], streamId: string,
    decide: (current: StreamCoverage | null) => { next?: StreamCoverage; result: R }): Promise<R> {
    return inStores<R>(['coverage'], 'readwrite', (tx, done, fail) => {
        const store = tx.objectStore('coverage');
        const request = store.get([accountId, streamId]);
        request.onsuccess = () => {
            try {
                const { next, result } = decide(request.result?.value ?? null);
                if (next !== undefined) store.put({ accountId, streamId, value: next });
                done(result);
            } catch (error) { fail(error); }
        };
    });
}

/** Explicit local reset: remove this account's conversations, coverage and export history atomically. */
export function clearStoredAccountScanRecords(accountId: Account['id']): Promise<void> {
    return inStores<void>(['indexes', 'details', 'coverage', 'exportRecords'], 'readwrite', (tx, done) => {
        const range = IDBKeyRange.bound([accountId], [accountId, []]);
        tx.objectStore('indexes').delete(range);
        tx.objectStore('details').delete(range);
        tx.objectStore('coverage').delete(range);
        tx.objectStore('exportRecords').delete(range);
        done(undefined);
    });
}

/** Remove scan boundaries without changing export history or conversation facts. */
export function clearStoredAccountCoverage(accountId: Account['id']): Promise<void> {
    return inStores<void>(['coverage'], 'readwrite', (tx, done) => {
        tx.objectStore('coverage').delete(IDBKeyRange.bound([accountId], [accountId, []]));
        done(undefined);
    });
}
