export {};
const test = require('node:test');
const assert = require('node:assert');

// Mock browser environment for unit testing TourGuide
(global as any).window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    open: () => {}
};

const mockElements = new Map<string, any>();
(global as any).document = {
    createElement: (tag: string) => {
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
            addEventListener: () => {},
            removeEventListener: () => {},
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

// Mock StorageService
let tourStatusMock = false;
(global as any).StorageService = {
    isTourCompleted: async () => tourStatusMock,
    setTourCompleted: async (v: any) => { tourStatusMock = !!v; }
};

// Mock TabService
(global as any).TabService = {
    checkGeminiStatus: async () => ({ status: 'CONNECTED' }),
    openGeminiPage: async () => {},
    reloadGeminiTab: async () => {}
};

// Mock I18n
(global as any).I18n = {
    t: (k: any) => k
};

const TourGuide = require('../src/ui/tour/tourGuide.js');
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

    assert.strictEqual(TourGuide.STEPS.length, 6, 'Tour should have exactly 6 streamlined steps');
    assert.strictEqual(TourGuide.STEPS[0].id, 'connect');
    assert.strictEqual(TourGuide.STEPS[1].id, 'sync');
    assert.strictEqual(TourGuide.STEPS[2].id, 'select');
    assert.strictEqual(TourGuide.STEPS[3].id, 'export');
    assert.strictEqual(TourGuide.STEPS[4].id, 'live_save');
    assert.strictEqual(TourGuide.STEPS[5].id, 'feedback');
    assert.ok(TourGuide.STEPS[5].isFinal, 'Last step should be marked as final');
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
    // Wait for the micro delay (300ms)
    await new Promise(r => setTimeout(r, 350));
    assert.strictEqual(TourGuide.getCurrentStep(), 2, 'Should advance to step 2 after sync click');

    // 2. In step 2 (select), simulate checking a conversation checkbox
    mockList.dispatchEvent({ type: 'change', target: { type: 'checkbox', checked: true } });
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(TourGuide.getCurrentStep(), 3, 'Should advance to step 3 after list checkbox toggle');

    // 3. In step 3 (export), simulate clicking export
    mockExportBtn.click();
    await new Promise(r => setTimeout(r, 250));
    assert.strictEqual(TourGuide.getCurrentStep(), 4, 'Should advance to step 4 (live_save) after export click');
    assert.strictEqual(TourGuide.isActive(), true);

    // 4. In step 4 (live_save), simulate toggle change
    mockLiveSaveToggle.dispatchEvent({ type: 'change' });
    await new Promise(r => setTimeout(r, 350));
    assert.strictEqual(TourGuide.getCurrentStep(), 5, 'Should advance to step 5 (feedback) after live save change');
    assert.strictEqual(TourGuide.isActive(), true);

    // 5. In step 5 (feedback), simulate clicking feedback
    mockFeedbackBtn.click();
    await new Promise(r => setTimeout(r, 250));
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

    // Triggering step 2 event (list change) should NOT trigger advance now
    mockList.dispatchEvent({ type: 'change', target: { type: 'checkbox', checked: true } });
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(TourGuide.getCurrentStep(), 1, 'Should stay at step 1 because step 2 listener was cleaned up');

    await TourGuide.finishTour();
});

