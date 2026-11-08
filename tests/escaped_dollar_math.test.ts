import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGeminiBody } from '../src/l1/parsers/gemini/shared/contentAdapter.js';
import { normalizeEscapedDollarMath } from '../src/l1/parsers/gemini/shared/markdownCompatibility.js';
import { parseMarkdownAst } from '../src/l1/parsers/shared/markdown/parseMarkdown.js';
import { inlineMathMarkdown } from '../src/shared/utils/markdownMath.js';

test('captured escaped-dollar formulas retain their TeX sources and neighboring prose', () => {
    const raw = readFileSync('tests/fixtures/provider/math/gm_md_003_evidence.md', 'utf8').split('-->')[1].trim();
    const blocks = parseGeminiBody(raw);
    assert.equal(blocks[0].type, 'paragraph');
    if (blocks[0].type !== 'paragraph') return;
    assert.deepEqual(blocks[0].children.filter(n => n.type === 'inlineMath').map(n => n.source),
        [String.raw`\\$`, String.raw`f(\\$) = 1`, String.raw`\\$`]);
    assert.equal(normalizeEscapedDollarMath(normalizeEscapedDollarMath(raw)), normalizeEscapedDollarMath(raw));
});

test('safe Markdown math delimiters round-trip dollar runs without changing TeX', () => {
    for (const source of [String.raw`\$`, String.raw`f(\$) = 1`, String.raw`\\$`, String.raw`\text{a$$b}`]) {
        const tree = parseMarkdownAst('formula ' + inlineMathMarkdown(source) + ' end');
        const paragraph = tree.children[0];
        assert.equal(paragraph.type, 'paragraph');
        if (paragraph.type !== 'paragraph') continue;
        assert.deepEqual(paragraph.children.map(n => n.type), ['text', 'inlineMath', 'text']);
        const math = paragraph.children[1];
        assert.equal(math.type === 'inlineMath' && math.value, source);
    }
});

test('compatibility preserves code, display math, ordinary formulas, currency and unmatched input', () => {
    for (const source of [String.raw`cost \$5 and \$10`, String.raw`$x + y$`, String.raw`$f(\$)`,
        '`' + String.raw`$f(\$) = 1$` + '`', '```md\n' + String.raw`$f(\$) = 1$` + '\n```',
        '    ' + String.raw`$f(\$) = 1$`, String.raw`$$ f(\$) = 1 $$`, '$$\n' + String.raw`f(\$) = 1` + '\n$$']) {
        assert.equal(normalizeEscapedDollarMath(source), source);
    }
});
