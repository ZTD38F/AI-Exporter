export {};
const test = require('node:test');
const assert = require('node:assert');

const ProgressView = require('../src/ui/views/progressView.js');

test('ProgressView - safe fallback when document is undefined or elements missing', () => {
    assert.ok(ProgressView);
    assert.strictEqual(typeof ProgressView.show, 'function');
    assert.strictEqual(typeof ProgressView.update, 'function');
    assert.strictEqual(typeof ProgressView.complete, 'function');
    assert.strictEqual(typeof ProgressView.reset, 'function');
    assert.strictEqual(typeof ProgressView.hide, 'function');

    // Safe execution without DOM
    assert.doesNotThrow(() => {
        ProgressView.show(10, 'Testing');
        ProgressView.update(50, 'Halfway');
        ProgressView.complete('Done');
        ProgressView.reset();
        ProgressView.hide();
    });
});

test('ProgressView - updates DOM styles, text content and bounds clamping', () => {
    const mockWrap = { id: 'progWrap', style: { display: 'none' } };
    const mockBar = { id: 'bar', style: { width: '0%' } };
    const mockText = { id: 'progText', textContent: '' };

    const oldDoc = (globalThis as any).document;
    try {
        (globalThis as any).document = {
            getElementById: (id: string) => {
                if (id === 'progWrap') return mockWrap;
                if (id === 'bar') return mockBar;
                if (id === 'progText') return mockText;
                return null;
            }
        };

        // 1. show
        ProgressView.show(5, 'Starting...');
        assert.strictEqual(mockWrap.style.display, 'block');
        assert.strictEqual(mockBar.style.width, '5%');
        assert.strictEqual(mockText.textContent, 'Starting...');

        // 2. update within bounds
        ProgressView.update(45, 'Processing item 45');
        assert.strictEqual(mockBar.style.width, '45%');
        assert.strictEqual(mockText.textContent, 'Processing item 45');

        // 3. update clamping (> 100)
        ProgressView.update(120);
        assert.strictEqual(mockBar.style.width, '100%');

        // 4. update clamping (< 0)
        ProgressView.update(-10);
        assert.strictEqual(mockBar.style.width, '0%');

        // 5. complete
        ProgressView.complete('All done!');
        assert.strictEqual(mockBar.style.width, '100%');
        assert.strictEqual(mockText.textContent, 'All done!');

        // 6. reset
        ProgressView.reset();
        assert.strictEqual(mockBar.style.width, '0%');
        assert.strictEqual(mockText.textContent, '');

        // 7. immediate hide
        mockWrap.style.display = 'block';
        ProgressView.hide(0);
        assert.strictEqual(mockWrap.style.display, 'none');
        assert.strictEqual(mockBar.style.width, '0%');
    } finally {
        (globalThis as any).document = oldDoc;
    }
});
