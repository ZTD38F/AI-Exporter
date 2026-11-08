export {};
const test = require('node:test');
const assert = require('node:assert');

test('errors - active TakeoutParseError extends GeminiError', () => {
    const {
        GeminiError,
        TakeoutParseError
    } = require('../src/shared/types/errors.js');

    const rootErr = new GeminiError('Root error');
    assert.ok(rootErr instanceof Error);
    assert.ok(rootErr instanceof GeminiError);
    assert.strictEqual(rootErr.name, 'GeminiError');
    assert.strictEqual(rootErr.message, 'Root error');

    const takeoutErr = new TakeoutParseError('Structure changed', true, 'MyActivity.html');
    assert.ok(takeoutErr instanceof GeminiError);
    assert.strictEqual(takeoutErr.formatDrift, true);
    assert.strictEqual(takeoutErr.entryName, 'MyActivity.html');
});

test('errors - getErrorMessage safely normalizes all error types', () => {
    const { getErrorMessage } = require('../src/shared/utils/errorText.js');

    assert.strictEqual(getErrorMessage('Simple error string'), 'Simple error string');
    assert.strictEqual(getErrorMessage(new Error('Standard Error object')), 'Standard Error object');
    assert.strictEqual(getErrorMessage({ message: 'Custom object message' }), 'Custom object message');
    assert.strictEqual(getErrorMessage(null), 'Unknown error');
    assert.strictEqual(getErrorMessage(undefined), 'Unknown error');
    assert.strictEqual(getErrorMessage(404), '404');

});
