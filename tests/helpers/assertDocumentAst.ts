import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DocumentAst } from '../../src/l3b/ast/ast.js';

const root = resolve(__dirname, '../..');
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');

/** Validate fresh JSON literals against the actual production type, including excess nested fields.
 * JSON imports/casts erase excess-property checks. Compile literals instead; no parallel schema can drift.
 */
export function assertDocumentAsts(entries: Array<{ value: unknown; context: string }>): void {
    const output = join(root, 'tests/output');
    mkdirSync(output, { recursive: true });
    const temporary = mkdtempSync(join(output, 'ast-contract-'));
    const file = join(temporary, 'fixtures.ts');
    try {
        const literals = entries.map(({ value, context }, index) => {
            const json = JSON.stringify(value);
            if (json === undefined) throw new TypeError(`${context}: expected JSON document`);
            return `// ${context.replace(/[\r\n]/g, ' ')}\nconst fixture${index}: DocumentAst = ${json};`;
        });
        writeFileSync(file, `import type { DocumentAst } from '../../../src/l3b/ast/ast.js';\n${literals.join('\n')}\n`);
        const result = spawnSync(process.execPath, [compiler, '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'bundler', '--types', 'node', '--pretty', 'false', file], { cwd: root, encoding: 'utf8' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new TypeError(`DocumentAst contract failed (${entries.map(entry => entry.context).join(', ')}):\n${result.stdout}${result.stderr}`);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function assertDocumentAst(value: unknown, context = 'document'): asserts value is DocumentAst {
    assertDocumentAsts([{ value, context }]);
}
