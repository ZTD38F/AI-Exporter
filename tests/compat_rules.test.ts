/**
 * tests/compat_rules.test.ts
 *
 * Tier 1 unit test for Parser Compatibility Rule Registry.
 * Asserts:
 * 1. Initial state is empty (Section 2.4 / Section 31).
 * 2. Immutable/frozen rule registries.
 * 3. Identity transformation when registry is empty (input === output).
 * 4. Preserves arbitrary text, Markdown, LaTeX, and Unicode exactly.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');

const {
    GEMINI_MARKDOWN_COMPAT_RULES,
    GEMINI_TEX_COMPAT_RULES,
    GM_MD_001_FENCE_NORMALIZATION,
    preprocessGeminiMarkdown,
    preprocessGeminiLatex,
} = require('../src/core/export/canonical/compat/rules.js');

test('Compatibility Rules: GM-MD-001 is admitted with full provenance metadata', () => {
    assert.strictEqual(Array.isArray(GEMINI_MARKDOWN_COMPAT_RULES), true);
    assert.strictEqual(GEMINI_MARKDOWN_COMPAT_RULES.length, 1, 'Markdown compat rules must contain admitted GM-MD-001');
    assert.strictEqual(Object.isFrozen(GEMINI_MARKDOWN_COMPAT_RULES), true, 'Markdown compat rules array must be frozen');

    const rule = GEMINI_MARKDOWN_COMPAT_RULES[0];
    assert.strictEqual(rule.id, 'GM-MD-001');
    assert.strictEqual(rule.domain, 'markdown');
    assert.strictEqual(typeof rule.observedAt, 'string');
    assert.ok(rule.description.length > 20, 'Rule must have descriptive explanation');
    assert.strictEqual(rule, GM_MD_001_FENCE_NORMALIZATION);

    // Evidence file must physically exist
    const evidencePath = path.resolve(__dirname, '..', rule.evidence);
    assert.ok(fs.existsSync(evidencePath), `Evidence file must exist at ${rule.evidence}`);

    assert.strictEqual(Array.isArray(GEMINI_TEX_COMPAT_RULES), true);
    assert.strictEqual(GEMINI_TEX_COMPAT_RULES.length, 1, 'TeX compat rules contain admitted GM-TEX-001');
    assert.strictEqual(Object.isFrozen(GEMINI_TEX_COMPAT_RULES), true, 'TeX compat rules array must be frozen');

    const texRule = GEMINI_TEX_COMPAT_RULES[0];
    assert.strictEqual(texRule.id, 'GM-TEX-001');
    assert.strictEqual(texRule.domain, 'tex');
    assert.strictEqual(typeof texRule.observedAt, 'string');
    assert.ok(texRule.description.length > 20, 'Rule must have descriptive explanation');

    const texEvidencePath = path.resolve(__dirname, '..', texRule.evidence);
    assert.ok(fs.existsSync(texEvidencePath), `Evidence file must exist at ${texRule.evidence}`);
});

test('Compatibility Rules: preprocessGeminiMarkdown preserves standard Markdown structures', () => {
    const standardCases = [
        '',
        'Hello World',
        '# Heading 1\n\n**bold** *italic* `code`',
        '| A | B |\n|---|---|\n| x | `a|b` |',
        '$$E = mc^2$$',
        'Multi-line\n\n\n\nwith trailing space   \n',
        'CJK 中文测试，带公式 $x^2 + y^2 = z^2$ 和表情 😊🚀',
        '```markdown\n$$\\begin{aligned}\n\\end{aligned}$$\n```',
        '~~~latex\n$$\\begin{matrix} 1 & 2 \\end{matrix}$$\n~~~',
    ];
    for (const input of standardCases) {
        assert.strictEqual(preprocessGeminiMarkdown(input), input, 'Standard markdown must be preserved exactly');
    }
});

test('Compatibility Rules: GM-MD-001 normalizes attached display math fences', () => {
    const input = '$$\\begin{aligned}\nx = 1\n\\end{aligned}$$';
    const expected = '$$\n\\begin{aligned}\nx = 1\n\\end{aligned}\n$$';
    assert.strictEqual(preprocessGeminiMarkdown(input), expected);

    const bqInput = '> $$\\begin{aligned}\n> x = 1\n> \\end{aligned}$$';
    const bqExpected = '> $$\n> \\begin{aligned}\n> x = 1\n> \\end{aligned}\n> $$';
    assert.strictEqual(preprocessGeminiMarkdown(bqInput), bqExpected);
});

test('Compatibility Rules: preprocessGeminiLatex preserves standard LaTeX and normalizes mathscr', () => {
    const standardCases = [
        '',
        '\\frac{a}{b}',
        '\\sum_{i=1}^n x_i',
        '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
        '\\arg\\left(\\gamma\'(z_c)\\right) \\pmod\\pi',
        '\\Box \\psi = \\nabla^2 \\psi',
    ];
    for (const input of standardCases) {
        assert.strictEqual(preprocessGeminiLatex(input), input, 'Standard LaTeX must be preserved exactly');
    }

    const scrInput = '\\mathcal{F}_{\\mathscr{I}^+}';
    const scrExpected = '\\mathcal{F}_{\\mathcal{I}^+}';
    assert.strictEqual(preprocessGeminiLatex(scrInput), scrExpected, 'GM-TEX-001 must normalize mathscr to mathcal');
});

