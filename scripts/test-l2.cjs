#!/usr/bin/env node
// Explicit ownership list: do not use the repository-wide impact closure here.
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const manifest = JSON.parse(readFileSync('tests/l2-tier1.json', 'utf8'));
const unitOnly = process.argv.includes('--unit-only');
{
    const args = unitOnly ? manifest.suites : [...manifest.suites, ...(manifest.integrationSuites || [])];
    const run = spawnSync(process.execPath, ['-r', './tests/ts_register.js', '--test', '--test-concurrency=1', ...args], { stdio: 'inherit' });
    if (run.status !== 0) process.exit(run.status ?? 1);
}
if (unitOnly) process.exit(0); // L2 unit tests are independently runnable while other modules migrate.
const check = spawnSync(process.execPath, ['scripts/typecheck-l1.cjs', 'tests/l2-tier1.json'], { stdio: 'inherit' });
process.exit(check.status ?? 1);
