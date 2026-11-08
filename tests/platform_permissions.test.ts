import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RESOURCE_DOWNLOAD_ORIGINS, resourceDownloadOrigin, PLATFORM_HOSTS, platformOrigins, SOURCE_PLATFORMS, ACTIVE_SOURCE_PLATFORMS, type SourcePlatform } from '../src/shared/platformHosts.js';
import { hasResourceAccess, requestResourceAccess, hasPlatformAccess, requestPlatformsAccess } from '../src/l1/client/platformAccess.js';
import { syncPlatformContentScripts, syncAllPlatformContentScripts } from '../src/runtime/capabilities/platformInjection.js';

const platforms = SOURCE_PLATFORMS;
test('manifest declares exactly the independent optional platform groups and no static source scripts', () => {
    const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
    assert.deepEqual(manifest.host_permissions ?? [], []);
    assert.deepEqual(manifest.content_scripts ?? [], []);
    const origins = ACTIVE_SOURCE_PLATFORMS.flatMap(platformOrigins);
    assert.equal(new Set(origins).size, origins.length);
    assert.deepEqual([...manifest.optional_host_permissions].sort(), [...origins].sort(),
        'production manifest must only request Gemini source and attachment hosts');
    assert.ok(!manifest.optional_host_permissions.some((origin: string) =>
        /(chatgpt|openai|claude|grok|sanity)/.test(origin)), 'future provider hosts must remain dormant');
    assert.ok(platformOrigins('chatgpt').includes('https://images.openai.com/*'));
    assert.ok(!platformOrigins('gemini').includes('https://images.openai.com/*'));
});

test('only an explicit platform grant registers its scripts; revocation preserves other groups', async () => {
    const holder = globalThis as unknown as { chrome?: unknown };
    const original = holder.chrome;
    const granted = new Set<string>();
    const scripts = new Map<string, chrome.scripting.RegisteredContentScript>();
    const requests: string[][] = [];
    let pendingGesture = false;
    holder.chrome = {
        permissions: {
            contains: async ({ origins }: { origins: string[] }) => origins.every(origin => granted.has(origin)),
            request: ({ origins }: { origins: string[] }) => {
                assert.ok(pendingGesture, 'request starts before returning from the user gesture');
                requests.push(origins);
                origins.forEach(origin => granted.add(origin));
                return Promise.resolve(true);
            },
        },
        scripting: {
            getRegisteredContentScripts: async ({ ids }: { ids: string[] }) => ids.flatMap(id => scripts.has(id) ? [scripts.get(id)!] : []),
            registerContentScripts: async (entries: chrome.scripting.RegisteredContentScript[]) => {
                for (const entry of entries) { assert.ok(!scripts.has(entry.id), 'no duplicate registration'); scripts.set(entry.id, entry); }
            },
            unregisterContentScripts: async ({ ids }: { ids: string[] }) => { ids.forEach(id => scripts.delete(id)); },
        },
    };
    try {
        await syncAllPlatformContentScripts();
        assert.equal(scripts.size, 0);
        assert.deepEqual(requests, []);
        for (const platform of platforms) {
            pendingGesture = true;
            const request = requestPlatformsAccess([platform]);
            pendingGesture = false;
            assert.equal(await request, true);
            assert.equal(await hasPlatformAccess(platform), true);
            assert.deepEqual(requests.at(-1), platformOrigins(platform));
            await Promise.all([syncPlatformContentScripts(platform), syncPlatformContentScripts(platform)]);
            const main = scripts.get(`${platform}-source-main`)!;
            assert.equal(main.world, 'MAIN');
            assert.deepEqual(main.matches, [...PLATFORM_HOSTS[platform].pages]);
            assert.equal(main.runAt, 'document_start');
        }
        assert.equal(scripts.size, platforms.length * 2);
        platformOrigins('gemini').forEach(origin => granted.delete(origin));
        await syncAllPlatformContentScripts();
        assert.deepEqual([...scripts.keys()].sort(), ['chatgpt-source-content', 'chatgpt-source-main', 'claude-source-content', 'claude-source-main', 'grok-source-content', 'grok-source-main']);
        assert.equal(await hasPlatformAccess('gemini'), false);
    } finally { holder.chrome = original; }
});

