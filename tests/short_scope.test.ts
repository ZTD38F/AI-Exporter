export {};
const test = require('node:test');
const assert = require('node:assert');

const { shortId, shortScope, buildExportFileName } = require('../src/shared/utils/pathUtils.js');

test('shortId - extracts 6-character short identifier', () => {
    assert.strictEqual(shortId('c_12345678'), '345678');
    assert.strictEqual(shortId('c_abc123xyz'), '123xyz');

    assert.strictEqual(shortId('abcdef'), 'abcdef');
    assert.strictEqual(shortId('c_abcdef'), 'abcdef');

    assert.strictEqual(shortId('abc'), 'abc');
    assert.strictEqual(shortId('12345'), '12345');

    assert.strictEqual(shortId(123456789), '456789');

    assert.strictEqual(shortId(null), 'chat');
    assert.strictEqual(shortId(undefined), 'chat');
    assert.strictEqual(shortId(''), 'chat');
    assert.strictEqual(shortId('   '), 'chat');
});

test('shortScope - generates scoped asset prefix', () => {
    assert.strictEqual(shortScope('c_12345678'), '345678_');
    assert.strictEqual(shortScope('abcdef'), 'abcdef_');
    assert.strictEqual(shortScope('abc'), 'abc_');

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

