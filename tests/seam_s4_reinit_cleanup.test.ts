// Runtime contracts for the content-script listener/cleanup seams.
// Content-bundle re-execution itself belongs in a browser integration test;
// source-text regex matching must not be used as a substitute for that flow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCleanup, runCleanups } from '../src/runtime/content/cleanupRegistry.js';
import { MessageRouter } from '../src/runtime/content/messageRouter.js';
import { init as initMessageBridge } from '../src/l1/sniffer/gemini/messageBridge.js';
import { PageObserver } from '../src/runtime/content/pageObserver.js';

function makeWindow() {
    const listeners: Record<string, Array<(...args: any[]) => void>> = {};
    return {
        __gemExporterCleanups: [] as Array<() => void>,
        addEventListener(type: string, fn: (...args: any[]) => void) {
            (listeners[type] ||= []).push(fn);
        },
        removeEventListener(type: string, fn: (...args: any[]) => void) {
            listeners[type] = (listeners[type] || []).filter(existing => existing !== fn);
        },
        dispatchEvent(event: Event | string) {
            const type = typeof event === 'string' ? event : event.type;
            for (const fn of (listeners[type] || []).slice()) fn(event);
        },
        listenerCount(type: string) { return (listeners[type] || []).length; },
    };
}

function makeChrome() {
    const messages: Array<(...args: any[]) => void> = [];
    return {
        runtime: {
            onMessage: {
                addListener: (fn: (...args: any[]) => void) => { messages.push(fn); },
                removeListener: (fn: (...args: any[]) => void) => {
                    const index = messages.indexOf(fn);
                    if (index >= 0) messages.splice(index, 1);
                },
            },
            getManifest: () => ({ version: '9.9.9-test' }),
            sendMessage: () => {},
        },
        storage: { onChanged: { addListener: () => {}, removeListener: () => {} } },
        messages,
    };
}

function withMockHost(run: (host: { win: ReturnType<typeof makeWindow>; chrome: ReturnType<typeof makeChrome>;
    history: { pushState: (...args: any[]) => void; replaceState: (...args: any[]) => void };
    location: { href: string } }) => void): void {
    const g = globalThis as any;
    const keys = ['window', 'chrome', 'history', 'location'] as const;
    const prior = keys.map(key => Object.getOwnPropertyDescriptor(g, key));
    const win = makeWindow(), chrome = makeChrome();
    const history = { pushState: (..._args: any[]) => {}, replaceState: (..._args: any[]) => {} };
    const location = { href: 'https://gemini.google.com/app/starting' };
    try {
        for (const [i, value] of [win, chrome, history, location].entries()) {
            Object.defineProperty(g, keys[i], { value, configurable: true, writable: true });
        }
        run({ win, chrome, history, location });
    } finally {
        // Drain registered listeners while the matching mock globals are still installed.
        runCleanups();
        PageObserver.cleanup();
        keys.forEach((key, i) => {
            if (prior[i]) Object.defineProperty(g, key, prior[i]);
            else Reflect.deleteProperty(g, key);
        });
    }
}

test('cleanup registry runs callbacks once and isolates a throwing cleanup', () => {
    withMockHost(({ win }) => {
        const calls: string[] = [];
        registerCleanup(() => calls.push('first'));
        registerCleanup(() => { calls.push('throws'); throw new Error('simulated cleanup exception'); });
        registerCleanup(() => calls.push('last'));
        assert.equal(win.__gemExporterCleanups.length, 3);
        assert.doesNotThrow(() => runCleanups());
        assert.deepEqual(calls, ['first', 'throws', 'last']);
        assert.equal(win.__gemExporterCleanups.length, 0);
        runCleanups();
        assert.deepEqual(calls, ['first', 'throws', 'last'], 'no cleanup runs twice');
    });
});

test('messageRouter re-init replaces a single active Chrome listener and still answers ping', () => {
    withMockHost(({ chrome }) => {
        MessageRouter.init();
        assert.equal(chrome.messages.length, 1);
        runCleanups();
        assert.equal(chrome.messages.length, 0);
        MessageRouter.init();
        assert.equal(chrome.messages.length, 1);
        let response: any;
        chrome.messages[0]({ action: 'ping' }, {}, (result: any) => { response = result; });
        assert.equal(response?.ok, true);
    });
});

test('messageBridge re-init never duplicates its window listener', () => {
    withMockHost(({ win }) => {
        initMessageBridge({});
        assert.equal(win.listenerCount('message'), 1);
        initMessageBridge({});
        assert.equal(win.listenerCount('message'), 1, 'calling init twice without cleanup must be idempotent');
        runCleanups();
        assert.equal(win.listenerCount('message'), 0);
        initMessageBridge({});
        assert.equal(win.listenerCount('message'), 1, 'listener must be re-installed after cleanup');
    });
});

test('pageObserver routes history and popstate events only through the newest callback', () => {
    withMockHost(({ win, history, location }) => {
        const seen: string[] = [];
        PageObserver.hookHistoryEvents(() => seen.push('old'));
        assert.equal(win.listenerCount('popstate'), 1);
        assert.equal(win.listenerCount('gemini:locationchange'), 1);

        location.href = 'https://gemini.google.com/app/first';
        history.pushState({}, '', '/app/first');
        assert.deepEqual(seen, ['old'], 'pushState must actually reach the registered callback');

        PageObserver.hookHistoryEvents(() => seen.push('new'));
        assert.equal(win.listenerCount('popstate'), 1);
        assert.equal(win.listenerCount('gemini:locationchange'), 1);
        location.href = 'https://gemini.google.com/app/second';
        history.replaceState({}, '', '/app/second');
        assert.deepEqual(seen, ['old', 'new'], 'the old callback must not receive subsequent history events');

        location.href = 'https://gemini.google.com/app/third';
        win.dispatchEvent('popstate');
        assert.deepEqual(seen, ['old', 'new', 'new']);
        runCleanups();
        assert.equal(win.listenerCount('popstate'), 0);
        assert.equal(win.listenerCount('gemini:locationchange'), 0);
        location.href = 'https://gemini.google.com/app/fourth';
        win.dispatchEvent('popstate');
        assert.deepEqual(seen, ['old', 'new', 'new'], 'cleanup must stop future notifications');
        PageObserver.cleanup();
        assert.equal(win.listenerCount('popstate'), 0, 'explicit cleanup is idempotent');
    });
});
