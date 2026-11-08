/**
 * tests/compat_rules.test.ts
 *
 * Tier 1 unit test for Parser Compatibility Rule Registry.
 * Verifies every admitted compatibility rule has provenance evidence and
 * immutable metadata, while ordinary authored Markdown/TeX remains untouched.
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
    GM_MD_004_LINE_START_DISPLAY,
} = require('../src/l1/parsers/gemini/shared/markdownCompatibility.js');

test('Compatibility Rules: every admitted rule has immutable, unique provenance evidence', () => {
    assert.ok(Object.isFrozen(GEMINI_MARKDOWN_COMPAT_RULES));
    assert.ok(Object.isFrozen(GEMINI_TEX_COMPAT_RULES));
    assert.ok(GEMINI_MARKDOWN_COMPAT_RULES.includes(GM_MD_001_FENCE_NORMALIZATION));

    const all = [...GEMINI_MARKDOWN_COMPAT_RULES, ...GEMINI_TEX_COMPAT_RULES, GM_MD_004_LINE_START_DISPLAY];
    assert.strictEqual(new Set(all.map(rule => rule.id)).size, all.length, 'rule IDs must be unique across registries');
    for (const rule of all) {
        assert.match(rule.id, /^GM-(MD|TEX)-\d{3}$/);
        assert.strictEqual(rule.domain, rule.id.startsWith('GM-MD-') ? 'markdown' : 'tex');
        assert.ok(Object.isFrozen(rule), `rule ${rule.id} must be frozen`);
        assert.ok(Number.isFinite(Date.parse(rule.observedAt)), `rule ${rule.id} needs a valid observation date`);
        assert.ok(rule.description.trim().length > 20, `rule ${rule.id} needs an explanation`);
        assert.match(rule.evidence, /^tests\/fixtures\//);
        assert.ok(fs.statSync(path.resolve(__dirname, '..', rule.evidence)).isFile(),
            `rule ${rule.id} must reference an existing evidence file`);
    }
    assert.ok(all.some(rule => rule.id === 'GM-MD-002'), 'the evidenced table-math compatibility rule must remain admitted');
    assert.ok(all.some(rule => rule.id === 'GM-TEX-001'), 'the evidenced mathscr compatibility rule must remain admitted');
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

