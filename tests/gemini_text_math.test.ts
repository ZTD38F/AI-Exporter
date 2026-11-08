import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import katex from 'katex';
import { normalizeTextUnderscores } from '../src/shared/utils/latexCompatibility.js';
import { parseGeminiBody, parseGeminiPrompt } from '../src/l1/parsers/gemini/shared/contentAdapter.js';

test('captured text identifiers match Gemini display and render as valid MathML', () => {
    const source = readFileSync('tests/fixtures/provider/math/gm_tex_002_evidence.tex', 'utf8').split('\n')[2];
    const expected = String.raw`\text{run\_length} \leftarrow \text{run\_length} + 1`;
    assert.equal(normalizeTextUnderscores(source), expected);
    assert.equal(normalizeTextUnderscores(expected), expected);
    assert.throws(() => katex.renderToString(source, { throwOnError: true }));
    assert.match(katex.renderToString(expected, { throwOnError: true, output: 'mathml' }), /<mtext>run_length<\/mtext>/);
    const blocks = parseGeminiBody('$$\n' + source + '\n$$');
    assert.deepEqual(blocks, [{ type: 'math', source: expected }]);
});

test('only math nodes change, including nested lists, tables and structured math', () => {
    const source = String.raw`\text{run_length}`;
    const expected = String.raw`\text{run\_length}`;
    const blocks = parseGeminiBody('- **$' + source + '$**\n\n| Value |\n| --- |\n| $' + source + '$ |');
    const list = blocks[0], table = blocks[1];
    assert.equal(list.type, 'list');
    assert.ok(JSON.stringify(list).includes(JSON.stringify(expected).slice(1, -1)));
    assert.equal(table.type, 'table');
    assert.ok(JSON.stringify(table).includes(JSON.stringify(expected).slice(1, -1)));
    assert.deepEqual(parseGeminiBody('', { children: [{ nodeType: 12, FTa: source }] }), [{ type: 'math', source: expected }]);
    assert.deepEqual(parseGeminiBody('`' + source + '`'), [{ type: 'paragraph', children: [{ type: 'inlineCode', code: source }] }]);
    assert.deepEqual(parseGeminiPrompt(source), [{ type: 'paragraph', children: [{ type: 'text', text: source }] }]);
});

test('subscripts, escaped macros, existing escapes and unsupported nested groups stay intact', () => {
    for (const source of [String.raw`x_i + a_{run_length}`, String.raw`\text{run\_length}`,
        String.raw`\\text{run_length}`, String.raw`\text{nested{run_length}}`, String.raw`\texttt{run_length}`]) {
        assert.equal(normalizeTextUnderscores(source), source);
    }
    assert.equal(normalizeTextUnderscores(String.raw`\text{a\\_b}`), String.raw`\text{a\\\_b}`);
});
