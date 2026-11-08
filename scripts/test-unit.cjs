const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const files = ['tests', 'tests/arch'].flatMap(dir => readdirSync(dir)
    .filter(file => /\.test\.(ts|cjs)$/.test(file)).map(file => `${dir}/${file}`)).sort();
const requested = process.argv.slice(2);
const selected = requested.length ? files.filter(file => requested.includes(file)) : files;
if (!selected.length) throw new Error('No active unit tests selected');
const result = spawnSync(process.execPath, ['-r', './tests/ts_register.js', '--test', '--test-concurrency=4', ...selected], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
