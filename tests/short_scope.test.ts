export {};
const test = require('node:test');
const assert = require('node:assert');

const { shortId, shortScope, buildExportFileName } = require('../src/core/utils/pathUtils.js');

test('shortId - extracts 6-character short identifier', () => {
    // 1. Standard conversation ID with c_ prefix
    assert.strictEqual(shortId('c_12345678'), '345678');
    assert.strictEqual(shortId('c_abc123xyz'), '123xyz');

    // 2. Exactly 6 characters
    assert.strictEqual(shortId('abcdef'), 'abcdef');
    assert.strictEqual(shortId('c_abcdef'), 'abcdef');

    // 3. Shorter than 6 characters
    assert.strictEqual(shortId('abc'), 'abc');
    assert.strictEqual(shortId('12345'), '12345');

    // 4. Numeric input
    assert.strictEqual(shortId(123456789), '456789');

    // 5. Falsy / empty input fallback
    assert.strictEqual(shortId(null), 'chat');
    assert.strictEqual(shortId(undefined), 'chat');
    assert.strictEqual(shortId(''), 'chat');
    assert.strictEqual(shortId('   '), 'chat');
});

test('shortScope - generates scoped asset prefix', () => {
    // 1. Valid IDs
    assert.strictEqual(shortScope('c_12345678'), '345678_');
    assert.strictEqual(shortScope('abcdef'), 'abcdef_');
    assert.strictEqual(shortScope('abc'), 'abc_');

    // 2. Falsy / empty IDs
    assert.strictEqual(shortScope(null), '');
    assert.strictEqual(shortScope(undefined), '');
    assert.strictEqual(shortScope(''), '');
    assert.strictEqual(shortScope('   '), '');
});

test('buildExportFileName - consistent target filename using shortId', () => {
    assert.strictEqual(buildExportFileName('My Chat', 'c_12345678', 'md'), 'My Chat_345678.md');
    assert.strictEqual(buildExportFileName('Deep Research', 'c_xyz987', 'json'), 'Deep Research_xyz987.json');
    assert.strictEqual(buildExportFileName(null, null), 'untitled_chat.md');
});

