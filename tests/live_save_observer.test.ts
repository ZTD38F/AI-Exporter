export {};
const test = require('node:test');
const assert = require('node:assert');
const LiveSaveObserver = require('../src/content/liveSaveObserver.js');

test('liveSaveObserver - DOM inspection of generating state', () => {
    // 1. Clean DOM environment
    const origDoc = (global as any).document;
    const elementsMap = new Map<string, any>();

    (global as any).document = {
        querySelector: (sel: string) => {
            return elementsMap.get(sel) || null;
        },
        body: {
            nodeType: 1
        }
    };

    try {
        // Initially not generating
        assert.strictEqual(LiveSaveObserver.checkIsGeneratingDOM(), false);

        // Add a visible stop button
        elementsMap.set('button[aria-label*="Stop"]', {
            offsetParent: {} // visible
        });
        assert.strictEqual(LiveSaveObserver.checkIsGeneratingDOM(), true);

        // Remove stop button, add streaming class
        elementsMap.clear();
        elementsMap.set('.streaming', {
            offsetParent: {}
        });
        assert.strictEqual(LiveSaveObserver.checkIsGeneratingDOM(), true);

        // Clean all
        elementsMap.clear();
        assert.strictEqual(LiveSaveObserver.checkIsGeneratingDOM(), false);
    } finally {
        (global as any).document = origDoc;
    }
});

test('liveSaveObserver - URL active ID extraction', () => {
    const origLoc = (global as any).location;
    (global as any).location = {
        pathname: '/app/82a15f0bc2e'
    };

    try {
        const id = LiveSaveObserver.getActiveConversationId();
        assert.strictEqual(id, '82a15f0bc2e');

        (global as any).location.pathname = '/u/1/app/999abcdef';
        const id2 = LiveSaveObserver.getActiveConversationId();
        assert.strictEqual(id2, '999abcdef');

        (global as any).location.pathname = '/app';
        const id3 = LiveSaveObserver.getActiveConversationId();
        assert.strictEqual(id3, null);
    } finally {
        (global as any).location = origLoc;
    }
});

test('liveSaveObserver - Lifecycle and debounced save trigger', async () => {
    const origWin = (global as any).window;
    const origDoc = (global as any).document;

    const eventListeners: Record<string, Function[]> = {};

    (global as any).window = {
        addEventListener: (event: string, fn: Function) => {
            if (!eventListeners[event]) eventListeners[event] = [];
            eventListeners[event].push(fn);
        },
        removeEventListener: (event: string, fn: Function) => {
            if (eventListeners[event]) {
                eventListeners[event] = eventListeners[event].filter(f => f !== fn);
            }
        }
    };

    (global as any).document = {
        body: { nodeType: 1 },
        querySelector: () => null
    };

    (global as any).MutationObserver = class {
        observe() {}
        disconnect() {}
    };

    let savedId: string | null = null;
    let savedReason: string | null = null;

    try {
        LiveSaveObserver.init({
            debounceMs: 50,
            getActiveId: () => 'test_chat_conv_1',
            onTurnComplete: (cid: string, reason: string) => {
                savedId = cid;
                savedReason = reason;
            }
        });

        assert.strictEqual(LiveSaveObserver.isObserverActive(), true);

        // Manual flush trigger
        LiveSaveObserver.flushCurrentTurnNow();
        assert.strictEqual(savedId, 'test_chat_conv_1');
        assert.strictEqual(savedReason, 'turn_complete');

        // Test cleanup
        LiveSaveObserver.cleanup();
        assert.strictEqual(LiveSaveObserver.isObserverActive(), false);
    } finally {
        (global as any).window = origWin;
        (global as any).document = origDoc;
        delete (global as any).MutationObserver;
    }
});

test('liveSaveObserver - RPC stream lifecycle triggers fast save without debounce lag', async () => {
    const origWin = (global as any).window;
    const origDoc = (global as any).document;

    (global as any).window = {
        addEventListener: () => {},
        removeEventListener: () => {}
    };
    (global as any).document = {
        body: { nodeType: 1 },
        querySelector: () => null
    };
    (global as any).MutationObserver = class {
        observe() {}
        disconnect() {}
    };

    let savedId: string | null = null;
    let savedReason: string | null = null;

    try {
        LiveSaveObserver.init({
            debounceMs: 500, // even with high debounce, RPC stream complete should be near-instant
            getActiveId: () => 'default_active_id',
            onTurnComplete: (cid: string, reason: string) => {
                savedId = cid;
                savedReason = reason;
            }
        });

        // 1. Notify stream start for a new conversation
        LiveSaveObserver.notifyStreamStart('c_stream_123');

        // 2. Notify stream complete
        LiveSaveObserver.notifyStreamComplete('c_stream_123');

        // Wait 65ms (well below debounceMs of 500ms)
        await new Promise(r => setTimeout(r, 65));

        assert.strictEqual(savedId, 'c_stream_123');
        assert.strictEqual(savedReason, 'turn_complete');

        LiveSaveObserver.cleanup();
    } finally {
        (global as any).window = origWin;
        (global as any).document = origDoc;
        delete (global as any).MutationObserver;
    }
});

