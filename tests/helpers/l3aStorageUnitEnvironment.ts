import { IDBFactory, IDBObjectStore, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, afterEach } from 'node:test';

/**
 * L3a-owned unit harness. Keep the real Storage code, IDB transactions and Chrome
 * Settings adapter, but replace browser primitives with v2-compatible doubles.
 * No L1/L2/Application/Runtime/Migration implementations are loaded or invoked.
 */
export function storageUnitEnvironment(seed: Record<string, unknown> = {}) {
    const previousChrome = globalThis.chrome;
    const previousDB = globalThis.indexedDB;
    const previousRange = globalThis.IDBKeyRange;
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalPut = IDBObjectStore.prototype.put;
    const data = structuredClone(seed);
    const pendingLocks = new Map<string, Promise<void>>();
    let writes = 0;
    let failKey: string | undefined;

    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: {
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
        },
    } } });
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = IDBKeyRange;

    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
        const row = value as { key?: { accountId?: string } };
        if (failKey && (failKey === this.name || failKey === `conversations_${row.key?.accountId}`))
            throw new Error(`write failed: ${failKey}`);
        writes++;
        // An in-line-key store must receive put(value), not put(value, undefined).
        return arguments.length === 1 ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };

    globalThis.chrome = { storage: { local: {
        async get(keys: string | string[] | null) {
            const requested = keys === null ? Object.keys(data) : typeof keys === 'string' ? [keys] : keys;
            return structuredClone(Object.fromEntries(requested.filter(k => k in data).map(k => [k, data[k]])));
        },
        async set(patch: Record<string, unknown>) {
            if (failKey && Object.hasOwn(patch, failKey)) throw new Error(`write failed: ${failKey}`);
            writes++;
            Object.assign(data, structuredClone(patch));
        },
        async remove(keys: string | string[]) {
            for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key];
        },
    } } } as typeof chrome;

    return {
        local: data,
        writes: () => writes,
        fail: (key?: string) => { failKey = key; },
        restore() {
            globalThis.chrome = previousChrome;
            globalThis.indexedDB = previousDB;
            globalThis.IDBKeyRange = previousRange;
            if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
            else Reflect.deleteProperty(globalThis, 'navigator');
            IDBObjectStore.prototype.put = originalPut;
        },
    };
}

export function useStorageUnitEnvironment(): void {
    let environment: ReturnType<typeof storageUnitEnvironment>;
    beforeEach(() => { environment = storageUnitEnvironment(); });
    afterEach(() => { environment.restore(); });
}
