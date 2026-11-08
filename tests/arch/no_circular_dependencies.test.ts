// tests/arch/no_circular_dependencies.test.ts
// Architectural gate: Enforce 0 circular dependencies across all modules in src/.
// Ensures clean DAG architecture and prevents TDZ (Temporal Dead Zone) bundle failures.
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

/** Use the same import scan for the repository graph and the scanner regression. */
function importSpecifiers(content: string): string[] {
    const clean = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const pattern = /(?:(?:import|export)\s+(?!type\s)(?:(?!from\b)[\s\S])+?\s+from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    const found: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(clean)) !== null) found.push(match[1] || match[2] || match[3]);
    return found;
}


function getTsFiles(dir: string): string[] {
    const files: string[] = [];
    for (const item of fs.readdirSync(dir)) {
        const full = path.join(dir, item);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
            files.push(...getTsFiles(full));
        } else if (/\.tsx?$/.test(item) && !item.endsWith('.d.ts')) {
            files.push(full);
        }
    }
    return files;
}

test('arch: zero circular dependencies across all modules in src/', () => {
    const files = getTsFiles(SRC_ROOT);
    const graph = new Map<string, string[]>();

    for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        const imports: string[] = [];
        for (const spec of importSpecifiers(content)) {
            if (!spec.startsWith('.')) continue;
            let resolved = path.resolve(path.dirname(file), spec);
            if (resolved.endsWith('.js')) resolved = resolved.slice(0, -3) + '.ts';
            if (!fs.existsSync(resolved) && resolved.endsWith('.ts') && fs.existsSync(resolved + 'x')) resolved += 'x';
            if (!fs.existsSync(resolved) && fs.existsSync(resolved + '.ts')) resolved += '.ts';
            if (!fs.existsSync(resolved) && fs.existsSync(resolved + '.tsx')) resolved += '.tsx';
            if (!fs.existsSync(resolved) && fs.existsSync(path.join(resolved, 'index.ts'))) resolved = path.join(resolved, 'index.ts');
            if (fs.existsSync(resolved) && !imports.includes(resolved)) imports.push(resolved);
        }
        graph.set(file, imports);
    }

    const visited = new Set<string>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const cycles: string[][] = [];

    function dfs(u: string) {
        visited.add(u);
        stack.push(u);
        onStack.add(u);

        for (const v of graph.get(u) || []) {
            if (!visited.has(v)) {
                dfs(v);
            } else if (onStack.has(v)) {
                const cycle = stack.slice(stack.indexOf(v));
                cycle.push(v);
                cycles.push(cycle.map(p => path.relative(SRC_ROOT, p)));
            }
        }

        stack.pop();
        onStack.delete(u);
    }

    for (const f of graph.keys()) {
        if (!visited.has(f)) dfs(f);
    }

    assert.strictEqual(
        cycles.length,
        0,
        `Detected circular dependencies in src/:\n` +
        cycles.map(c => '  ' + c.join(' -> ')).join('\n')
    );
});

test('arch: import parser correctly extracts multiline imports, exports and dynamic imports', () => {
    const sample = `
        import {
            A,
            B
        } from './multi_import';
        import type {
            OnlyType
        } from './should_ignore_type';
        export {
            C,
            D
        } from './multi_export';
        export type { IgnoredExport } from './ignore_export_type';
        // import Fake from './commented_out';
        /* export { Fake } from './block_comment'; */
        import './side_effect';
        const lazy = import('./dynamic_lazy');
    `;
    const extracted = importSpecifiers(sample);
    assert.deepStrictEqual(extracted, [
        './multi_import',
        './multi_export',
        './side_effect',
        './dynamic_lazy'
    ]);
});

