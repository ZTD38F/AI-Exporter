#!/usr/bin/env node
// UI Tier 1 only; ports to other v2 modules are mocked by the UI browser specs.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
function run(command, args) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
run(process.execPath, ['scripts/typecheck-v2-modules.cjs']);
run(process.execPath, ['-r', './tests/ts_register.js', '--test', 'tests/ui_v2.test.ts']);
if (!process.argv.includes('--types-and-unit')) run(path.resolve('node_modules/.bin/playwright'), ['test', 'tests/e2e/ui_v2.spec.ts', '--workers=1']);
