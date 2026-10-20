export {};
const test = require('node:test');
const assert = require('node:assert');
const { __setModuleOverride } = require('../src/core/utils/moduleOverrides.js');

// Mock browser environment for unit testing TourGuide
(global as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    open: () => {}
};

let lastCreatedOverlay: any = null;
const mockElements = new Map<string, any>();
(global as any).document = {
    createElement: (tag: string) => {
        const listeners = new Map<string, Function[]>();
        const el: any = {
            tagName: tag.toUpperCase(),
            className: '',
            style: {},
            classList: {
                add: (c: string) => { el.className += ' ' + c; },
                remove: (c: string) => { el.className = el.className.replace(c, '').trim(); }
            },
            children: [],
            appendChild: (child: any) => {
                el.children.push(child);
                return child;
            },
            removeChild: (child: any) => {
                el.children = el.children.filter((c: any) => c !== child);
            },
            setAttribute: () => {},
            addEventListener: (ev: string, fn: Function) => {
                if (!listeners.has(ev)) listeners.set(ev, []);
                listeners.get(ev)!.push(fn);
                if (el.className.includes('tour-overlay-container')) {
                    lastCreatedOverlay = el;
                }
            },
            removeEventListener: (ev: string, fn: Function) => {
                if (listeners.has(ev)) {
                    listeners.set(ev, listeners.get(ev)!.filter((f: any) => f !== fn));
                }
            },
            dispatchEvent: (event: any) => {
                const list = listeners.get(event.type) || [];
                list.forEach((f: any) => f(event));
                return true;
            },
            contains: (target: any) => el.children.includes(target),
            getBoundingClientRect: () => ({ top: 100, left: 100, width: 200, height: 50, bottom: 150, right: 300 }),
            scrollIntoView: () => {},
            isConnected: true,
            offsetParent: {},
            closest: () => null
        };
        return el;
    },
    body: {
        appendChild: () => {},
        removeChild: () => {}
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: (id: string) => mockElements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => []
};

// Mock StorageService (via the module seam; the legacy globalThis mount is gone)
let tourStatusMock = false;
__setModuleOverride('StorageService', {
    isTourCompleted: async () => tourStatusMock,
    setTourCompleted: async (v: any) => { tourStatusMock = !!v; }
});

// Mock TabService (via the module seam; the legacy globalThis mount is gone)
__setModuleOverride('TabService', {
    checkGeminiStatus: async () => ({ status: 'CONNECTED' }),
    openGeminiPage: async () => {},
    reloadGeminiTab: async () => {}
});

// Mock I18n
__setModuleOverride('I18n', {
    t: (k: any) => k
});

const TourGuide = require('../src/ui/tour/tourGuide.js');

// Polling waits: step advancement goes through a 250-300ms setTimeout inside
// the tour steps, so fixed sleeps are flaky under timer jitter. Poll instead.
async function waitForStep(expected: number, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (TourGuide.getCurrentStep() !== expected && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20));
    }
}
async function waitForInactive(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (TourGuide.isActive() && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20));
    }
}
const TabService = require('../src/core/utils/tabService.js');
const StorageService = require('../src/core/storage/storageService.js');

test('tourGuide - module structure and steps', () => {
    assert.ok(TourGuide, 'TourGuide should be exported');
    assert.strictEqual(typeof TourGuide.startTour, 'function');
    assert.strictEqual(typeof TourGuide.goToStep, 'function');
    assert.strictEqual(typeof TourGuide.nextStep, 'function');
    assert.strictEqual(typeof TourGuide.prevStep, 'function');
    assert.strictEqual(typeof TourGuide.finishTour, 'function');
    assert.strictEqual(typeof TourGuide.skipTour, 'function');

    assert.strictEqual(TourGuide.STEPS.length, 7, 'Tour should have exactly 7 streamlined steps');
    assert.strictEqual(TourGuide.STEPS[0].id, 'connect');
    assert.strictEqual(TourGuide.STEPS[1].id, 'sync');
    assert.strictEqual(TourGuide.STEPS[2].id, 'select');
    assert.strictEqual(TourGuide.STEPS[3].id, 'format');
    assert.strictEqual(TourGuide.STEPS[4].id, 'export');
    assert.strictEqual(TourGuide.STEPS[5].id, 'live_save');
    assert.strictEqual(TourGuide.STEPS[6].id, 'feedback');
    assert.ok(TourGuide.STEPS[6].isFinal, 'Last step should be marked as final');
});

