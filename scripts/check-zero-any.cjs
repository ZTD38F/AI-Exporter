const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const scopedFiles = require('./zero-any-files.json');
for (const file of scopedFiles) fs.accessSync(path.join(root, file));

// All owned post-L1 modules are zero-any by contract, including newly added files.
// Third-party generated declarations under vendor/ are excluded.
function ownedTypeScriptFiles(relativeDir) {
    return fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true }).flatMap(entry => {
        const relative = path.posix.join(relativeDir, entry.name);
        if (entry.isDirectory()) return entry.name === 'vendor' ? [] : ownedTypeScriptFiles(relative);
        return entry.isFile() && /\.tsx?$/.test(entry.name) ? [relative] : [];
    });
}
const downstream = ['src/l2', 'src/l3a', 'src/l3b', 'src/application', 'src/l4']
    .flatMap(ownedTypeScriptFiles);
const files = [...new Set([...scopedFiles, ...downstream])].sort();
const cli = path.join(path.dirname(require.resolve('oxlint/package.json')), 'bin', 'oxlint');
const result = spawnSync(process.execPath, [cli, '-A', 'all', '-D', 'typescript/no-explicit-any', '--no-ignore', '--disable-nested-config', ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
require('./check-domain-trust-lint.cjs');
