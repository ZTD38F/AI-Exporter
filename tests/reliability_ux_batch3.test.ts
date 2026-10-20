// tests/reliability_ux_batch3.test.ts
// Tests for Batch 3: Reliability & UX (P1-3, P1-4, P1-7, D7)
export {};
const test = require('node:test');
const assert = require('node:assert');

// =========================================================================
// P1-3: fetchChatDetail envelope settle guarantee & sync throw protection
// =========================================================================
test('P1-3: fetchChatDetail resolves promptly when tabService returns empty envelope {}', async () => {
    const { fetchChatDetail } = require('../src/core/engine/export/batchWorker.js');

    const tabServiceMock = {
        sendToGeminiTab: async () => ({}) // empty envelope: truthy, but no success/error
    };

    const promise = fetchChatDetail(
        { id: 'c_probe1', title: 'Probe 1' },
        0, 1, 'u0', false, 'markdown', null,
        { tabService: tabServiceMock }
    );

    // Must settle within 100ms and not hang indefinitely
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('fetchChatDetail hung on empty envelope')), 200)
    );

    const res = await Promise.race([promise, timeout]);
    assert.strictEqual(res.success, false);
    assert.ok(String(res.error).includes('Malformed direct response envelope'), 'must report malformed envelope');
});

test('P1-3: fetchChatDetail resolves promptly when tabService returns unexpected truthy object', async () => {
    const { fetchChatDetail } = require('../src/core/engine/export/batchWorker.js');

    const tabServiceMock = {
        sendToGeminiTab: async () => ({ randomField: 123, status: 'unknown' })
    };

    const res = await fetchChatDetail(
        { id: 'c_probe2', title: 'Probe 2' },
        0, 1, 'u0', false, 'markdown', null,
        { tabService: tabServiceMock }
    );

    assert.strictEqual(res.success, false);
    assert.ok(String(res.error).includes('Malformed direct response envelope'));
    assert.strictEqual(res.rawResponse.randomField, 123);
});

test('P1-3: fetchChatDetail catches synchronous throw from messageSender and resolves', async () => {
    const { fetchChatDetail } = require('../src/core/engine/export/batchWorker.js');

    const throwingSender = () => {
        throw new Error('Extension context invalidated synchronously');
    };

    const res = await fetchChatDetail(
        { id: 'c_probe3', title: 'Probe 3' },
        0, 1, 'u0', false, 'markdown', null,
        { tabService: null, messageSender: throwingSender }
    );

    assert.strictEqual(res.success, false);
    assert.ok(String(res.error).includes('Extension context invalidated synchronously'));
});

// =========================================================================
// P1-4: Abort/re-export race mitigation & generation epoch tracking
// =========================================================================
test('P1-4: abortManager increments slot generation epoch on abort and clear', async () => {
    const {
        getSlotEpoch,
        setSlotAborted,
        clearAllAborts
    } = require('../src/background/abortManager.js');

    clearAllAborts();
    const epoch0 = getSlotEpoch('u0');
    assert.strictEqual(epoch0, 0);

    await setSlotAborted('u0', true);
    const epoch1 = getSlotEpoch('u0');
    assert.strictEqual(epoch1, 1);

    await setSlotAborted('u0', false);
    const epoch2 = getSlotEpoch('u0');
    assert.strictEqual(epoch2, 2);

    clearAllAborts();
    assert.strictEqual(getSlotEpoch('u0'), 0);
});

test('P1-4: cancelled batch cannot resurrect even if slot is later reset to unaborted', async () => {
    const origChrome = (global as any).chrome;
    (global as any).chrome = {
        runtime: {
            sendMessage: (_msg: any) => Promise.resolve()
        },
        storage: {
            session: {
                get: async () => ({}),
                set: async () => {},
                remove: async () => {}
            }
        }
    };

    const { TabService } = require('../src/core/utils/tabService.js');
    const {
        setSlotAborted,
        clearAllAborts
    } = require('../src/background/abortManager.js');
    const { fetchBatch } = require('../src/background/batchFetcher.js');

    clearAllAborts();
    const origGet = TabService.getGeminiTab;
    const origSend = TabService.sendToGeminiTab;

    TabService.getGeminiTab = async () => ({ id: 123 });

    let sendCallCount = 0;
    // sendToGeminiTab delays to give test time to abort and un-abort
    TabService.sendToGeminiTab = async () => {
        sendCallCount++;
        await new Promise(r => setTimeout(r, 40));
        return { success: true, data: { id: 'chat', messages: [] } };
    };

    try {
        const slot = 'u0';
        let response: any = null;

        // Start batch 1 with 3 items
        const batch1 = fetchBatch(
            [{ id: 'chat1' }, { id: 'chat2' }, { id: 'chat3' }],
            'markdown',
            false,
            (r: any) => { response = r; },
            0,
            3,
            slot
        );

        // Wait 10ms for batch 1 to start item 1
        await new Promise(r => setTimeout(r, 10));

        // User cancels batch 1
        await setSlotAborted(slot, true);

        // Immediately simulate a new export clearing the abort flag
        await setSlotAborted(slot, false);

        await batch1;

        assert.ok(response, 'batch 1 must settle and return response');
        assert.strictEqual(response.aborted, true, 'batch 1 must report aborted: true');
        assert.strictEqual(response.success, false, 'batch 1 must not report success');
        // Item 1 may have been in-flight, but items 2 and 3 must NOT have run
        assert.ok(sendCallCount <= 1, `sendCallCount (${sendCallCount}) must be <= 1, remaining items did not run`);
    } finally {
        TabService.getGeminiTab = origGet;
        TabService.sendToGeminiTab = origSend;
        clearAllAborts();
        (global as any).chrome = origChrome;
    }
});