test('tourGuide - step navigation and completion', async () => {
    await TourGuide.startTour(0);
    assert.strictEqual(TourGuide.isActive(), true);
    assert.strictEqual(TourGuide.getCurrentStep(), 0);

    await TourGuide.nextStep();
    assert.strictEqual(TourGuide.getCurrentStep(), 1);

    await TourGuide.nextStep();
    assert.strictEqual(TourGuide.getCurrentStep(), 2);

    await TourGuide.prevStep();
    assert.strictEqual(TourGuide.getCurrentStep(), 1);

    await TourGuide.finishTour();
    assert.strictEqual(TourGuide.isActive(), false);
    assert.strictEqual(tourStatusMock, true, 'StorageService should record tour completed');
});

test('tabService - checkGeminiStatus handles NO_TAB, NEED_REFRESH and CONNECTED', async () => {
    // 1. NO_TAB case
    (global as any).chrome = {
        tabs: {
            query: async () => []
        }
    };
    const resNoTab = await TabService.checkGeminiStatus();
    assert.strictEqual(resNoTab.status, 'NO_TAB');

    // 2. NEED_REFRESH case (sendMessage fails)
    (global as any).chrome = {
        tabs: {
            query: async () => [{ id: 101, url: 'https://gemini.google.com/app' }],
            sendMessage: (tabId: any, msg: any, cb: any) => {
                (global as any).chrome.runtime = { lastError: { message: 'Receiving end does not exist' } };
                cb(null);
            }
        },
        runtime: {}
    };
    const resRefresh = await TabService.checkGeminiStatus();
    assert.strictEqual(resRefresh.status, 'NEED_REFRESH');

    // 3. CONNECTED case
    (global as any).chrome = {
        tabs: {
            query: async () => [{ id: 102, url: 'https://gemini.google.com/app' }],
            sendMessage: (tabId: any, msg: any, cb: any) => {
                (global as any).chrome.runtime = { lastError: null };
                cb({ ok: true, version: '1.4.1' });
            }
        },
        runtime: {}
    };
    const resConnected = await TabService.checkGeminiStatus();
    assert.strictEqual(resConnected.status, 'CONNECTED');
});

test('storageService - isTourCompleted and setTourCompleted', async () => {
    let storageMap: Record<string, any> = {};
    (global as any).chrome = {
        storage: {
            local: {
                get: async (keys: any) => {
                    const res: Record<string, any> = {};
                    for (const k of keys) res[k] = storageMap[k];
                    return res;
                },
                set: async (obj: any) => {
                    Object.assign(storageMap, obj);
                }
            }
        }
    };

    assert.strictEqual(await StorageService.isTourCompleted(), false);
    await StorageService.setTourCompleted(true);
    assert.strictEqual(await StorageService.isTourCompleted(), true);
});

test('storageService - isTakeoutPromptCompleted and setTakeoutPromptCompleted', async () => {
    let storageMap: Record<string, any> = {};
    (global as any).chrome = {
        storage: {
            local: {
                get: async (keys: any) => {
                    const res: Record<string, any> = {};
                    for (const k of keys) res[k] = storageMap[k];
                    return res;
                },
                set: async (obj: any) => {
                    Object.assign(storageMap, obj);
                }
            }
        }
    };

    assert.strictEqual(await StorageService.isTakeoutPromptCompleted(), false);
    await StorageService.setTakeoutPromptCompleted(true);
    assert.strictEqual(await StorageService.isTakeoutPromptCompleted(), true);
});

function createMockElement(id: string) {
    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    return {
        id,
        listeners,
        addEventListener: (ev: string, fn: any) => {
            if (!listeners[ev]) listeners[ev] = [];
            listeners[ev].push(fn);
        },
        removeEventListener: (ev: string, fn: any) => {
            if (!listeners[ev]) return;
            listeners[ev] = listeners[ev].filter(f => f !== fn);
        },
        click: () => {
            (listeners['click'] || []).forEach(f => f({ type: 'click' }));
        },
        dispatchEvent: (e: any) => {
            (listeners[e.type] || []).forEach(f => f(e));
        },
        getBoundingClientRect: () => ({ top: 100, left: 100, width: 200, height: 50, bottom: 150, right: 300 }),
        scrollIntoView: () => {},
        isConnected: true,
        offsetParent: {},
        closest: () => null
    };
}

