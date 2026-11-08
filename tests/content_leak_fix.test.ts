import test from 'node:test';
import assert from 'node:assert/strict';

test('Runtime SPA observer handles page-world URL changes and releases every timer/listener on re-init', () => {
    const globals = ['window', 'document', 'history', 'location', 'setInterval', 'clearInterval', 'clearTimeout'];
    const originals = new Map<string, PropertyDescriptor | undefined>(
        globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
    );
    const restore = () => {
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    };
    const listeners = new Map<string, Set<Function>>();
    const count = (type: string) => listeners.get(type)?.size ?? 0;
    const intervals = new Map<number, Function>();
    let id = 1;
    (globalThis as any).setInterval = (callback: Function, interval: number) => {
        assert.equal(interval, 1000, 'URL watch is lightweight and must not poll Index/Sync');
        const handle = id++;
        intervals.set(handle, callback);
        return handle;
    };
    (globalThis as any).clearInterval = (handle: number) => intervals.delete(handle);
    (globalThis as any).clearTimeout = (handle: number) => intervals.delete(handle);
    (globalThis as any).window = {
        addEventListener: (name: string, listener: Function) => {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name)!.add(listener);
        },
        removeEventListener: (name: string, listener: Function) => listeners.get(name)?.delete(listener),
        dispatchEvent: (event: Event) => { for (const listener of listeners.get(event.type) || []) listener(event); }
    };
    (globalThis as any).document = { querySelector: () => null };
    (globalThis as any).history = { pushState: () => {}, replaceState: () => {} };
    (globalThis as any).location = { href: 'https://gemini.google.com/app/a', pathname: '/app/a' };

    let observer: { hookHistoryEvents: (listener: () => void) => void; cleanup: () => void } | null = null;
    try {
        delete require.cache[require.resolve('../src/runtime/content/pageObserver.js')];
        observer = require('../src/runtime/content/pageObserver.js');
        const events: string[] = [];
        observer!.hookHistoryEvents(() => events.push('old'));
        assert.equal(intervals.size, 1);
        assert.equal(count('popstate'), 1);
        assert.equal(count('gemini:locationchange'), 1);
        (globalThis as any).location.href = 'https://gemini.google.com/app/b';
        const firstPulse = intervals.values().next().value;
        assert.ok(firstPulse);
        firstPulse();
        assert.deepEqual(events, ['old']);

        const first = intervals.keys().next().value;
        assert.notEqual(first, undefined);
        const pushState = (globalThis as any).history.pushState;
        observer!.hookHistoryEvents(() => events.push('new'));
        assert.equal(intervals.has(first!), false);
        assert.equal(intervals.size, 1);
        assert.strictEqual((globalThis as any).history.pushState, pushState, 'same-document history must only be wrapped once');
        assert.equal(count('popstate'), 1);
        assert.equal(count('gemini:locationchange'), 1);

        (globalThis as any).location.href = 'https://gemini.google.com/app/c';
        (globalThis as any).history.pushState({}, '', '/app/c');
        assert.deepEqual(events, ['old', 'new'], 'only latest callback runs');
        observer!.cleanup();
        assert.equal(intervals.size, 0);
        assert.equal(count('popstate'), 0);
        assert.equal(count('gemini:locationchange'), 0);
        (globalThis as any).location.href = 'https://gemini.google.com/app/d';
        (globalThis as any).window.dispatchEvent(new Event('popstate'));
        assert.deepEqual(events, ['old', 'new']);
    } finally {
        try { observer?.cleanup(); }
        finally { restore(); }
    }
});
