// tests/arch/no_bare_storage_writes.test.ts
// Chrome writes belong to named Settings, transport-cooldown and Migration IO owners.
export {};
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Explicit IO owners: Settings, account transport deadlines and Migration markers.
const ALLOWED_STORAGE_FILES = new Set<string>([
    'src/l3a/settingsStore.ts',
    'src/l3a/sourceCooldownStore.ts',
    'src/migration/upgradeV1.ts',
    'src/migration/releasedV17.ts',
    'src/migration/sourceVersions.ts',
]);

function sourceHits(pattern: string, root: string = REPO_ROOT): Array<{ file: string; line: number; text: string }> {
    // Include newly created source files before staging/committing: git grep omits them.
    const out: string = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others',
        '--exclude-standard', '--', '*.ts'], { encoding: 'utf8' });
    const files = [...new Set(out.trim().split('\n').filter(file => file.startsWith('src/')))];
    return files.flatMap(file => (fs.readFileSync(path.join(root, file), 'utf8') as string)
        .split('\n').flatMap((text, index) => text.includes(pattern) ? [{ file, line: index + 1, text }] : []));
}

function isRealCodeCall(text: string, pattern: string): boolean {
    const code = text.replace(/\/\/.*$/, '');
    return code.includes(pattern);
}

test('arch: Chrome writes stay within the named IO owners', () => {
    const hits = sourceHits('chrome.storage.local.set(')
        .filter(h => isRealCodeCall(h.text, 'chrome.storage.local.set('));
    const unauthorized = hits.filter(h => !ALLOWED_STORAGE_FILES.has(h.file));
    assert.strictEqual(unauthorized.length, 0,
        'Unowned Chrome storage write:\n' + unauthorized.map(h => `  ${h.file}:${h.line}: ${h.text.trim()}`).join('\n'));
    const migration = require('node:fs').readFileSync(path.join(REPO_ROOT, 'src/migration/upgradeV1.ts'), 'utf8');
    assert.deepStrictEqual([...migration.matchAll(/chrome\.storage\.local\.set\(([^;]+)\);/g)].map(match => match[1]), ['{ [INITIALIZED]: true }']);
    const released = require('node:fs').readFileSync(path.join(REPO_ROOT, 'src/migration/releasedV17.ts'), 'utf8');
    assert.deepStrictEqual([...released.matchAll(/chrome\.storage\.local\.set\(([^;]+)\);/g)].map(match => match[1]), ['{ gemini_exporter_v17_migrated: true }']);
    const sourceVersions = fs.readFileSync(path.join(REPO_ROOT, 'src/migration/sourceVersions.ts'), 'utf8');
    assert.match(sourceVersions, /const MARKER = 'gemini_exporter_source_versions_v1';/);
    assert.deepStrictEqual([...sourceVersions.matchAll(/chrome\.storage\.local\.set\(([^;]+)\);/g)].map(match => match[1]), ['{ [MARKER]: true }']);
});

test('arch: untracked source writes are inspected before a commit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-storage-arch-'));
    try {
        execFileSync('git', ['init', '--quiet', root]);
        fs.mkdirSync(path.join(root, 'src'));
        fs.writeFileSync(path.join(root, 'src/unowned.ts'), 'chrome.storage.local.set({ unowned: true });\n');
        const unauthorized = sourceHits('chrome.storage.local.set(', root)
            .filter(hit => !ALLOWED_STORAGE_FILES.has(hit.file));
        assert.strictEqual(unauthorized.length, 1);
        assert.strictEqual(unauthorized[0].file, 'src/unowned.ts');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