test('tourGuide - action-triggered step advancement across all steps', async () => {
    const mockScanBtn = createMockElement('btnIncrementalScan');
    const mockList = createMockElement('list');
    const mockFormat = createMockElement('format');
    mockElements.set('format', mockFormat);
    const mockExportBtn = createMockElement('btnExport');
    const mockLiveSaveToggle = createMockElement('liveSaveDiskToggle');
    const mockFeedbackBtn = createMockElement('btnFeedback');

    mockElements.set('btnIncrementalScan', mockScanBtn);
    mockElements.set('list', mockList);
    mockElements.set('btnExport', mockExportBtn);
    mockElements.set('liveSaveDiskToggle', mockLiveSaveToggle);
    mockElements.set('btnFeedback', mockFeedbackBtn);
    mockElements.set('feedbackBox', mockFeedbackBtn);

    // 1. Start at step 1 (sync)
    await TourGuide.goToStep(1);
    assert.strictEqual(TourGuide.getCurrentStep(), 1);

    // Simulate user clicking #btnIncrementalScan
    mockScanBtn.click();
    await waitForStep(2);
    assert.strictEqual(TourGuide.getCurrentStep(), 2, 'Should advance to step 2 after sync click');

    // 2. In step 2 (select), simulate checking a conversation checkbox
    mockList.dispatchEvent({ type: 'change', target: { type: 'checkbox', checked: true } });
    await waitForStep(3);
    assert.strictEqual(TourGuide.getCurrentStep(), 3, 'Should advance to step 3 after list checkbox toggle');

    // Choose a format before exporting.
    mockFormat.dispatchEvent({ type: 'change' });
    await waitForStep(4);
    assert.strictEqual(TourGuide.getCurrentStep(), 4);

    mockExportBtn.click();
    await waitForStep(5);
    assert.strictEqual(TourGuide.getCurrentStep(), 5, 'Export advances to live save');
    assert.strictEqual(TourGuide.isActive(), true);

    mockLiveSaveToggle.dispatchEvent({ type: 'change' });
    await waitForStep(6);
    assert.strictEqual(TourGuide.getCurrentStep(), 6, 'Live save advances to feedback');
    assert.strictEqual(TourGuide.isActive(), true);

    mockFeedbackBtn.click();
    await waitForInactive();
    assert.strictEqual(TourGuide.isActive(), false, 'Tour should be completed and inactive after feedback click');
});

test('tourGuide - listener cleanup when navigating backwards', async () => {
    const mockScanBtn = createMockElement('btnIncrementalScan');
    const mockList = createMockElement('list');

    mockElements.set('btnIncrementalScan', mockScanBtn);
    mockElements.set('list', mockList);

    await TourGuide.goToStep(1);
    assert.strictEqual(TourGuide.getCurrentStep(), 1);

    // Move to step 2 manually
    await TourGuide.nextStep();
    assert.strictEqual(TourGuide.getCurrentStep(), 2);

    // Backtrack to step 1
    await TourGuide.prevStep();
    assert.strictEqual(TourGuide.getCurrentStep(), 1);

    // Triggering step 2 event (list change) should NOT trigger advance now.
    // Negative assertion: no poll target exists, so keep a bounded wait, but
    // longer than the 250ms internal advance delay to tolerate timer jitter.
    mockList.dispatchEvent({ type: 'change', target: { type: 'checkbox', checked: true } });
    await new Promise(r => setTimeout(r, 500));
    assert.strictEqual(TourGuide.getCurrentStep(), 1, 'Should stay at step 1 because step 2 listener was cleaned up');

    await TourGuide.finishTour();
});

test('tourGuide - clicking backdrop overlay skips tour cleanly', async () => {
    await TourGuide.startTour(0);
    assert.strictEqual(TourGuide.isActive(), true);

    assert.ok(lastCreatedOverlay, 'Overlay element should be created');
    let prevented = false;
    let stopped = false;
    lastCreatedOverlay.dispatchEvent({
        type: 'click',
        target: lastCreatedOverlay,
        preventDefault: () => { prevented = true; },
        stopPropagation: () => { stopped = true; }
    });

    await waitForInactive();
    assert.strictEqual(TourGuide.isActive(), false, 'Tour should be dismissed when backdrop is clicked');
    assert.strictEqual(prevented, true, 'Click should be prevented from penetrating to background');
    assert.strictEqual(stopped, true, 'Click propagation should be stopped');
});

