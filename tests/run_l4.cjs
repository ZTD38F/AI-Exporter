const { spawnSync } = require('node:child_process');
const path = require('node:path');

const integration = process.argv.includes('--integration');
const manifest = require(integration ? './l4-integration-tests.json' : './l4-tests.json');
const root = path.resolve(__dirname, '..');

if (!integration) {
    const guard = spawnSync(process.execPath, ['tests/check_l4_unit_isolation.cjs'], {
        cwd: root, encoding: 'utf8',
    });
    process.stdout.write(guard.stdout ?? '');
    process.stderr.write(guard.stderr ?? '');
    if (guard.error) throw guard.error;
    if (guard.status !== 0) process.exit(guard.status ?? 1);
}

const result = spawnSync(process.execPath, [
    '-r', './tests/ts_register.js', '--test', '--test-concurrency=2', ...manifest.suites,
], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const count = /^# pass (\d+)$/m.exec(result.stdout);
if (!count) throw new Error('Missing L4 test completion summary');
process.stdout.write('L4 ' + (integration ? 'integration' : 'unit') + ': ' + count[1] + ' tests passed; no failures.\n');
