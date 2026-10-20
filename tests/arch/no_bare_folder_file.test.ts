// tests/arch/no_bare_folder_file.test.ts
// Architectural gate: Prohibit bare `folder.file(` calls outside zipWriter.
// All zip file write operations must pass through IExportWriter/ZipWriter.
export {};
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ZIP_WRITER = 'src/core/engine/writers/zipWriter.ts';

function gitGrepFixed(pattern: string): Array<{ file: string; line: number; text: string }> {
    let out = '';
    try {
        out = execSync(`git -C "${REPO_ROOT}" grep -n -F -- "${pattern}" -- "*.ts"`, { encoding: 'utf8' });
    } catch (e: any) {
        if (e && e.status === 1) return [];
        throw e;
    }
    return out.trim().split('\n').filter(Boolean).map((l: string) => {
        const m = l.match(/^([^:]+):(\d+):(.*)$/);
        return { file: m![1], line: Number(m![2]), text: m![3] };
    });
}

function isRealCodeCall(text: string, pattern: string): boolean {
    const code = text.replace(/\/\/.*$/, '');
    return code.includes(pattern);
}

test('arch: no bare folder.file( outside zipWriter', () => {
    const hits = gitGrepFixed('folder.file(')
        .filter(h => !h.file.startsWith('tests/'))
        .filter(h => isRealCodeCall(h.text, 'folder.file('));
    const offenders = hits.filter(h => h.file !== ZIP_WRITER);
    assert.strictEqual(
        offenders.length, 0,
        `裸 folder.file( 调用必须走 zipWriter 统一出口，违规：\n` +
        offenders.map(o => `  ${o.file}:${o.line}: ${o.text.trim()}`).join('\n')
    );
});
