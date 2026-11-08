#!/usr/bin/env node
// Explicit ownership list: do not use the repository-wide impact closure here.
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const manifest = JSON.parse(readFileSync('tests/l1-tier1.json', 'utf8'));
{
    const args = [...manifest.suites, ...(manifest.integrationSuites || [])];
    const run = spawnSync(process.execPath, ['-r', './tests/ts_register.js', '--test', ...args], { stdio: 'inherit' });
    if (run.status !== 0) process.exit(run.status ?? 1);
}
const check = spawnSync(process.execPath, ['scripts/typecheck-l1.cjs'], { stdio: 'inherit' });
process.exit(check.status ?? 1);
