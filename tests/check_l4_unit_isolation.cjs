/**
 * Prevent L4's unit list from quietly acquiring real L1/L2/L3a/L3b/UI/Application
 * dependencies again. v2 schema-only imports are allowed; runtime imports and
 * transitive TEST helper imports must be L4, shared, builtins or third-party.
 * Does not inspect L4 production internals: an upstream port must be mocked
 * in the test at the boundary (e.g. l4-json-v2-unit.test.ts).
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const manifest = require('./l4-tests.json');
const visited = new Set();
const issues = [];
const toRelative = value => path.relative(root, value).replace(/\\/g, '/');

function resolveImport(parent, specifier) {
    if (!specifier.startsWith('.')) return;
    const absolute = path.resolve(path.dirname(parent), specifier);
    const attempts = [absolute];
    if (absolute.endsWith('.js')) attempts.push(absolute.slice(0, -3) + '.ts');
    if (!path.extname(absolute)) attempts.push(absolute + '.ts', absolute + '.js', path.join(absolute, 'index.ts'));
    const target = attempts.find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!target) {
        issues.push(toRelative(parent) + ': missing relative import ' + specifier);
        return;
    }
    const rel = toRelative(target);
    if (rel.startsWith('src/') && !rel.startsWith('src/l4/') && !rel.startsWith('src/shared/')) {
        issues.push(toRelative(parent) + ': runtime import of external module ' + rel);
        return;
    }
    if (rel.startsWith('tests/helpers/')) checkFile(target);
}

/**
 * TypeScript 7 no longer exposes the old JS Compiler API. esbuild's TS parser
 * erases genuine type-only dependencies and records all remaining static,
 * dynamic-import and require() edges in its metafile. This guards the runtime
 * module graph without treating frozen v2 type definitions as implementations.
 */
function checkFile(filename) {
    const abs = path.resolve(filename);
    if (visited.has(abs)) return;
    visited.add(abs);
    const contents = fs.readFileSync(abs, 'utf8');
    const parsed = buildSync({
        stdin: { contents, resolveDir: path.dirname(abs), sourcefile: abs, loader: 'ts' },
        bundle: false, write: false, metafile: true, platform: 'node', format: 'esm',
        logLevel: 'silent',
    });
    for (const output of Object.values(parsed.metafile.outputs)) {
        for (const imported of output.imports) resolveImport(abs, imported.path);
    }
}

const suites = manifest.suites;
if (new Set(suites).size !== suites.length) issues.push('Duplicate L4 unit suites');
for (const suite of suites) {
    if (!suite.startsWith('tests/') || !suite.endsWith('.test.ts')) {
        issues.push('Invalid L4 unit suite: ' + suite);
        continue;
    }
    const filename = path.resolve(root, suite);
    if (!fs.existsSync(filename)) { issues.push('Missing L4 unit suite: ' + suite); continue; }
    checkFile(filename);
}
if (issues.length) {
    process.stderr.write('L4 unit isolation violation:\n' + issues.map(s => '- ' + s).join('\n') + '\n');
    process.exit(1);
}
process.stdout.write('L4 unit isolation verified: ' + suites.length + ' suites; upstream v2 inputs are types/fixtures/mocks.\n');
