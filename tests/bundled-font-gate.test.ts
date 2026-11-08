import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundledFonts } from '../scripts/release-gate-checks/check-bundled-fonts.js';

const fonts = 'src/l4/format/pdf/sandbox/fonts';
function fixture(t: test.TestContext): string {
    const root = mkdtempSync(join(tmpdir(), 'font-release-gate-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    cpSync(fonts, join(root, fonts), { recursive: true });
    return root;
}

test('release gate accepts the exact licensed offline font fallback', t => {
    const result = checkBundledFonts(fixture(t));
    assert.deepEqual(result.failures, []);
    assert.equal(result.fontFiles.length, 5);
    assert.equal(result.totalBytes, 21749580);
});

test('release gate rejects modified bytes under an approved font name', t => {
    const root = fixture(t);
    appendFileSync(join(root, fonts, 'NotoSansCJKsc-Regular.otf'), 'modified');
    assert.match(checkBundledFonts(root).failures.join('\n'), /SHA256 mismatch:.*NotoSansCJKsc/);
});

test('release gate rejects missing required fallback and renamed font files', t => {
    const root = fixture(t);
    renameSync(join(root, fonts, 'NotoSansCJKsc-Regular.otf'), join(root, fonts, 'renamed.otf'));
    const failures = checkBundledFonts(root).failures.join('\n');
    assert.match(failures, /Unapproved font:.*renamed.otf/);
    assert.match(failures, /Missing approved asset:.*NotoSansCJKsc/);
});

test('release gate rejects missing or modified license texts', t => {
    const root = fixture(t);
    rmSync(join(root, fonts, 'OFL-NotoSansCJK.txt'));
    appendFileSync(join(root, fonts, 'OFL-NotoSansMono.txt'), 'modified');
    const failures = checkBundledFonts(root).failures.join('\n');
    assert.match(failures, /Missing approved asset:.*OFL-NotoSansCJK/);
    assert.match(failures, /SHA256 mismatch:.*OFL-NotoSansMono/);
});

test('release gate rejects a small unexpected font in generated assets', t => {
    const root = fixture(t);
    mkdirSync(join(root, 'dist', 'extra'), { recursive: true });
    writeFileSync(join(root, 'dist', 'extra', 'unknown.woff2'), 'font');
    assert.match(checkBundledFonts(root).failures.join('\n'), /Unapproved font: dist\/extra\/unknown.woff2/);
});

test('release gate keeps a total font byte budget independent of names', t => {
    const root = fixture(t);
    writeFileSync(join(root, fonts, 'large.ttf'), Buffer.alloc(2 * 1024 * 1024));
    assert.match(checkBundledFonts(root).failures.join('\n'), /Font budget exceeded/);
});

test('release gate rejects embedded font data in nested JavaScript bundles', t => {
    const root = fixture(t);
    mkdirSync(join(root, 'dist', 'nested'), { recursive: true });
    writeFileSync(join(root, 'dist', 'nested', 'font.js'), 'const font = "data:font/otf;base64,AAAA";');
    assert.match(checkBundledFonts(root).failures.join('\n'), /Embedded data:font\/ URI/);
});

test('release gate rejects symlinked fallback assets', t => {
    const root = fixture(t);
    const target = join(root, fonts, 'NotoSansCJKsc-Regular.otf');
    rmSync(target);
    symlinkSync(join(process.cwd(), fonts, 'NotoSansCJKsc-Regular.otf'), target);
    assert.match(checkBundledFonts(root).failures.join('\n'), /Symlink in shipped assets/);
});

test('local full test and CI both execute the same release font gate', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const workflow = readFileSync('.github/workflows/test.yml', 'utf8');
    assert.ok(pkg.scripts.test.includes('node build.js && npm run test:release-fonts && playwright test'));
    assert.equal(pkg.scripts['test:release-fonts'], 'node scripts/release-gate-checks/check-bundled-fonts.js');
    assert.ok(workflow.includes('run: npm run test:release-fonts'));
    assert.ok(!workflow.includes('check-no-cjk-fonts'));
});
