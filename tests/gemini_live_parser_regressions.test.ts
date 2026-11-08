import type { GeminiStructuredDocument } from '../src/l1/parsers/gemini/rpc/structuredContent.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGeminiBody } from '../src/l1/parsers/gemini/shared/contentAdapter.js';
import { GM_TEX_003_BAR_ALIASES } from '../src/l1/parsers/gemini/shared/markdownCompatibility.js';
import { recoverLiteralMath } from '../src/l1/parsers/gemini/shared/literalMathRecovery.js';

test('live line-start display fence remains a block without a preceding blank line', () => {
    const raw = readFileSync('tests/fixtures/provider/math/gm_md_004_evidence.md', 'utf8').split('-->\n')[1];
    const blocks = parseGeminiBody(raw);
    assert.deepEqual(blocks.map(b => b.type), ['paragraph', 'math']);
    assert.equal(blocks[1].type === 'math' && blocks[1].source, 'A(a, \\lambda) = \\pm 1, \\quad B(b, \\lambda) = \\pm 1');
});

test('display math splits a list paragraph and retains trailing authored prose', () => {
    const blocks = parseGeminiBody('* **零向量**：当 $x = 0$ 时\n  $$H = I, \\quad \\tau = 0, \\quad v = 0$$\n  无需执行消元。');
    assert.equal(blocks[0].type, 'list');
    if (blocks[0].type !== 'list') return;
    assert.deepEqual(blocks[0].items[0].blocks.map(b => b.type), ['paragraph', 'math', 'paragraph']);
    assert.ok(JSON.stringify(blocks).includes('无需执行消元。'));
    const inline = parseGeminiBody('inline $$ x \\$ y $$ text');
    assert.deepEqual(inline.map(b => b.type), ['paragraph']);
});

test('Gemini code preserves its final physical newline, indentation and blank lines', () => {
    for (const code of ['if x:\n    run()\n', 'run()\n\n']) {
        const raw = '```python\n' + code + '```';
        const native: GeminiStructuredDocument = { children: [{ nodeType: 1, code, info: 'python' }] };
        assert.deepEqual(parseGeminiBody(raw), parseGeminiBody(raw, native));
    }
    assert.equal(parseGeminiBody('```python\nrun()')[0].type === 'code' && (parseGeminiBody('```python\nrun()')[0] as {code: string}).code, 'run()');
    assert.deepEqual(parseGeminiBody('```\n```'), [{ type: 'code', code: '' }]);
    assert.deepEqual(parseGeminiBody('> ```python\n> run()\n> ```'), [{ type: 'quote', blocks: [{ type: 'code', code: 'run()\n', language: 'python' }] }]);
});

test('evidence-backed exact bar aliases normalize only parsed math, preserving norm distinction', () => {
    const fixture = JSON.parse(readFileSync(GM_TEX_003_BAR_ALIASES.evidence, 'utf8'));
    const native: GeminiStructuredDocument = { children: [{ nodeType: 12, FTa: fixture.structured }] };
    assert.deepEqual(parseGeminiBody('$$' + fixture.markdown + '$$'), parseGeminiBody('', native));
    assert.equal(GM_TEX_003_BAR_ALIASES.transform('\\Vert{}x\\Vert{} + \\vert{}y\\vert{}'), '\\|x\\| + |y|');
    assert.equal(GM_TEX_003_BAR_ALIASES.transform('\\\\Vert{}'), '\\\\Vert{}');
    const source = '`\\Vert{}` and \\Vert{}\n\n```tex\n\\Vert{}\n```';
    assert.ok(JSON.stringify(parseGeminiBody(source)).includes('\\\\Vert{}'));
});

test('captured native emphasis corruption recovers Q-star from its raw Markdown paragraph', () => {
    const fixture = JSON.parse(readFileSync('tests/fixtures/provider/math/gm_md_005_evidence.json', 'utf8'));
    const diagnostics: import('../src/shared/diagnostics/diagnostic.js').Diagnostic[] = [];
    const content = parseGeminiBody(fixture.markdown, fixture.structured, { diagnostics, sourceRef: { providerId: 'gemini' } });
    assert.deepEqual(content, parseGeminiBody(fixture.markdown));
    assert.ok(JSON.stringify(content).includes('Q^* = 30'));
    assert.equal(diagnostics[0]?.code, 'GEMINI_LITERAL_MATH_RECOVERED');
    const independent = parseGeminiBody(fixture.markdown, fixture.structured,
        { diagnostics: [], sourceRef: { providerId: 'gemini' }, recoverLiteralMath: false });
    assert.notDeepEqual(content, independent, 'audit must still expose the original provider defect');
});

test('literal math recovery rejects unrelated prose, ambiguous matches, code and citations', () => {
    const native = () => parseGeminiBody('Result $Q^ = 30$.');
    const target = parseGeminiBody('Result **$Q^* = 30$**.');
    const rawNative = () => [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text: 'Result $Q^ = 30$.' }] }];
    const recovered = rawNative();
    assert.equal(recoverLiteralMath(recovered, target), 1);
    assert.deepEqual(recovered, target);
    assert.equal(recoverLiteralMath(rawNative(), [...target, ...target]), 0);
    assert.equal(recoverLiteralMath(rawNative(), parseGeminiBody('Different **$Q^* = 30$**.')), 0);
    assert.equal(recoverLiteralMath(parseGeminiBody('`Result $Q^ = 30$.`'), target), 0);
    const cited = rawNative();
    const withCitation: import('../src/l2/content/blocks.js').BlockNode[] = [{ type: 'paragraph', children: [
        ...cited[0].children, { type: 'citationRef', citationId: 'source' },
    ] }];
    assert.equal(recoverLiteralMath(withCitation, target), 0);
    assert.equal(recoverLiteralMath(native(), target), 0, 'already parsed native math stays literal');
    assert.equal(recoverLiteralMath(parseGeminiBody('Price $10 and $20.'), target), 0);
});
