export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_ROOT = path.join(REPO_ROOT, 'scripts');
const PLAYGROUND = path.join('scripts', 'visual_agent', 'playground.py');

function getPyFiles(dir: string): string[] {
    const files: string[] = [];
    for (const item of fs.readdirSync(dir)) {
        if (item === '__pycache__') continue;
        const full = path.join(dir, item);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
            files.push(...getPyFiles(full));
        } else if (item.endsWith('.py')) {
            files.push(full);
        }
    }
    return files;
}

function nearestLessIndentedIf(lines: string[], idx: number): string | null {
    const indent = lines[idx].length - lines[idx].trimStart().length;
    for (let i = idx - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.trim()) continue;
        if (/^\s*(try|except|finally|with)\b/.test(line)) continue;
        const li = line.length - line.trimStart().length;
        if (li < indent && /^\s*if\b/.test(line)) return line;
        if (li < indent) return null;
    }
    return null;
}

test('arch: Page.bringToFront only behind explicit bring_to_front opt-in', () => {
    const callRe = /\.\s*call\(\s*["']Page\.bringToFront["']/;
    const violations: string[] = [];
    for (const file of getPyFiles(SCRIPTS_ROOT)) {
        const rel = path.relative(REPO_ROOT, file);
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line: string, idx: number) => {
            if (!callRe.test(line)) return;
            if (rel === PLAYGROUND) {
                const guard = nearestLessIndentedIf(lines, idx);
                if (!guard || !guard.includes('bring_to_front')) {
                    violations.push(`${rel}:${idx + 1} unguarded Page.bringToFront`);
                }
            } else {
                violations.push(`${rel}:${idx + 1} unconditional Page.bringToFront`);
            }
        });
    }
    assert.deepStrictEqual(violations, []);
});

test('arch: playground switch_page bring_to_front defaults to False', () => {
    const content = fs.readFileSync(path.join(REPO_ROOT, PLAYGROUND), 'utf8');
    assert.match(content, /def switch_page\([\s\S]*?bring_to_front:\s*bool\s*=\s*False/);
});
