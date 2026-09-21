import test from 'node:test';
import assert from 'node:assert';

import * as Constants from '../src/core/utils/constants.js';
import * as FormatStore from '../src/core/storage/formatStore.js';


test('formatStore - ALLOWED_FORMATS and DEFAULT_FORMAT', () => {
    assert.deepStrictEqual(FormatStore.ALLOWED_FORMATS, ['markdown', 'json_openai', 'json', 'json_raw']);
    assert.strictEqual(FormatStore.DEFAULT_FORMAT, 'markdown');
});

test('formatStore - isAllowed', () => {
    assert.strictEqual(FormatStore.isAllowed('markdown'), true);
    assert.strictEqual(FormatStore.isAllowed('json_openai'), true);
    assert.strictEqual(FormatStore.isAllowed('json'), true);
    assert.strictEqual(FormatStore.isAllowed('json_raw'), true);
    assert.strictEqual(FormatStore.isAllowed('xml'), false);
    assert.strictEqual(FormatStore.isAllowed(''), false);
    assert.strictEqual(FormatStore.isAllowed(null as any), false);
});


test('formatStore - normalizeFormat with dev mode awareness', () => {
    // Normal mode: json_raw should fall back to markdown
    assert.strictEqual(FormatStore.normalizeFormat('markdown', false), 'markdown');
    assert.strictEqual(FormatStore.normalizeFormat('json_openai', false), 'json_openai');
    assert.strictEqual(FormatStore.normalizeFormat('json', false), 'json');
    assert.strictEqual(FormatStore.normalizeFormat('json_raw', false), 'markdown');
    assert.strictEqual(FormatStore.normalizeFormat('invalid', false), 'markdown');

    // Dev mode: json_raw is allowed
    assert.strictEqual(FormatStore.normalizeFormat('json_raw', true), 'json_raw');
    assert.strictEqual(FormatStore.normalizeFormat('markdown', true), 'markdown');
    assert.strictEqual(FormatStore.normalizeFormat('invalid', true), 'markdown');
});

test('formatStore - validateAgainstSelect', () => {
    const mockSelect = {
        options: [
            { value: 'markdown' },
            { value: 'json_openai' },
            { value: 'json' }
        ]
    };
    assert.strictEqual(FormatStore.validateAgainstSelect('markdown', mockSelect), true);
    assert.strictEqual(FormatStore.validateAgainstSelect('json_raw', mockSelect), false);
    assert.strictEqual(FormatStore.validateAgainstSelect('markdown', null), true);
});

test('constants - FEEDBACK_URL is configured', () => {
    assert.strictEqual(Constants.FEEDBACK_URL, 'https://tally.so/r/Y56ZBB');
});
