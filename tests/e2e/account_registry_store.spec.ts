import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import * as path from 'node:path';
let bundle: string;
test.beforeAll(async () => {
    const output = await build({ stdin: { contents: `
        import * as registry from './src/l3a/accountRegistryStore.ts';
        import { readAccountRegistry } from './src/l2/accountRegistry.ts';
        import { getOrCreateAccount } from './src/l2/accountAdmission.ts';
        import { openStorageDB as openDomainDB } from './src/l3a/idb.ts';
        globalThis.registryProbe = { ...registry, listAccounts: async () => readAccountRegistry(await registry.listAccounts()), getOrCreateAccount, openDomainDB };
    `, resolveDir: path.resolve(__dirname, '../..'), loader: 'ts' }, bundle: true, write: false, platform: 'browser', format: 'iife' });
    bundle = output.outputFiles[0].text;
});
test.beforeEach(async ({ page }) => {
    await page.route('https://registry.test/**', route => route.fulfill({ contentType: 'text/html', body: '<html>Registry persistence</html>' }));
    await page.goto('https://registry.test/');
    await page.addScriptTag({ content: bundle });
});
test('aborted transaction never acknowledges creation and retry persists one account', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const api = Reflect.get(globalThis, 'registryProbe');
        const original = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (...args) {
            const request = original.apply(this, args);
            request.addEventListener('success', () => this.transaction.abort(), { once: true });
            return request;
        };
        let rejected = false;
        try { await api.getOrCreateAccount('gemini', 'abort-subject'); }
        catch { rejected = true; }
        finally { IDBObjectStore.prototype.add = original; }
        const empty = await api.listAccounts();
        const saved = await api.getOrCreateAccount('gemini', 'abort-subject');
        return { rejected, empty, saved };
    });
    expect(result.rejected).toBe(true);
    expect(result.empty).toEqual([]);
    expect(result.saved.id).toMatch(/^[a-f0-9-]{36}$/);
    await page.reload(); await page.addScriptTag({ content: bundle });
    const restored = await page.evaluate(async () => Reflect.get(globalThis, 'registryProbe').listAccounts());
    expect(restored).toEqual([result.saved]);
});
test('malformed disk accounts fail closed without read repair or replacement', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const api = Reflect.get(globalThis, 'registryProbe');
        const bad = { id: 'u0', providerId: 'gemini', providerAccountId: 'bad-record', slot: 'u0' };
        const db = await api.openDomainDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('accounts', 'readwrite');
            tx.objectStore('accounts').put(bad);
            tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        });
        db.close();
        let readRejected = false, writeRejected = false;
        try { await api.listAccounts(); } catch { readRejected = true; }
        try { await api.getOrCreateAccount('gemini', 'bad-record'); } catch { writeRejected = true; }
        const readDB = await api.openDomainDB();
        const raw = await new Promise(resolve => {
            const tx = readDB.transaction('accounts', 'readonly');
            const request = tx.objectStore('accounts').getAll();
            request.onsuccess = () => resolve(request.result);
        });
        readDB.close();
        return { readRejected, writeRejected, raw, bad };
    });
    expect(result.readRejected).toBe(true);
    expect(result.writeRejected).toBe(true);
    expect(result.raw).toEqual([result.bad]);
});

test('concurrent default admission promotes in place and never creates a second placeholder', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const api = Reflect.get(globalThis, 'registryProbe');
        const defaults = await Promise.all(Array.from({length: 16},
            () => api.getOrCreateAccount('gemini', 'default', 'unverified@example.com', 'Unverified')));
        const otherProvider = await api.getOrCreateAccount('chatgpt', 'default');
        const real = await api.getOrCreateAccount('gemini', 'verified-gaia', 'verified@example.com');
        const second = await api.getOrCreateAccount('gemini', 'second-gaia');
        const fallback = await api.getOrCreateAccount('gemini', 'default');
        return { defaults, otherProvider, real, second, fallback, all: await api.listAccounts() };
    });
    const placeholder = result.defaults[0];
    expect(new Set(result.defaults.map(account => account.id)).size).toBe(1);
    expect(placeholder).toEqual({ id: placeholder.id, providerId: 'gemini', providerAccountId: 'default' });
    expect(result.real.id).toBe(placeholder.id);
    expect(result.otherProvider.id).not.toBe(placeholder.id);
    expect(result.second.id).not.toBe(placeholder.id);
    expect(result.fallback.id).toBe([result.real, result.second].sort((a, b) => a.id.localeCompare(b.id))[0].id);
    expect(result.all).toHaveLength(3);
    expect(result.all.some((account: { providerId: string; providerAccountId: string }) => account.providerId === 'gemini' && account.providerAccountId === 'default')).toBe(false);
    await page.reload(); await page.addScriptTag({ content: bundle });
    expect(await page.evaluate(async () => Reflect.get(globalThis, 'registryProbe').getOrCreateAccount('gemini','default')))
        .toEqual(result.fallback);
});
