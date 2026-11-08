const { spawnSync } = require('node:child_process');
const result = spawnSync(require('node:path').resolve('node_modules/.bin/tsc'), ['--noEmit'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
