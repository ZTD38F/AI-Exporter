import type { Account } from '../l2/accountRegistry.js';
import { inStore, inStores, readOne } from './idb.js';

export function getAccount(id: Account['id']): Promise<Account | null> {
    return readOne('accounts', id);
}
export function listAccounts(): Promise<Account[]> {
    return inStore('accounts', 'readonly', (store, done) => {
        const request = store.getAll();
        request.onsuccess = () => done(request.result);
    });
}
/** The unique identity lookup and insert share one readwrite transaction. */
export function insertAccountIfAbsent(account: Account): Promise<Account> {
    return inStore('accounts', 'readwrite', (store, done) => {
        const request = store.index('providerIdentity').get([account.providerId, account.providerAccountId]);
        request.onsuccess = () => {
            if (request.result !== undefined) done(request.result);
            else { store.add(account); done(account); }
        };
    });
}

/** One Account admission transaction; L2 supplies the complete synchronous selection. */
export function admitAccountAtomically(providerId: Account['providerId'],
    decide: (existing: readonly Account[]) => Account): Promise<Account> {
    return inStores<Account>(['accounts'], 'readwrite', (tx, done, fail) => {
        const store = tx.objectStore('accounts');
        const request = store.getAll();
        request.onsuccess = () => {
            try {
                const all = request.result;
                const existing = all.filter(account => account.providerId === providerId);
                const accepted = decide(existing);
                if (accepted.providerId !== providerId) throw new TypeError('Account provider mismatch');
                const saved = all.find(account => account.id === accepted.id);
                // Validate the narrowly scoped migration alias rewrite without importing L2 policy.
                const legacyPromotion = saved?.providerId === 'gemini' && accepted.providerId === 'gemini'
                    && !!saved.email && saved.providerAccountId === 'legacy-email:' + saved.email.toLowerCase()
                    && saved.email.toLowerCase() === accepted.email?.toLowerCase()
                    && /^\d+$/.test(accepted.providerAccountId);
                if (saved && (saved.providerId !== providerId
                    || (saved.providerAccountId !== accepted.providerAccountId
                        && !legacyPromotion
                        && !(saved.providerAccountId === 'default' && existing.length === 1
                            && accepted.providerAccountId !== 'default')))) {
                    throw new TypeError('Account identity cannot change');
                }
                if (all.some(account => account.id !== accepted.id && account.providerId === providerId
                    && account.providerAccountId === accepted.providerAccountId)) {
                    throw new TypeError('Duplicate account identity');
                }
                if (saved && JSON.stringify(saved) === JSON.stringify(accepted)) {
                    done(saved); return;
                }
                if (saved) store.put(accepted);
                else store.add(accepted);
                done(accepted);
            } catch (error) { fail(error); }
        };
    });
}

/** Keep the stable UUID and provider identity immutable while allowing migration Upsert. */
export function putAccount(account: Account): Promise<void> {
    return inStores<void>(['accounts'], 'readwrite', (tx, done, fail) => {
        const store = tx.objectStore('accounts');
        const request = store.get(account.id);
        request.onsuccess = () => {
            try {
                const old = request.result;
                if (old && (old.providerId !== account.providerId || old.providerAccountId !== account.providerAccountId))
                    throw new TypeError('Account identity cannot change');
                store.put(account);
                done(undefined);
            } catch (error) { fail(error); }
        };
    });
}
