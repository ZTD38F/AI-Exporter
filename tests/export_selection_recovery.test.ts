import test from 'node:test';
import assert from 'node:assert';

import { selectionAfterExport } from '../src/ui/options/modules/optionsExport.js';

test('selectionAfterExport deselects only successful exported conversations', () => {
    const remaining = selectionAfterExport(
        new Set(['c_success', 'c_failed', 'c_hidden']),
        [{ id: 'c_success' }, { id: 'c_failed' }],
        [{ id: 'c_failed', error: 'asset download failed' }]
    );

    assert.deepStrictEqual([...remaining].sort(), ['c_failed', 'c_hidden']);
});

test('selectionAfterExport normalizes prefixed ids when preserving failures', () => {
    const remaining = selectionAfterExport(
        new Set(['success', 'failed', 'untouched']),
        [{ id: 'c_success' }, { id: 'c_failed' }],
        [{ chatId: 'failed', error: 'rate limited' }]
    );

    assert.deepStrictEqual([...remaining].sort(), ['failed', 'untouched']);
});

test('selectionAfterExport clears all attempted ids after complete success without touching other selections', () => {
    const remaining = selectionAfterExport(
        new Set(['a', 'b', 'outside-filter']),
        [{ id: 'a' }, { id: 'c_b' }],
        []
    );

    assert.deepStrictEqual([...remaining].sort(), ['outside-filter']);
});
