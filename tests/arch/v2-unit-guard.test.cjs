'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const guard = path.join(root, 'tests/helpers/v2UnitRealModuleGuard.cjs');
function compileUnderOwner(owner, source) {
    return spawnSync(process.execPath, ['-r', './tests/ts_register.js', '-e',
        'require(' + JSON.stringify(source) + ')'], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, V2_UNIT_OWNER: owner, NODE_OPTIONS: '--require=' + guard },
    });
}
test('strict v2 unit guard allows a real module owned by the suite', () => {
    const result = compileUnderOwner('l2', './src/l2/streamCoverage.js');
    assert.equal(result.status, 0, result.stderr);
});
test('strict v2 unit guard rejects a real external implementation, even if imported directly', () => {
    const result = compileUnderOwner('l3b', './src/l2/streamCoverage.js');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unit isolation violation: l3b compiled real l2 implementation/);
});
test('strict v2 unit guard does not treat Shared pure helpers as a foreign business owner', () => {
    const result = compileUnderOwner('l2', './src/shared/utils/retryUtils.js');
    assert.equal(result.status, 0, result.stderr);
});
