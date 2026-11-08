/** Offline inventory: every keyed provider fixture and every literal reference, including dynamic dispatch tables. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function sources(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(dir, entry.name);
        return entry.isDirectory() ? (['live', 'node_modules', 'output'].includes(entry.name) ? [] : sources(file))
            : /\.(?:tsx?|[cm]?js|py)$/.test(entry.name) ? [file] : [];
    });
}
function inventory() {
    const fixtures = new Map();
    const consumers = [];
    for (const file of sources(path.join(root, 'tests'))) {
        const relative = path.relative(root, file).replaceAll('\\', '/');
        const text = fs.readFileSync(file, 'utf8');
        const generator = relative.startsWith('tests/fixtures/providers/');
        for (const match of text.matchAll(/(['"])((?:G|C|CL|GR)_[A-Z0-9_]+)\1/g)) {
            const location = { file: relative, line: text.slice(0, match.index).split('\n').length };
            const definition = generator && /^\s*:/.test(text.slice(match.index + match[0].length));
            if (definition) {
                if (fixtures.has(match[2])) throw new Error('Duplicate fixture key ' + match[2]);
                fixtures.set(match[2], { key: match[2], generator: location, references: [] });
            } else consumers.push({ key: match[2], ...location });
        }
    }
    const unresolved = [];
    for (const { key, ...location } of consumers) {
        const fixture = fixtures.get(key);
        if (fixture) fixture.references.push(location);
        else unresolved.push({ key, ...location });
    }
    return { fixtures: [...fixtures.values()], unresolved };
}
module.exports = { inventory, sources };
if (require.main === module) {
    const result = inventory();
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else {
        const groups = new Map();
        for (const fixture of result.fixtures) {
            const file = fixture.generator.file;
            const count = groups.get(file) || { keys: 0, references: 0, unused: 0 };
            count.keys++;
            count.references += fixture.references.length;
            if (!fixture.references.length) count.unused++;
            groups.set(file, count);
        }
        console.table(Object.fromEntries(groups));
        console.log(`${result.fixtures.length} keys; ${result.unresolved.length} unresolved references`);
        for (const reference of result.unresolved) console.log(reference);
    }
}
