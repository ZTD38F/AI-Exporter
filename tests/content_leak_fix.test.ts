export {};
// tests/content_leak_fix.test.ts - Verify timer cleanup on repeated injection (Issue A1 fix)
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

test('Issue A1 fix: PageObserver cleans up dangling intervals and watchers on re-initialization', () => {
    // Setup simulated browser environment
    (global as any).window = {
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => {}
    };
    (global as any).document = {
        querySelector: () => null,
        getElementById: () => null
    };
    (global as any).history = {
        pushState: () => {},
        replaceState: () => {}
    };
    (global as any).location = {
        href: 'https://gemini.google.com/app',
        pathname: '/app'
    };

    const PageObserver = require(path.join(__dirname, '../src/content/pageObserver.js'));
    assert.ok(PageObserver, 'PageObserver must be exported');
    assert.strictEqual(typeof PageObserver.init, 'function', 'PageObserver.init must be function');
    assert.strictEqual(typeof PageObserver.cleanup, 'function', 'PageObserver.cleanup must be function');

    // First init
    let syncCount = 0;
    PageObserver.init({ onSync: () => syncCount++ });

    const firstUrlWatcher = (global as any).window.__gemExporterUrlWatcher;
    const firstSyncInterval = (global as any).window.__gemExporterSyncInterval;

    // urlWatcher 1s polling removed in Phase D.3; only syncInterval should be assigned
    assert.ok(!firstUrlWatcher, '__gemExporterUrlWatcher should not be assigned after 1s polling removal');
    assert.ok(firstSyncInterval, '__gemExporterSyncInterval should be assigned');

    // Second init (simulating re-injection)
    PageObserver.init({ onSync: () => syncCount++ });

    const secondUrlWatcher = (global as any).window.__gemExporterUrlWatcher;
    const secondSyncInterval = (global as any).window.__gemExporterSyncInterval;

    assert.ok(!secondUrlWatcher, 'urlWatcher should remain unassigned after re-init');
    assert.ok(secondSyncInterval, 'New __gemExporterSyncInterval should be assigned');
    assert.notStrictEqual(secondSyncInterval, firstSyncInterval, 'Previous sync interval should have been replaced and cleared');

    // Explicit cleanup
    PageObserver.cleanup();
    assert.ok(!(global as any).window.__gemExporterUrlWatcher, 'Watcher handle should remain null after cleanup');
    assert.strictEqual((global as any).window.__gemExporterSyncInterval, null, 'Interval handle should be nulled out after cleanup');
});
