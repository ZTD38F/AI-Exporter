// The completed migration uses the same complete gate as CI.
const { spawnSync } = require('node:child_process');
for (const args of [['scripts/typecheck-v2-modules.cjs'], ['scripts/test-unit.cjs']]) {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
