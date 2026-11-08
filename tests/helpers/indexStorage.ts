import { IDBFactory, IDBObjectStore, IDBKeyRange } from 'fake-indexeddb';
import { resetIndexCoverageSessions } from '../../src/l2/indexCoverage.js';
import { openStorageDB } from '../../src/l3a/idb.js';
import { insertAccountIfAbsent } from '../../src/l3a/storageService.js';
import { fixtureAccount } from './domainFixture.js';
import { ACCOUNT_UUID, OTHER_ACCOUNT_UUID } from './accountIds.js';
import { beforeEach, afterEach } from 'node:test';


/** Production Storage over a fresh IndexedDB test backend; Chrome Settings/IPC are boundary doubles. */
export function indexStorage(seed: Record<string, unknown> = {}, options: { seedAccounts?: boolean } = {}) {
    const previous = globalThis.chrome, previousDB = globalThis.indexedDB, previousRange = globalThis.IDBKeyRange;
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    // Node's fake browser environment needs the extension-origin Web Locks contract.
    const pendingLocks = new Map<string, Promise<void>>();
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en-US', locks: {
        async request<T>(name: string, callback: () => Promise<T>): Promise<T> {
            const previous = pendingLocks.get(name) ?? Promise.resolve();
            let unlock!: () => void;
            const next = new Promise<void>(resolve => { unlock = resolve; });
            pendingLocks.set(name, next);
            await previous;
            try { return await callback(); }
            finally {
                unlock();
                if (pendingLocks.get(name) === next) pendingLocks.delete(name);
            }
        }
    } } });
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = IDBKeyRange;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
        const row = value as { key?: { accountId?: string } };
        if (failKey && (failKey === this.name || failKey === `conversations_${row.key?.accountId}`)) throw new Error(`write failed: ${failKey}`);
        writes++;
        // Preserve call arity: in-line-key stores must use put(value), not put(value, undefined).
        return arguments.length === 1 ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    const local = structuredClone(seed);
    let writes = 0;
    let failKey: string | undefined;
    const accounts = new Map([
        [ACCOUNT_UUID, { id: ACCOUNT_UUID, providerId: 'gemini', providerAccountId: '10000000001' }],
        [OTHER_ACCOUNT_UUID, { id: OTHER_ACCOUNT_UUID, providerId: 'gemini', providerAccountId: '10000000002' }],
        ['10000000-0000-4000-8000-000000000003', { id: '10000000-0000-4000-8000-000000000003', providerId: 'gemini', providerAccountId: 'default' }],
    ]);
    for (const provider of ['chatgpt', 'custom', 'future', 'future-provider', 'other', 'example', 'neutral', 'openai', 'independent']) { const account = fixtureAccount(provider); accounts.set(account.id, account); }
    // Runtime Registry fixtures must also exist in the canonical v2 Storage that L2 reads.
    // Start the write before any test read opens its own connection; Account-only tests opt out.
    const ready = options.seedAccounts === false ? Promise.resolve() : openStorageDB().then(db => new Promise<void>((resolve, reject) => {
        const tx = db.transaction('accounts', 'readwrite');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Account fixture seed failed')); };
        for (const account of accounts.values()) tx.objectStore('accounts').add(account);
    }));
    globalThis.chrome = { runtime: { async sendMessage(message: Record<string, unknown>) {
        if (message.action === 'ensureV2Ready') return { ok: true };
        if (message.action === 'domainIngest') {
            const domain: typeof import('../../src/l2/ingestion.js') = require('../../src/l2/ingestion.js');
            if (message.operation === 'indexes') { const result = await domain.ingestIndexes(message.accountId as string, message.items as Parameters<typeof domain.ingestIndexes>[1], message.page as Parameters<typeof domain.ingestIndexes>[2]); return { ok: true, result }; }
            if (message.operation === 'deleted') { await domain.ingestDeletedConversation(message.accountId as string, message.conversationId as string); return { ok: true }; }
            if (message.operation === 'detail') return { ok: true, result: await domain.ingestDetail(message.accountId as string, message.conversationId as string, message.detail as Parameters<typeof domain.ingestDetail>[2], message.indexFields as Parameters<typeof domain.ingestDetail>[3]) };
        }
        if (message.action !== 'accountRegistry') return undefined;
        if (message.command === 'get') return { ok: true, value: accounts.get(String(message.accountId)) ?? null };
        if (message.command === 'list') return { ok: true, value: [...accounts.values()].filter(account => !message.providerId || account.providerId === message.providerId) };
        const found = [...accounts.values()].find(account => account.providerId === message.providerId && account.providerAccountId === message.providerAccountId);
        const candidate = found ?? { id: crypto.randomUUID(), providerId: String(message.providerId), providerAccountId: String(message.providerAccountId) };
        // Runtime get-or-create commits the Account before returning it to a caller.
        await ready;
        const account = await insertAccountIfAbsent(candidate);
        accounts.set(account.id, account);
        return { ok: true, value: account };
    } }, storage: { local: {
        async get(keys: string | string[] | null) {
            return structuredClone(keys === null ? local : Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter(k => k in local).map(k => [k, local[k]])));
        },
        async set(values: Record<string, unknown>) {
            if (failKey && failKey in values) throw new Error(`write failed: ${failKey}`);
            writes++; Object.assign(local, structuredClone(values));
        },
        async remove(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) delete local[key]; }
    } } } as typeof chrome;
    resetIndexCoverageSessions();

    return { local, ready, writes: () => writes, fail: (key?: string) => { failKey = key; },
        restore() { globalThis.chrome = previous; globalThis.indexedDB = previousDB; globalThis.IDBKeyRange = previousRange;
            if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
            else Reflect.deleteProperty(globalThis, 'navigator');
            IDBObjectStore.prototype.put = originalPut; } };
}

/** Catalog-aware application tests use the same storage boundary as production reads. */
export function useIndexStorage(options: { seedAccounts?: boolean } = {}): void {
    let environment: ReturnType<typeof indexStorage>;
    beforeEach(async () => { environment = indexStorage({}, options); await environment.ready; });
    afterEach(() => { environment.restore(); });
}
