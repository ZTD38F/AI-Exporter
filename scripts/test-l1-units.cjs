/**
 * L1 runtime unit gate with frozen-v2 mocks, independently of the repository-wide
 * TypeScript gate while unrelated v2 consumers and legacy tests migrate.
 * Every listed test is executed; none is silently skipped on a failure.
 *
 * Usage:
 *   node scripts/test-l1-units.cjs              # all L1 suites
 *   node scripts/test-l1-units.cjs client parser # selected unit groups
 *   node scripts/test-l1-units.cjs integration   # real cross-module tests, not a unit gate
 */
'use strict';
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

// Only these groups are module-unit tests. Every call outside src/l1 is
// intercepted by the frozen v2 boundary mocks; no L2/Runtime/Storage executes.
const suites = {
    client: [
        'tests/l1-client-v2-mocked.test.ts',
        'tests/l1-outbound-contract.test.ts',
        'tests/provider_contract.test.ts',
        'tests/provider_degrade.test.ts',
        'tests/retry_utils.test.ts',
    ],
    sniffer: [
        'tests/l1-sniffer-v2-mocked.test.ts',
        'tests/page_observation.test.ts',
    ],
    parser: [
        'tests/l1_extracted_regressions.test.ts',
        'tests/l1-source-timestamps.test.ts',
        'tests/l1-chatgpt-source-v2-unit.test.ts',
        'tests/provider-gemini-markup-sanitization.test.ts',
        'tests/gemini_dual_parse.test.ts',
        'tests/gemini_live_parser_regressions.test.ts',
        'tests/gemini_parser.test.ts',
        'tests/gemini_structured_coverage.test.ts',
        'tests/gemini_text_math.test.ts',
        'tests/timestamp_honesty.test.ts',
    ],
    takeout: [
        'tests/l1-openai-import-v2-mocked.test.ts',
        'tests/l1-takeout-v2-mocked.test.ts',
        'tests/takeout_missing_ts.test.ts',
    ],
    resources: [
        'tests/l1-resource-admission.test.ts',
    ],
    // Historical cross-module tests remain available, but never run under the
    // L1 unit label. Execute explicitly: node scripts/test-l1-units.cjs integration.
    integration: [
        'tests/openai-import.test.ts',
        'tests/l1_contract.test.ts',
        'tests/l1-native-acquisition.test.ts',
        'tests/l1_l2_verified_deletion.test.ts',
        'tests/gemini_client_retry.test.ts',
        'tests/client_cancellation.test.ts',
        'tests/provider_adapter.test.ts',
        'tests/provider_neutral.test.ts',
        'tests/provider-native-callers.test.ts',
        'tests/provider-chatgpt-tree.test.ts',
        'tests/list-source-boundary.test.ts',
        'tests/message_bridge.test.ts',
        'tests/observed_page_ingest.test.ts',
        'tests/rpc_list_ingest.test.ts',
        'tests/sniff_watermark_isolation.test.ts',
        'tests/l1_l2_frozen_contract.test.ts',
        'tests/structured-rpc-domain.test.ts',
        'tests/index-source-boundary.test.ts',
        'tests/provider-gemini-rpc-domain.test.ts',
        'tests/gemini_prompt_literal.test.ts',
        'tests/gemini_selected_candidate.test.ts',
        'tests/gemini_structured_citations.test.ts',
        'tests/provider-gemini-takeout-domain.test.ts',
        'tests/takeout-archive-resources.test.ts',
        'tests/takeout_generated_reconciliation.test.ts',
    ],
};
const requested = process.argv.slice(2);
if (requested.some(name => !(name in suites))) {
    console.error('Usage: node scripts/test-l1-units.cjs [' + Object.keys(suites).join('|') + ' ...]');
    process.exit(2);
}
if (requested.includes('integration') && requested.length !== 1) {
    console.error('Run integration suites separately, without the L1 unit mocks');
    process.exit(2);
}
const integration = requested[0] === 'integration';
const groups = requested.length ? requested : Object.keys(suites).filter(name => name !== 'integration');
const tests = [...new Set(groups.flatMap(name => suites[name]))];
const root = path.resolve(__dirname, '..');
const register = path.join(root, 'tests/ts_register.js');
const mockPreload = path.join(root, 'tests/helpers/l1V2UnitPreload.cjs');
if (!existsSync(register)) throw new Error('Missing TypeScript test loader');
if (!integration && !existsSync(mockPreload)) throw new Error('Missing frozen-v2 port mocks');
console.log('Running ' + tests.length + ' L1 unit-test files (' + groups.join(', ') + ')');
let failed = 0;
for (const file of tests) {
    if (!existsSync(path.join(root, file))) throw new Error('Missing L1 unit test: ' + file);
    const start = Date.now();
    const run = spawnSync(process.execPath,
        ['-r', register, ...(integration ? [] : ['-r', mockPreload]), '--test', file], {
        cwd: root, encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (run.status === 0) {
        console.log('PASS ' + file + ' (' + elapsed + 's)');
    } else {
        failed++;
        console.error('FAIL ' + file + ' (' + elapsed + 's, exit=' + run.status + ')');
        if (run.error) console.error(run.error);
        console.error((run.stdout || '').slice(-16000));
        console.error((run.stderr || '').slice(-8000));
    }
}
console.log('L1 unit suites: ' + (tests.length - failed) + ' passed, ' + failed + ' failed / ' + tests.length + ' files');
if (failed) process.exitCode = 1;
