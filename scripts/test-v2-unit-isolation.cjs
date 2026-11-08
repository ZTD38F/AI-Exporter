#!/usr/bin/env node
'use strict';
/**
 * Run every independently owned v2 module-unit gate with an additional
 * execution guard: the owner may compile its own production code and Shared,
 * but other v2 module implementations must be replaced with contract mocks.
 *
 * Historic multi-owner suites are intentionally NOT units. Their original
 * files remain in integration manifests and in global regression discovery.
 * Usage: node scripts/test-v2-unit-isolation.cjs [l2 l3b ...]
 */
const { spawnSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const manifest = file => JSON.parse(readFileSync(path.join(root, file), 'utf8')).suites;
const application = ['tests/application_export.test.ts', 'tests/application_sync.test.ts',
    'tests/application_settings_cleanup.test.ts'];
const runtime = ['tests/browser_runtime_v2.test.ts', 'tests/background_modules.test.ts',
    'tests/tab_service.test.ts', 'tests/asset_fetcher_cors_fallback.test.ts',
    'tests/content_leak_fix.test.ts', 'tests/seam_s1_content_router.test.ts',
    'tests/seam_s2_background_router.test.ts'];

const suites = {
    l1: ['scripts/test-l1-units.cjs'],
    l2: ['scripts/test-l2.cjs', '--unit-only'],
    l3a: ['scripts/test-unit.cjs', ...manifest('tests/l3a-tier1.json')],
    l3b: ['scripts/test-l3b.cjs'],
    l4: ['tests/run_l4.cjs'],
    application: ['-r', './tests/ts_register.js', '--test', '--test-concurrency=1', ...application],
    runtime: ['scripts/test-unit.cjs', ...runtime],
    ui: ['scripts/test-unit.cjs', ...manifest('tests/ui-tier1.json')],
    migration: ['-r', './tests/ts_register.js', '--test', 'tests/migration-v2-mocked.test.ts'],
    shared: ['-r', './tests/ts_register.js', '--test', 'tests/retry_utils_shared.test.ts'],
};
const requested = process.argv.slice(2);
if (requested.some(owner => !(owner in suites))) {
    console.error('Usage: node scripts/test-v2-unit-isolation.cjs [' + Object.keys(suites).join(' ') + ']');
    process.exit(2);
}
const selected = requested.length ? [...new Set(requested)] : Object.keys(suites);
const guard = path.join(root, 'tests/helpers/v2UnitRealModuleGuard.cjs');
if (!existsSync(guard)) throw new Error('Missing required strict v2 unit guard');
let failed = 0;
for (const owner of selected) {
    const args = suites[owner];
    console.log('\n=== Isolated v2 ' + owner + ' units ===');
    const result = spawnSync(process.execPath, args, {
        cwd: root, stdio: 'inherit',
        env: {
            ...process.env,
            V2_UNIT_OWNER: owner,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, '--require=' + guard].filter(Boolean).join(' '),
        },
    });
    if (result.error) console.error(result.error);
    if (result.status !== 0) {
        failed++;
        console.error('FAIL ' + owner + ' (exit ' + result.status + ')');
    } else console.log('PASS ' + owner);
}
console.log('\nv2 isolated unit owners: ' + (selected.length - failed) + ' passed, ' + failed + ' failed / ' + selected.length);
if (failed) process.exitCode = 1;
