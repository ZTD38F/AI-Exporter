export {};
// tests/feature_walkthrough.test.ts - Unit tests for Two-Track Walkthrough and Feature Releases Architecture
const test = require('node:test');
const assert = require('node:assert');

// Mock browser environment
let mockStorage: Record<string, any> = {};
(global as any).chrome = {
    storage: {
        local: {
            get: async (keys: string[]) => {
                const res: Record<string, any> = {};
                for (const k of keys) {
                    if (mockStorage[k] !== undefined) res[k] = mockStorage[k];
                }
                return res;
            },
            set: async (items: Record<string, any>) => {
                Object.assign(mockStorage, items);
            }
        }
    },
    runtime: {
        getManifest: () => ({ version: '1.5.0' }),
        openOptionsPage: () => {}
    }
};

const mockElements = new Map<string, any>();
function createMockElement(id: string, tagName: string = 'div') {
    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    const el: any = {
        id,
        tagName: tagName.toUpperCase(),
        isConnected: true,
        offsetParent: {},
        style: {},
        children: [],
        classList: {
            add: () => {},
            remove: () => {},
            contains: () => false,
            toggle: () => {}
        },
        getBoundingClientRect: () => ({ left: 100, top: 100, right: 200, bottom: 150, width: 100, height: 50 }),
        scrollIntoView: () => {},
        appendChild: (child: any) => {
            el.children.push(child);
            return child;
        },
        removeChild: (child: any) => {
            el.children = el.children.filter((c: any) => c !== child);
        },
        setAttribute: () => {},
        getAttribute: () => null,
        removeAttribute: () => {},
        addEventListener: (event: string, fn: (...args: any[]) => void) => {
            listeners[event] = listeners[event] || [];
            listeners[event].push(fn);
        },
        removeEventListener: (event: string, fn: (...args: any[]) => void) => {
            if (listeners[event]) {
                listeners[event] = listeners[event].filter(cb => cb !== fn);
            }
        },
        dispatchEvent: (eventObj: any) => {
            const ev = typeof eventObj === 'string' ? { type: eventObj } : eventObj;
            if (listeners[ev.type]) {
                listeners[ev.type].forEach(cb => cb(ev));
            }
        },
        click: () => {
            if (listeners['click']) {
                listeners['click'].forEach(cb => cb({ type: 'click' }));
            }
        },
        closest: () => null,
        innerHTML: '',
        innerText: '',
        textContent: '',
        checked: false
    };
    return el;
}

(global as any).document = {
    getElementById: (id: string) => mockElements.get(id) || null,
    querySelector: (sel: string) => null,
    querySelectorAll: (sel: string) => [],
    createElement: (tag: string) => createMockElement(`dyn_${Math.random()}`, tag),
    body: {
        appendChild: () => {},
        removeChild: () => {},
        classList: { toggle: () => {}, add: () => {}, remove: () => {} }
    },
    addEventListener: () => {},
    removeEventListener: () => {}
};

(global as any).window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { search: '' }
};

(global as any).I18n = {
    t: (k: string) => k
};

const StorageService = require('../src/core/storage/storageService.js');
const { FEATURE_RELEASES, getLatestEligibleFeature } = require('../src/ui/tour/featureReleases.js');
const TourGuide = require('../src/ui/tour/tourGuide.js');

test('StorageService - isVersionGreater version comparison', () => {
    assert.strictEqual(typeof StorageService.isVersionGreater, 'function');

    // Standard cases
    assert.strictEqual(StorageService.isVersionGreater('1.5.0', '1.4.3'), true);
    assert.strictEqual(StorageService.isVersionGreater('1.4.3', '1.5.0'), false);
    assert.strictEqual(StorageService.isVersionGreater('1.5.0', '1.5.0'), false);

    // With 'v' prefix
    assert.strictEqual(StorageService.isVersionGreater('v1.5.0', '1.4.3'), true);
    assert.strictEqual(StorageService.isVersionGreater('1.5.0', 'v1.4.3'), true);

    // Major version changes
    assert.strictEqual(StorageService.isVersionGreater('2.0.0', '1.9.9'), true);
    assert.strictEqual(StorageService.isVersionGreater('1.9.9', '2.0.0'), false);

    // Patch differences
    assert.strictEqual(StorageService.isVersionGreater('1.5.1', '1.5.0'), true);
    assert.strictEqual(StorageService.isVersionGreater('1.5.0', '1.5.1'), false);
});

test('featureReleases - getLatestEligibleFeature arbitration logic', () => {
    assert.ok(Array.isArray(FEATURE_RELEASES), 'FEATURE_RELEASES should be an array');
    assert.ok(FEATURE_RELEASES.length > 0, 'FEATURE_RELEASES should have at least 1 feature');
    assert.strictEqual(FEATURE_RELEASES[0].featureId, 'live_save');
    assert.strictEqual(FEATURE_RELEASES[0].version, '1.5.0');

    // Case 1: Returning user with no recorded feature version ('') on v1.5.0 -> Eligible
    const featNew = getLatestEligibleFeature('', '1.5.0');
    assert.ok(featNew !== null, 'Empty lastSeen should be eligible for 1.5.0 spotlight');
    assert.strictEqual(featNew?.featureId, 'live_save');

    // Case 2: Returning user with older version '1.4.0' on v1.5.0 -> Eligible
    const featUpgraded = getLatestEligibleFeature('1.4.0', '1.5.0');
    assert.ok(featUpgraded !== null, '1.4.0 user should be eligible for 1.5.0');
    assert.strictEqual(featUpgraded?.featureId, 'live_save');

    // Case 3: User already visited '1.5.0' -> NOT eligible
    const featVisited = getLatestEligibleFeature('1.5.0', '1.5.0');
    assert.strictEqual(featVisited, null, '1.5.0 user should not be shown 1.5.0 again');

    // Case 4: App is version 1.4.3 (future release 1.5.0 not yet released to user) -> NOT eligible
    const featUnreleased = getLatestEligibleFeature('1.4.0', '1.4.3');
    assert.strictEqual(featUnreleased, null, 'Feature version 1.5.0 should not show if app is 1.4.3');
});

test('StorageService - last seen feature version persistence', async () => {
    mockStorage = {};
    const initialVer = await StorageService.getLastSeenFeatureVersion();
    assert.strictEqual(initialVer, '0.0.0');

    await StorageService.setLastSeenFeatureVersion('1.5.0');
    const savedVer = await StorageService.getLastSeenFeatureVersion();
    assert.strictEqual(savedVer, '1.5.0');
});

test('TourGuide - Feature Spotlight mode activation and dismissal', async () => {
    mockStorage = {};
    const mockDiskToggle = createMockElement('liveSaveDiskToggle', 'input');
    mockElements.set('liveSaveDiskToggle', mockDiskToggle);

    assert.strictEqual(typeof TourGuide.startFeatureSpotlight, 'function');
    assert.strictEqual(typeof TourGuide.dismissFeatureSpotlight, 'function');

    await TourGuide.startFeatureSpotlight('live_save', '1.5.0');
    assert.strictEqual(TourGuide.isActive(), true);

    await TourGuide.dismissFeatureSpotlight();
    assert.strictEqual(TourGuide.isActive(), false);

    // Verify storage was updated with version '1.5.0'
    const storedVer = await StorageService.getLastSeenFeatureVersion();
    assert.strictEqual(storedVer, '1.5.0');
});
