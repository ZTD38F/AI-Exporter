export {};
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
test('strict archive resource resolver and Tier2 gate regressions', () => {
    const result = spawnSync('python3', ['-m', 'unittest', 'tests.archive_resources_test'], {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
});