test('cross-context duplicate registration succeeds only when the installed descriptors match', async () => {
    const holder = globalThis as unknown as { chrome?: unknown };
    const original = holder.chrome;
    let installed: chrome.scripting.RegisteredContentScript[] = [];
    let corrupt = false;
    holder.chrome = {
        permissions: { contains: async () => true },
        scripting: {
            getRegisteredContentScripts: async () => installed,
            registerContentScripts: async (entries: chrome.scripting.RegisteredContentScript[]) => {
                installed = structuredClone(entries);
                if (corrupt) installed[0].js = ['unexpected.js'];
                throw new Error('Duplicate script ID from another context');
            },
        },
    };
    try {
        await syncPlatformContentScripts('gemini');
        assert.equal(installed.length, 2);
        installed = [];
        corrupt = true;
        await assert.rejects(syncPlatformContentScripts('gemini'), /Duplicate script ID/);
    } finally { holder.chrome = original; }
});


test('bulk authorization requests the selected origin union exactly once in the click gesture', async () => {
    const holder = globalThis as unknown as { chrome?: unknown };
    const original = holder.chrome;
    const requests: string[][] = [];
    let inGesture = true;
    let allow = true;
    holder.chrome = { permissions: { request: ({ origins }: { origins: string[] }) => {
        assert.equal(inGesture, true);
        requests.push(origins);
        return Promise.resolve(allow);
    } } };
    try {
        const result = requestPlatformsAccess(['gemini', 'claude', 'gemini']);
        inGesture = false;
        assert.equal(await result, true);
        assert.deepEqual(requests, [[...platformOrigins('gemini'), ...platformOrigins('claude')]]);
        assert.equal(await requestPlatformsAccess([]), false);
        assert.equal(requests.length, 1);
        inGesture = true; allow = false;
        assert.equal(await requestPlatformsAccess(['chatgpt']), false);
        assert.deepEqual(requests[1], platformOrigins('chatgpt'));
    } finally { holder.chrome = original; }
});

test('external image grants are optional, exact-origin, and separate from platform access', async t => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    const grants = new Set<string>();
    const requests: string[][] = [];
    let gesture = false, denied = false;
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { permissions: {
        contains: async ({ origins }: { origins: string[] }) => origins.every(origin => grants.has(origin)),
        request: ({ origins }: { origins: string[] }) => {
            assert.equal(gesture, true, 'native request starts synchronously in the click handler');
            requests.push(origins);
            if (!denied) origins.forEach(origin => grants.add(origin));
            return Promise.resolve(!denied);
        },
    } } });
    t.after(() => {
        if (descriptor) Object.defineProperty(globalThis, 'chrome', descriptor);
        else Reflect.deleteProperty(globalThis, 'chrome');
    });
    const uri = 'https://cdn.sanity.io/images/project/image.png?q=100';
    assert.equal(resourceDownloadOrigin(uri), 'https://cdn.sanity.io/*');
    assert.equal(await hasResourceAccess(uri), false);
    assert.deepEqual(requests, []);
    for (const invalid of ['http://cdn.sanity.io/image.png', 'https://cdn.sanity.io.evil.test/x',
        'https://cdn.sanity.io:8443/x', 'https://user:password@cdn.sanity.io/x', '/image.png', 'https://other.test/x']) {
        assert.equal(resourceDownloadOrigin(invalid), undefined);
        assert.equal(await requestResourceAccess(invalid), false);
    }
    assert.deepEqual(requests, []);
    gesture = true;
    const platform = requestPlatformsAccess(['chatgpt']);
    gesture = false;
    assert.equal(await platform, true);
    assert.deepEqual(requests[0], platformOrigins('chatgpt'));
    assert.equal(await hasResourceAccess(uri), false, 'connecting ChatGPT does not grant external image access');
    gesture = true;
    const resource = requestResourceAccess(uri);
    gesture = false;
    assert.equal(await resource, true);
    assert.deepEqual(requests[1], ['https://cdn.sanity.io/*']);
    assert.equal(await hasResourceAccess(uri), true);
    grants.delete('https://cdn.sanity.io/*');
    assert.equal(await hasResourceAccess(uri), false);
    denied = true;
    gesture = true;
    const decline = requestResourceAccess(uri);
    gesture = false;
    assert.equal(await decline, false);
    assert.equal(await hasResourceAccess(uri), false);
    assert.equal(await hasPlatformAccess('chatgpt'), true, 'denial or revocation does not disconnect the platform');
});
