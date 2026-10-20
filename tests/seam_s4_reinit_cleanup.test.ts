// tests/seam_s4_reinit_cleanup.test.ts - S4 / P1-026: re-injection cleanup
//
// A content-script bundle can be re-executed in the same isolated world
// (extension update / re-injection). Every init() below must leave exactly
// one active listener after a simulated re-injection — never a duplicate
// that would double-process messages, and never a stale closure from the
// previous bundle.
import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';

// --- minimal browser doubles -------------------------------------------------

function makeWindow() {
    const listeners: Record<string, Array<(...a: any[]) => void>> = {};
    const w: any = {
        __gemExporterCleanups: [],
        addEventListener: (type: string, fn: (...a: any[]) => void) => {
            (listeners[type] = listeners[type] || []).push(fn);
        },
        removeEventListener: (type: string, fn: (...a: any[]) => void) => {
            listeners[type] = (listeners[type] || []).filter(f => f !== fn);
        },
        dispatchEvent: (type: string, ...a: any[]) => {
            for (const f of (listeners[type] || []).slice()) f(...a);
        },
        __listenerCount: (type: string) => (listeners[type] || []).length,
    };
    return w;
}

function makeChrome() {
    const onMessage: Array<(...a: any[]) => void> = [];
    const onChanged: Array<(...a: any[]) => void> = [];
    const chrome: any = {
        runtime: {
            onMessage: {
                addListener: (fn: (...a: any[]) => void) => { onMessage.push(fn); },
                removeListener: (fn: (...a: any[]) => void) => {
                    const i = onMessage.indexOf(fn);
                    if (i >= 0) onMessage.splice(i, 1);
                },
            },
            getManifest: () => ({ version: '9.9.9-test' }),
            sendMessage: (..._a: any[]) => {},
        },
        storage: {
            onChanged: {
                addListener: (fn: (...a: any[]) => void) => { onChanged.push(fn); },
                removeListener: (fn: (...a: any[]) => void) => {
                    const i = onChanged.indexOf(fn);
                    if (i >= 0) onChanged.splice(i, 1);
                },
            },
            local: { get: (_k: any, cb: any) => cb({}), set: (_o: any, cb?: any) => cb && cb() },
        },
        __onMessage: onMessage,
        __onChanged: onChanged,
    };
    return chrome;
}

const g = globalThis as any;

// --- 1. registry semantics ---------------------------------------------------

test('cleanupRegistry: runs each cleanup once, survives a throwing cleanup', () => {
    g.window = makeWindow();
    g.chrome = makeChrome();
    const { registerCleanup, runCleanups, pendingCleanupCount } =
        require('../src/content/cleanupRegistry.ts');
    const calls: string[] = [];
    registerCleanup(() => { calls.push('a'); });
    registerCleanup(() => { calls.push('b'); throw new Error('boom'); });
    registerCleanup(() => { calls.push('c'); });
    assert.strictEqual(pendingCleanupCount(), 3);
    runCleanups(); // must not throw
    assert.deepStrictEqual(calls, ['a', 'b', 'c']);
    assert.strictEqual(pendingCleanupCount(), 0);
    runCleanups();
    assert.deepStrictEqual(calls, ['a', 'b', 'c'], 'second run is a no-op');
});

// --- 2. messageRouter: no duplicate onMessage listener -----------------------

test('messageRouter: re-injection leaves exactly one onMessage listener', () => {
    g.window = makeWindow();
    g.chrome = makeChrome();
    const { MessageRouter } = require('../src/content/messageRouter.ts');
    const { runCleanups } = require('../src/content/cleanupRegistry.ts');

    MessageRouter.init({});
    assert.strictEqual(g.chrome.__onMessage.length, 1);

    // Simulate bundle re-injection: previous bundle's cleanups run first.
    runCleanups();
    assert.strictEqual(g.chrome.__onMessage.length, 0, 'old listener removed');

    MessageRouter.init({});
    assert.strictEqual(g.chrome.__onMessage.length, 1, 'exactly one listener after re-init');

    // The surviving listener still answers.
    let resp: any;
    g.chrome.__onMessage[0]({ action: 'ping' }, {}, (r: any) => { resp = r; });
    assert.strictEqual(resp && resp.ok, true);
});

// --- 3. messageBridge: no duplicate window message listener ------------------

test('messageBridge: re-injection leaves exactly one window message listener', () => {
    g.window = makeWindow();
    g.chrome = makeChrome();
    const { init } = require('../src/content/messageBridge.ts');
    const { runCleanups } = require('../src/content/cleanupRegistry.ts');

    init({});
    assert.strictEqual(g.window.__listenerCount('message'), 1);

    // Re-injection WITHOUT cleanup: window flag must prevent a duplicate.
    init({});
    assert.strictEqual(g.window.__listenerCount('message'), 1, 'no duplicate without cleanup');

    // With cleanup: old listener removed, fresh one registered.
    runCleanups();
    assert.strictEqual(g.window.__listenerCount('message'), 0, 'old listener removed');
    init({});
    assert.strictEqual(g.window.__listenerCount('message'), 1, 'exactly one after re-init');
});

// --- 4. pageObserver: stale route closure replaced, no duplicates ------------

test('pageObserver: hookHistoryEvents replaces stale closure, cleanup removes listeners', () => {
    g.window = makeWindow();
    g.history = { pushState: () => {}, replaceState: () => {} };
    g.location = { href: 'https://gemini.google.com/app/aaa' };
    g.chrome = makeChrome();
    const mod = require('../src/content/pageObserver.ts');
    const { runCleanups } = require('../src/content/cleanupRegistry.ts');

    const seen: string[] = [];
    mod.hookHistoryEvents(() => { seen.push('old'); });
    assert.strictEqual(g.window.__listenerCount('popstate'), 1);
    assert.strictEqual(g.window.__listenerCount('gemini:locationchange'), 1);

    // Second call (new bundle): no duplicates, callback refreshed.
    mod.hookHistoryEvents(() => { seen.push('new'); });
    assert.strictEqual(g.window.__listenerCount('popstate'), 1, 'no duplicate popstate listener');
    g.location.href = 'https://gemini.google.com/app/bbb'; // URL actually changed
    g.window.dispatchEvent('popstate');
    assert.deepStrictEqual(seen, ['new'], 'stale closure replaced by new bundle callback');

    // Registry cleanup drops the listeners.
    runCleanups();
    assert.strictEqual(g.window.__listenerCount('popstate'), 0);
    assert.strictEqual(g.window.__listenerCount('gemini:locationchange'), 0);

    // Explicit cleanup() is idempotent and safe.
    mod.cleanup();
    assert.strictEqual(g.window.__listenerCount('popstate'), 0);
});

// --- 5. content.ts wiring (static: re-init runs cleanups first) ---------------

test('content.ts: re-injection path runs runCleanups() before re-registering', () => {
    const src = fs.readFileSync('src/content/content.ts', 'utf8');
    const m = src.match(/if \(w\.__gemExporterInjected\) \{([\s\S]*?)\n    \}\n    w\.__gemExporterInjected = true;/);
    assert.ok(m, 're-init branch found');
    const branch = m[1];
    assert.ok(branch.includes('runCleanups()'), 'runCleanups() called in re-init branch');
    assert.ok(
        branch.indexOf('runCleanups()') < branch.indexOf('PageObserver.cleanup'),
        'runCleanups() runs before the explicit observer cleanups'
    );
    assert.ok(
        src.includes('chrome.storage.onChanged.removeListener(onStorageChanged)'),
        'storage.onChanged listener registered for cleanup'
    );
});
