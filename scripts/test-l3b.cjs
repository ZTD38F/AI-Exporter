#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

// The same owner list is consumed by both the L3b-only and cross-module L3 runners.
const { suites } = require('../tests/l3b-tier1.json');
for (const args of [
    ['-r', './tests/ts_register.js', '--test', '--test-concurrency=1', ...suites],
    ['node_modules/typescript/bin/tsc', '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck',
        '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
        '--types', 'node', 'tests/ast-composer.types.ts', 'tests/helpers/l3bUnitHarness.ts'],
]) {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
