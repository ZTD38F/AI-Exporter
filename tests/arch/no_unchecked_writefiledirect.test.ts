// tests/arch/no_unchecked_writefiledirect.test.ts
// Phase G (G2) arch 断言（A1 验收项，防回退）：
// Phase A 已把全部 `const x = await writeFileDirect(...)` 改成裸 `await`（throw 语义）。
// 若有人写回 `const x = await writeFileDirect`，未 try/catch 会 unhandledrejection
// 且调用方可能误用返回值——本测试直接变红。
export {};
const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

test('arch: no const/let <id> = await writeFileDirect', () => {
    let out = '';
    try {
        out = execSync(
            `git -C "${REPO_ROOT}" grep -n -E -- "(const|let) [A-Za-z_$][A-Za-z0-9_$]* = await writeFileDirect" -- "*.ts"`,
            { encoding: 'utf8' }
        );
    } catch (e: any) {
        if (e && e.status === 1) return; // 无命中 = 通过
        throw e;
    }
    const offenders = out.trim().split('\n').filter(l => l && !l.startsWith('tests/'));
    assert.strictEqual(
        offenders.length, 0,
        `writeFileDirect 是 throw 语义，禁止用 const/let 接收其返回值（Phase A 已全改裸 await）：\n` +
        offenders.map(o => `  ${o}`).join('\n')
    );
});
