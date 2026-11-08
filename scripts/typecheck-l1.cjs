const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');
const manifest = JSON.parse(readFileSync(process.argv[2] || 'tests/l1-tier1.json', 'utf8'));
mkdirSync('temp', { recursive: true });
const directory = mkdtempSync(path.resolve('temp/module-types-'));
try {
    const config = path.join(directory, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({ extends: path.resolve('tsconfig.json'),
        include: ['src/**/*', ...manifest.suites, ...(manifest.integrationSuites || []), ...manifest.typeTests].map(file => path.resolve(file)),
        exclude: [path.resolve('node_modules'), path.resolve('dist')] }));
    const result = spawnSync(path.resolve('node_modules/.bin/tsc'), ['--noEmit', '--project', config], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
} finally { rmSync(directory, { recursive: true, force: true }); }
