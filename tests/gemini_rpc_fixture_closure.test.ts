import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Gemini RPC mock responses belong to the provider fixture generators.
 * Real captured decoded payloads may still be rewrapped by geminiDualParse:
 * that is a data-adapter operation, not a synthetic RPC fixture.
 */
const root = join(__dirname);
const excluded = new Set([
    'helpers/geminiDualParse.ts',
]);
const generatorFolder = 'fixtures/providers/';

function testSources(dir: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'live' || entry.name === 'node_modules') continue;
            result.push(...testSources(file));
        } else if (entry.isFile() && file.endsWith('.ts')) {
            result.push(file);
        }
    }
    return result;
}

test('Gemini native response constructors remain inside one-key provider fixture generators', () => {
    const violations: string[] = [];
    for (const file of testSources(root)) {
        const path = relative(root, file).replaceAll('\\', '/');
        if (path.startsWith(generatorFolder) || excluded.has(path)) continue;
        const text = readFileSync(file, 'utf8');
        // This catches direct synthetic wrb.fr frames, including multiline array literals.
        // Plain "wrb.fr" expectations and protocol parsing assertions are permitted.
        const inlineFrame = /JSON\.stringify\(\s*\[\s*\[\s*['"]wrb\.fr['"]\s*,/g;
        for (const match of text.matchAll(inlineFrame)) {
            const line = text.slice(0, match.index).split('\n').length;
            violations.push(path + ':' + line + ' constructs a native batchexecute response');
        }
        // Plain malformed bodies and oversize stress responses also belong to Gen(key).
        // Unlike array-based constructors, they previously escaped the basic wrb.fr guard.
        const inlineLiteralMocks = [
            /\b(?:parseList|parseGeminiRpcConversation)\s*\(\s*['"]\[\]['"]/g,
            /\.route\(\s*['"][^'"]*batchexecute[^'"]*['"]\s*,\s*(?:async\s*)?\w+\s*=>\s*\w+\.fulfill\(\s*\{\s*body\s*:\s*['"]\[\]['"]/g,
            /new\s+Response\(\s*['"]\s*['"]\s*\)/g,
            /\btext:\s*['"]\w+['"]\.repeat\(\s*\d{6,}\s*\)/g,
        ];
        for (const pattern of inlineLiteralMocks) {
            for (const match of text.matchAll(pattern)) {
                const line = text.slice(0, match.index).split('\n').length;
                violations.push(path + ':' + line + ' constructs a literal Gemini transport reply');
            }
        }
        // The common sourceList helper is a consumer of listGen(key), not a wire builder.
        if (path === 'helpers/l1SourceFixture.ts') {
            assert.match(text, /return\s+parseList\(geminiListGen\(key\)\)/);
            assert.doesNotMatch(text, /ids\.map\(|\['wrb\.fr',\s*'MaZiqc'/);
        }
    }
    assert.deepEqual(violations, [], 'new mock responses must use the matching Gemini Gen(key) fixture');
});
