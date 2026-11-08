// Scoped L3 ownership checks, supplementary to the unchanged repository-wide gate.
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const requested = process.argv.slice(2);
const names = requested.length ? requested : ['l3a', 'l3b'];
for (const name of names) {
    if (!['l3a', 'l3b'].includes(name)) throw new Error('Expected l3a or l3b');
    const file = `tests/${name}-tier1.json`;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    for (const args of [
        ['-r', './tests/ts_register.js', '--test', '--test-concurrency=4', ...manifest.suites, ...manifest.integrationSuites],
        ['scripts/typecheck-l1.cjs', file],
    ]) {
        const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
        if (result.error) throw result.error;
        if (result.status !== 0) process.exit(result.status ?? 1);
    }
}
const python = spawnSync('python3', ['-m', 'unittest', 'tests.test_l3_tier2_contracts', 'tests.test_upgrade_profile'], { stdio: 'inherit' });
if (python.error) throw python.error;
process.exit(python.status ?? 1);
