// tests/arch/no_bare_storage_writes.test.ts
// Architectural gate: Prohibit direct `chrome.storage.local.set(` calls outside `src/core/storage/` boundary.
// All storage writes must be consolidated in dedicated storage modules.
export {};
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STORAGE_DIR_PREFIX = 'src/core/storage/';

// Only controlled storage modules under src/core/storage/ are allowed to call chrome.storage.local.set(
const ALLOWED_STORAGE_FILES = new Set<string>([
    'src/core/storage/storageService.ts',
    'src/core/storage/userPreferences.ts',
    'src/core/storage/sessionStore.ts',
    'src/core/storage/formatStore.ts',
    'src/core/storage/liveStorageManager.ts',
    'src/core/storage/schemaMigration.ts',
]);

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
    }).filter(h => !h.file.startsWith('tests/'));
}

function isRealCodeCall(text: string, pattern: string): boolean {
    const code = text.replace(/\/\/.*$/, '');
    return code.includes(pattern);
}

test('arch: no bare chrome.storage.local.set( outside src/core/storage/ boundary', () => {
    const hits = gitGrepFixed('chrome.storage.local.set(')
        .filter(h => isRealCodeCall(h.text, 'chrome.storage.local.set('));

    const outsideStorageDir = hits.filter(h => !h.file.startsWith(STORAGE_DIR_PREFIX));
    assert.strictEqual(
        outsideStorageDir.length, 0,
        `严禁在 ${STORAGE_DIR_PREFIX} 目录外直接调用 chrome.storage.local.set(，必须通过 StorageService 或存储模块收口：\n` +
        outsideStorageDir.map(h => `  ${h.file}:${h.line}: ${h.text.trim()}`).join('\n')
    );

    const unauthorizedStorageFiles = hits.filter(h => !ALLOWED_STORAGE_FILES.has(h.file));
    assert.strictEqual(
        unauthorizedStorageFiles.length, 0,
        `${STORAGE_DIR_PREFIX} 下出现未登记的新增直写模块，请走现有 StorageService 或显式纳入 ALLOWED_STORAGE_FILES：\n` +
        unauthorizedStorageFiles.map(h => `  ${h.file}:${h.line}: ${h.text.trim()}`).join('\n')
    );
});
