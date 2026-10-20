export {};
const test = require('node:test');
const assert = require('node:assert');

const { SessionStore, EXPORT_SESSION_KEY } = require('../src/core/storage/sessionStore.js');

test('sessionStore - getSession returns null when empty', async () => {
    const memoryStorage: Record<string, any> = {};
    (globalThis as any).chrome = {
        storage: {
            local: {
                get: async (keys: string[]) => {
                    const res: Record<string, any> = {};
                    for (const k of keys) {
                        if (k in memoryStorage) res[k] = memoryStorage[k];
                    }
                    return res;
                },
                set: async (obj: Record<string, any>) => {
                    Object.assign(memoryStorage, obj);
                },
                remove: async (keys: string[]) => {
                    for (const k of keys) delete memoryStorage[k];
                }
            }
        }
    };

    const session = await SessionStore.getSession();
    assert.strictEqual(session, null);
});

test('sessionStore - setSession stores session snapshot with updatedAt', async () => {
    const memoryStorage: Record<string, any> = {};
    (globalThis as any).chrome = {
        storage: {
            local: {
                get: async (keys: string[]) => {
                    const res: Record<string, any> = {};
                    for (const k of keys) {
                        if (k in memoryStorage) res[k] = memoryStorage[k];
                    }
                    return res;
                },
                set: async (obj: Record<string, any>) => {
                    Object.assign(memoryStorage, obj);
                },
                remove: async (keys: string[]) => {
                    for (const k of keys) delete memoryStorage[k];
                }
            }
        }
    };

    await SessionStore.setSession({
        status: 'running',
        slot: 'u0',
        total: 10,
        current: 2,
        lastChatId: 'c_abc123'
    });

    const stored = await SessionStore.getSession();
    assert.ok(stored);
    assert.strictEqual(stored.status, 'running');
    assert.strictEqual(stored.total, 10);
    assert.strictEqual(stored.current, 2);
    assert.strictEqual(stored.lastChatId, 'c_abc123');
    assert.ok(typeof stored.updatedAt === 'number' && stored.updatedAt > 0);
});

test('sessionStore - updateSession merges patch and updates timestamp', async () => {
    const memoryStorage: Record<string, any> = {
        [EXPORT_SESSION_KEY]: {
            status: 'running',
            slot: 'u0',
            total: 20,
            current: 5,
            updatedAt: 1000
        }
    };
    (globalThis as any).chrome = {
        storage: {
            local: {
                get: async (keys: string[]) => {
                    const res: Record<string, any> = {};
                    for (const k of keys) {
                        if (k in memoryStorage) res[k] = memoryStorage[k];
                    }
                    return res;
                },
                set: async (obj: Record<string, any>) => {
                    Object.assign(memoryStorage, obj);
                },
                remove: async (keys: string[]) => {
                    for (const k of keys) delete memoryStorage[k];
                }
            }
        }
    };

    await SessionStore.updateSession({
        current: 6,
        lastChatTitle: 'Quantum Mechanics'
    });

    const stored = await SessionStore.getSession();
    assert.ok(stored);
    assert.strictEqual(stored.status, 'running');
    assert.strictEqual(stored.total, 20);
    assert.strictEqual(stored.current, 6);
    assert.strictEqual(stored.lastChatTitle, 'Quantum Mechanics');
    assert.ok(stored.updatedAt > 1000);
});

test('sessionStore - clearSession deletes session key', async () => {
    const memoryStorage: Record<string, any> = {
        [EXPORT_SESSION_KEY]: { status: 'interrupted' }
    };
    (globalThis as any).chrome = {
        storage: {
            local: {
                get: async (keys: string[]) => {
                    const res: Record<string, any> = {};
                    for (const k of keys) {
                        if (k in memoryStorage) res[k] = memoryStorage[k];
                    }
                    return res;
                },
                set: async (obj: Record<string, any>) => {
                    Object.assign(memoryStorage, obj);
                },
                remove: async (keys: string[]) => {
                    for (const k of keys) delete memoryStorage[k];
                }
            }
        }
    };

    await SessionStore.clearSession();
    assert.strictEqual(memoryStorage[EXPORT_SESSION_KEY], undefined);
    assert.strictEqual(await SessionStore.getSession(), null);
});

test('sessionStore serializes set, update, and clear against each other', async () => {
    const memoryStorage: Record<string, any> = {};
    let releaseFirstSet!: () => void;
    let enteredFirstSet!: () => void;
    const firstSetEntered = new Promise<void>(resolve => { enteredFirstSet = resolve; });
    const firstSetGate = new Promise<void>(resolve => { releaseFirstSet = resolve; });
    let sets = 0;
    (globalThis as any).chrome = { storage: { local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in memoryStorage).map(k => [k, memoryStorage[k]])),
        set: async (obj: Record<string, any>) => {
            if (++sets === 1) { enteredFirstSet(); await firstSetGate; }
            Object.assign(memoryStorage, obj);
        },
        remove: async (keys: string[]) => { for (const k of keys) delete memoryStorage[k]; }
    } } };
    const set = SessionStore.setSession({ status: 'running', current: 1 });
    await firstSetEntered;
    const update = SessionStore.updateSession({ current: 2 });
    releaseFirstSet();
    await Promise.all([set, update]);
    assert.strictEqual(memoryStorage[EXPORT_SESSION_KEY].current, 2);
    assert.strictEqual(memoryStorage[EXPORT_SESSION_KEY].status, 'running');

    let releaseRemove!: () => void;
    let enteredRemove!: () => void;
    const removeEntered = new Promise<void>(resolve => { enteredRemove = resolve; });
    const removeGate = new Promise<void>(resolve => { releaseRemove = resolve; });
    (globalThis as any).chrome.storage.local.remove = async (keys: string[]) => {
        enteredRemove(); await removeGate;
        for (const k of keys) delete memoryStorage[k];
    };
    const clear = SessionStore.clearSession();
    await removeEntered;
    const afterClear = SessionStore.setSession({ status: 'running', current: 3 });
    releaseRemove();
    await Promise.all([clear, afterClear]);
    assert.strictEqual(memoryStorage[EXPORT_SESSION_KEY].current, 3);
});
