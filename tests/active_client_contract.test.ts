import { accountRuntime } from './helpers/accountRuntime.js';
import { startSync } from '../src/ui/options/controllers/syncController.js';
import test from 'node:test';
import assert from 'node:assert';
import type { ActiveClientContract } from '../src/runtime/content/contentContext.js';
import { ContentContext, contentContext } from '../src/runtime/content/contentContext.js';
import { runCleanups } from '../src/runtime/content/cleanupRegistry.js';
import { init as initMessageRouter } from '../src/runtime/content/messageRouter.js';

// 1. Compile-time regression:
// Prove that a valid ActiveClientContract WITHOUT abort() can be assigned
// to window.__gemExporterActiveClient and ContentContext without type error.
const clientWithoutAbort: ActiveClientContract = {};

const _compileTimeCheck = () => {
    window.__gemExporterActiveClient = clientWithoutAbort;
    window.__gemExporterActiveClient = null;
    window.__gemExporterActiveClient = undefined;
    const ctx = new ContentContext();
    ctx.setActiveClient(clientWithoutAbort);
    const retrieved: ActiveClientContract | null = ctx.getActiveClient();
    void retrieved;
};
void _compileTimeCheck;

// 2. Runtime regression: the mock Chrome listener and window must be scoped
// to each test; mutating the host globals at module import polluted other tests.
type MessageListener = (msg: any, sender: any, respond: (response: any) => void) => unknown;
type Dispatch = (msg: any) => Promise<any>;

async function withMessageRouter<T>(
    execute: (dispatch: Dispatch, mockWindow: any) => Promise<T>,
): Promise<T> {
    const g = globalThis as any;
    const originalChrome = Object.getOwnPropertyDescriptor(g, 'chrome');
    const originalWindow = Object.getOwnPropertyDescriptor(g, 'window');
    const activeClient = contentContext.getActiveClient();
    const wasAborted = contentContext.isAborted();
    const listeners = new Set<MessageListener>();
    const mockWindow = { __gemExporterCleanups: [] as Array<() => void> } as any;
    const mockChrome = {
        runtime: {
            onMessage: {
                addListener: (fn: MessageListener) => { listeners.add(fn); },
                removeListener: (fn: MessageListener) => { listeners.delete(fn); },
            },
            lastError: null,
            sendMessage: (_msg: any, _cb?: any) => {},
        },
    };
    Object.defineProperty(g, 'chrome', { value: mockChrome, writable: true, configurable: true });
    Object.defineProperty(g, 'window', { value: mockWindow, writable: true, configurable: true });

    const runtime = accountRuntime();
    try {
        contentContext.setActiveClient(null);
        contentContext.setAborted(false);
        initMessageRouter();
        assert.equal(listeners.size, 1, 'test must exercise the actual registered router');
        const dispatch: Dispatch = (msg) => new Promise((resolve, reject) => {
            const listener = [...listeners][0];
            if (!listener) return reject(new Error('No message listener registered'));
            try { if (listener(msg, {}, resolve) === false) resolve({ unhandled: true }); }
            catch (error) { reject(error); }
        });
        return await execute(dispatch, window);
    } finally {
        runCleanups();
        runtime.restore();
        contentContext.setActiveClient(activeClient);
        contentContext.setAborted(wasAborted);
        if (originalWindow) Object.defineProperty(g, 'window', originalWindow);
        else delete g.window;
        if (originalChrome) Object.defineProperty(g, 'chrome', originalChrome);
        else delete g.chrome;
    }
}

test('ActiveClient contract - ContentContext.abort behavior with and without abort()', () => {
    const ctx = new ContentContext();

    let clientAbortCalled = 0;
    const clientWithAbort: ActiveClientContract = {
        abort: () => { clientAbortCalled++; },
    };
    ctx.setActiveClient(clientWithAbort);
    ctx.abort();
    assert.strictEqual(clientAbortCalled, 1, 'client.abort() should be invoked once');
    assert.strictEqual(ctx.isAborted(), true);

    const ctx2 = new ContentContext();
    ctx2.setActiveClient(clientWithoutAbort);
    assert.doesNotThrow(() => ctx2.abort());
    assert.strictEqual(ctx2.isAborted(), true);

    const ctx3 = new ContentContext();
    ctx3.setActiveClient({ abort: () => { throw new Error('Abort failure'); } });
    assert.doesNotThrow(() => ctx3.abort(), 'ContentContext.abort() is best-effort');
    assert.strictEqual(ctx3.isAborted(), true, 'abort state must survive an exception in client.abort()');
});

test('ActiveClient contract - Scan cancellation uses invocation signals rather than retired router abort commands', async () => {
    await withMessageRouter(async dispatch => {
        for (const action of ['stopDeepScan', 'abortSync', 'deepScan']) assert.deepEqual(await dispatch({ action }), { unhandled: true });
    });
    const a = new AbortController(), b = new AbortController(); let dispatched = 0;
    const options = (signal: AbortSignal) => ({ signal, onTarget: async () => {} });
    const ports = { resolveScanTarget: async () => '10000000-0000-4000-8000-000000000001',
        scanAll: async (_request: unknown, runtime?: { signal?: AbortSignal }) => {
            dispatched++; assert.strictEqual(runtime?.signal, b.signal);
            return { status: 'complete' as const, pagesFetched: 1, conversationsFetched: 3 };
        } };
    a.abort(); await assert.rejects(startSync(undefined, options(a.signal), ports), { name: 'AbortError' });
    assert.equal((await startSync(undefined, options(b.signal), ports)).status, 'complete'); assert.equal(dispatched, 1);
});

test('scan failures, limits, cancellation and completion keep the explicit Application result or rejection', async () => {
    for (const status of ['complete', 'up_to_date', 'partial_limit', 'aborted', 'error'] as const) {
        const expected = { status, pagesFetched: 2, conversationsFetched: 3 };
        const result = await startSync(undefined, { signal: new AbortController().signal, onTarget: async () => {} }, {
            resolveScanTarget: async () => '10000000-0000-4000-8000-000000000001', scanAll: async () => expected,
        });
        assert.strictEqual(result, expected);
    }
    const error = Error('HTTP 429 rate limit');
    await assert.rejects(startSync(undefined, { signal: new AbortController().signal, onTarget: async () => {} }, {
        resolveScanTarget: async () => '10000000-0000-4000-8000-000000000001', scanAll: async () => { throw error; },
    }), actual => actual === error);
});
