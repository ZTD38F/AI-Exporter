export {};
const test = require('node:test');
const assert = require('node:assert');
const StorageService = require('../src/core/storage/storageService.js');

test('export alias migration cannot overwrite a concurrent runtime export record', async () => {
    const originalChrome = (global as any).chrome;
    const store: Record<string, any> = { exportedIds: { c_old: { status: 'ok' } } };
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let paused = false;
    (global as any).chrome = { storage: { local: {
        get: async (keys: any) => {
            const out: Record<string, any> = {};
            for (const key of keys) if (key in store) out[key] = JSON.parse(JSON.stringify(store[key]));
            if (!paused && keys.includes('gemini_exported_u0')) {
                paused = true;
                entered();
                await gate;
            }
            return out;
        },
        set: async (obj: any) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); },
        remove: async (keys: any) => { for (const key of keys) delete store[key]; }
    } } };
    try {
        const migration = StorageService.migrateExportAliases('u0');
        await started;
        const save = StorageService.saveExportRecord('u0', 'new', { status: 'ok' });
        await new Promise(resolve => setImmediate(resolve));
        release();
        await Promise.all([migration, save]);
        assert.deepStrictEqual(Object.keys(store.exportedIds).sort(), ['new', 'old']);
    } finally {
        release();
        (global as any).chrome = originalChrome;
    }
});