// =========================================================================
// P1-7: sessionStore error propagation
// =========================================================================
test('P1-7: sessionStore re-throws storage failures in setSession, updateSession, and clearSession', async () => {
    const origChrome = (global as any).chrome;

    const failingChrome = {
        storage: {
            local: {
                get: async () => ({}),
                set: async () => {
                    throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
                },
                remove: async () => {
                    throw new Error('Storage write failed on remove');
                }
            }
        }
    };

    (global as any).chrome = failingChrome;

    delete require.cache[require.resolve('../src/core/storage/sessionStore.js')];
    const { SessionStore } = require('../src/core/storage/sessionStore.js');

    await assert.rejects(
        async () => {
            await SessionStore.setSession({ status: 'running' });
        },
        /quota exceeded/,
        'setSession must re-throw storage write errors'
    );

    await assert.rejects(
        async () => {
            await SessionStore.updateSession({ current: 5 });
        },
        /quota exceeded/,
        'updateSession must re-throw storage write errors'
    );

    await assert.rejects(
        async () => {
            await SessionStore.clearSession();
        },
        /Storage write failed on remove/,
        'clearSession must re-throw storage removal errors'
    );

    (global as any).chrome = origChrome;
});

// =========================================================================
// D7: Tour guide connection status
// =========================================================================
test('D7: Tour guide does NOT render connected ok state on ERROR or NO_TABS_API', async () => {
    const origChrome = (global as any).chrome;
    const origWindow = (global as any).window;
    const origDocument = (global as any).document;
    const { __setModuleOverride } = require('../src/core/utils/moduleOverrides.js');

    (global as any).window = {
        innerWidth: 1200,
        innerHeight: 800,
        addEventListener: () => {},
        removeEventListener: () => {},
        open: () => {}
    };

    let lastPopover: any = null;
    const elements = new Map<string, any>();
    (global as any).document = {
        createElement: (tag: string) => {
            const el: any = {
                tagName: tag.toUpperCase(),
                className: '',
                innerHTML: '',
                style: {},
                children: [],
                parentNode: null,
                classList: {
                    add: (c: string) => { el.className += ' ' + c; },
                    remove: (c: string) => { el.className = el.className.replace(c, '').trim(); }
                },
                appendChild: (c: any) => {
                    c.parentNode = el;
                    el.children.push(c);
                    if (String(c.className).includes('tour-popover')) {
                        lastPopover = c;
                    }
                    return c;
                },
                removeChild: (c: any) => {
                    c.parentNode = null;
                    el.children = el.children.filter((x: any) => x !== c);
                },
                setAttribute: () => {},
                addEventListener: () => {},
                removeEventListener: () => {},
                contains: (t: any) => el.children.includes(t),
                getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 50, bottom: 50, right: 100 }),
                scrollIntoView: () => {},
                isConnected: true,
                offsetParent: {}
            };
            return el;
        },
        body: {
            appendChild: (c: any) => { c.parentNode = (global as any).document.body; },
            removeChild: (c: any) => { c.parentNode = null; }
        },
        getElementById: (id: string) => elements.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        removeEventListener: () => {}
    };

    __setModuleOverride('StorageService', {
        isTourCompleted: async () => false,
        setTourCompleted: async () => {}
    });

    __setModuleOverride('I18n', {
        t: (k: string) => k
    });

    delete require.cache[require.resolve('../src/ui/tour/tourGuide.js')];
    const TourGuide = require('../src/ui/tour/tourGuide.js');

    try {
        // Test 1: Status = ERROR
        __setModuleOverride('TabService', {
            checkGeminiStatus: async () => ({ status: 'ERROR', error: 'Tabs communication failed' }),
            openGeminiPage: async () => {},
            reloadGeminiTab: async () => {}
        });

        await TourGuide.startTour(0);
        assert.ok(lastPopover, 'popover element must exist');
        assert.ok(
            lastPopover.innerHTML.includes('tour-status-warn'),
            'ERROR status must render tour-status-warn'
        );
        assert.ok(
            !lastPopover.innerHTML.includes('tour-status-ok'),
            'ERROR status must NEVER render tour-status-ok'
        );

        // Test 2: Status = NO_TABS_API
        __setModuleOverride('TabService', {
            checkGeminiStatus: async () => ({ status: 'NO_TABS_API' }),
            openGeminiPage: async () => {},
            reloadGeminiTab: async () => {}
        });

        await TourGuide.goToStep(0);
        assert.ok(
            lastPopover.innerHTML.includes('tour-status-warn'),
            'NO_TABS_API status must render tour-status-warn'
        );
        assert.ok(
            !lastPopover.innerHTML.includes('tour-status-ok'),
            'NO_TABS_API status must NEVER render tour-status-ok'
        );

        // Test 3: Status = CONNECTED
        __setModuleOverride('TabService', {
            checkGeminiStatus: async () => ({ status: 'CONNECTED' }),
            openGeminiPage: async () => {},
            reloadGeminiTab: async () => {}
        });

        await TourGuide.goToStep(0);
        assert.ok(
            lastPopover.innerHTML.includes('tour-status-ok'),
            'CONNECTED status must render tour-status-ok'
        );
    } finally {
        await TourGuide.skipTour();
        (global as any).chrome = origChrome;
        (global as any).window = origWindow;
        (global as any).document = origDocument;
    }
});
