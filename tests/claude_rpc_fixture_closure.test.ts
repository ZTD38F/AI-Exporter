import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Fixed Claude source responses belong to endpoint-specific Gen(key) fixtures.
 * Parser assertions, transport statuses and request routing stay in their tests.
 */
const root = join(__dirname);

function testSources(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'live' || entry.name === 'node_modules') continue;
            files.push(...testSources(file));
        } else if (entry.isFile() && file.endsWith('.ts')) {
            files.push(file);
        }
    }
    return files;
}

test('Claude native response mocks use fixed endpoint Gen(key) samples', () => {
    const violations: string[] = [];
    const inlineMocks = [
        /\bpayload\s*(?::\s*unknown\s*)?=\s*(?:\[\s*(?:null|\{)|\{\s*error\s*:)/g,
        /parseClaudeList\(\s*(?:\[|\{\s*items\s*:)/g,
        /parseClaudeConversation\(\s*(?:detail\s*\(|\{\s*uuid\s*:)/g,
        /new\s+Response\(\s*(?:['"]data:|status\s*===\s*204\s*\?\s*null)/g,
        /return\s+\[\{\s*result\s*:\s*\[\s*\]\s*\}\]/g,
        /apiGet\s*:\s*async\s*[^=]{0,100}=>\s*(?:\{\s*return\s+)?\{\s*data\s*:/g,
    ];
    for (const file of testSources(root)) {
        const path = relative(root, file).replaceAll('\\', '/');
        if (path.startsWith('fixtures/providers/') || path === 'claude_rpc_fixture_closure.test.ts') continue;
        const source = readFileSync(file, 'utf8');
        if (!/\b(?:ClaudeProvider|parseClaudeConversation|parseClaudeList|installClaudeHook|readClaudeSource|observeClaudeAccount)\b/.test(source)) continue;
        for (const pattern of inlineMocks) {
            for (const match of source.matchAll(pattern)) {
                const line = source.slice(0, match.index).split('\n').length;
                violations.push(path + ':' + line + ' creates a native Claude response outside Gen(key)');
            }
        }
    }
    assert.deepEqual(violations, []);
});
