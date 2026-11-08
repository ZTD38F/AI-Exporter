import type { ChatGPTConversationNode } from '../src/l1/parsers/chatgpt/chatgptTypes.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatGPTInteractiveSnapshot as snapshot } from '../src/l1/parsers/chatgpt/interactiveSnapshot.js';
import { expression } from '../src/l1/parsers/chatgpt/dil/expression.js';
import { parseMarkdownAst } from '../src/l1/parsers/shared/markdown/parseMarkdown.js';
import { preprocessChatGPTMarkdown } from '../src/l1/parsers/chatgpt/markdownCompatibility.js';
import { parseChatGPTConversation } from '../src/l1/parsers/chatgpt/parseConversation.js';
import type { BlockNode } from '../src/l2/content/blocks.js';
import type { RootContent } from 'mdast';

const corpus = JSON.parse(readFileSync(join(__dirname, 'fixtures/chatgpt_dil_corpus.json'), 'utf8')) as Array<{name: string; raw: string; fallback: string}>;
function codes(text: string): string[] {
    const result: string[] = [];
    const walk = (nodes: RootContent[]) => { for (const node of nodes) { if (node.type === 'code') result.push(node.value); if ('children' in node) walk(node.children); } };
    walk(parseMarkdownAst(preprocessChatGPTMarkdown(text)).children); return result;
}
function domainCodes(blocks: BlockNode[]): string[] {
    return blocks.flatMap(block => block.type === 'code' ? [block.code]
        : block.type === 'quote' ? domainCodes(block.blocks)
        : block.type === 'list' ? block.items.flatMap(item => domainCodes(item.blocks)) : []);
}
function ordered(text: string, expected: string[]) {
    let at = -1;
    for (const token of expected) { const next = text.indexOf(token, at + 1); assert.ok(next > at, `Missing/out-of-order: ${token}`); at = next; }
}

for (const fixture of corpus) test(`Captured DIL ${fixture.name}: source is independently parseable without fallback`, () => {
    const direct = snapshot(fixture.raw), withFallback = snapshot(fixture.raw, fixture.fallback);
    assert.equal(direct.incomplete, false, JSON.stringify(direct.unsupported));
    assert.equal(direct.fallbackBlocks, 0);
    assert.deepEqual(direct.unsupported, []);
    assert.equal(withFallback.text, direct.text, 'official fallback does not replace a supported source');
    assert.equal(withFallback.fallbackBlocks, 0);
    // Verify every original Python CodeBlock physically survives, including
    // indentation. This oracle reads raw component bodies, not parser output.
    const parsed = parseChatGPTConversation({ assetsByNode: new Map(), conversation: {
        id: fixture.name, title: fixture.name, current_node: 'answer', createdAtMs: 1000, updatedAtMs: 2000, is_archived: false,
        mapping: new Map(Object.entries<ChatGPTConversationNode>({ root: { id: 'root', children: ['answer'] }, answer: { id: 'answer', parent: 'root', children: [], message: {
            id: 'answer', author: { role: 'assistant' }, recipient: 'all', weight: 1, end_turn: true,
            status: 'finished_successfully', content: { content_type: 'text', parts: [fixture.raw] },
            metadata: { model_dil_v2: { fallbackMarkdown: fixture.fallback } },
        } } })),
    } });
    assert.equal(parsed.conversation.detail.quality.status, 'complete');
    assert.equal(parsed.conversation.detail.messages.length, 1);
    const actualCodes = codes(direct.text);
    const productionCodes = parsed.conversation.detail.messages.flatMap(message => domainCodes(message.content));
    for (const match of fixture.raw.matchAll(/<CodeBlock\b[^>]*>\n?([\s\S]*?)\n?<\/CodeBlock>/g)) {
        const expected = match[1].replace(/\n\s*$/, '');
        assert.ok(actualCodes.includes(expected), `${fixture.name}: code body changed`);
        assert.ok(productionCodes.includes(expected), `${fixture.name}: production conversation changed code body`);
    }
});

test('Live Helmholtz checklist stays before conclusion with all six labels and static initial counter', () => {
    const fixture = corpus.find(item => item.raw.includes('const checks ='))!;
    const result = snapshot(fixture.raw, fixture.fallback);
    ordered(result.text, ['## 7. Reproducibility checklist', '0 of 6',
        'Record cavity volume, neck radius, and physical neck length in SI units.',
        'Record the speed of sound and the exact end-correction convention.',
        'Calculate effective length and ideal resonance frequency independently.',
        'Run the positive-domain, scaling, volume-dependence, and reference tests.',
        'Record Python version, test output, and any changes to model parameters.',
        'If comparing with hardware, record the measurement setup, temperature, boundary conditions, and observed resonance peak.',
        '**Conclusion:**']);
    assert.ok(!result.text.includes('setDone'));
    assert.equal(result.representation, 'structured-source');
    assert.equal(result.text.match(/Record cavity volume/g)?.length, 1);
});

test('Layout cards, title, divider, code, SVG, learning widget and gallery render in source order', () => {
    const raw = '# Before\n<box><title size="xl">Summary</title><grid><grid-item><text>Count</text>64</grid-item></grid>'
        + '<divider/><CodeBlock language="python">print("<box>{literal}</box>")</CodeBlock>'
        + '<svg><text fontSize="12">diagram</text></svg>'
        + '<LearningViz type_id="ANGULAR_FREQUENCY_RELATION" initial_values={{frequency:100}}/>'
        + '<AsyncImage query="test diagram"/><caption>Caption text</caption>'
        + '<math block value="x^2"/><input value="10" placeholder="Enter value"/>'
        + '<LearningViz type_id="COMPOUND_INTEREST">Growth formula</LearningViz></box>\nAfter';
    const result = snapshot(raw);
    assert.equal(result.incomplete, false);
    ordered(result.text, ['# Before', '**Summary**', 'Count', '64', '---', '```python', 'print("<box>{literal}</box>")',
        '```svg', 'font-size="12"', 'Shows the relationship', '- frequency: 100', '\uE200image_group', 'Caption text', 'x^2', '输入框占位文本：Enter value', '初始值：10', 'Explains compound interest', 'Growth formula', 'After']);
    assert.deepEqual(codes(result.text), ['print("<box>{literal}</box>")', '<svg><text font-size="12">diagram</text></svg>']);
});

test('Literal loops render only referenced fields, retain repeated choices, and honor nested conditions', () => {
    const result = snapshot('{@body const internal = ["not-visible"]}'
        + '{@body const $questions = [{q:"One?",opts:["Yes","No"],secret:"hidden"},{q:"Two?",opts:["Yes","No"]}]}'
        + '{#each $questions as q,i}<box><text>{q.q}</text>{#each q.opts as opt,j}<radio>{["A","B"][j]}. {opt}</radio>{/each}'
        + '{#if i < $questions.length - 1}<divider/>{:else}<text>Last</text>{/if}</box>{/each}');
    assert.equal(result.incomplete, false);
    assert.ok(!result.text.includes('not-visible')); assert.ok(!result.text.includes('hidden'));
    ordered(result.text, ['One?', 'A. Yes', 'B. No', '---', 'Two?', 'A. Yes', 'B. No', 'Last']);
    assert.equal(result.text.match(/A\. Yes/g)?.length, 2);
});

test('Components preserve Markdown code, inline code, formulas, and safe literal interpolation', () => {
    const raw = String.raw`<box>
\[x_{i} < y_{j}\]
\(p<q\)
` + '`<checkbox>{fake}</checkbox>`' + '\n```html\n<box>{untouched}</box>\n```\n'
        + '{@body const label = "safe <tag> *value*"}<text>{label}</text></box>';
    const result = snapshot(raw);
    assert.equal(result.incomplete, false);
    assert.ok(result.text.includes(String.raw`\[x_{i} < y_{j}\]`));
    assert.ok(result.text.includes('`<checkbox>{fake}</checkbox>`'));
    assert.ok(result.text.includes('safe \\<tag\\> \\*value\\*'));
    assert.deepEqual(codes(result.text), ['<box>{untouched}</box>']);
});

test('Only the unsupported component uses uniquely anchored fallback; siblings and restored labels stay', () => {
    const before = 'This paragraph precedes the custom visualization.';
    const after = 'This paragraph follows the custom visualization.';
    const result = snapshot(`<box>${before}<CustomChart value={getData()}/>${after}</box>`
        + '{@body const items = ["Restored choice"]}{#each items as item}<checkbox>{item}</checkbox>{/each}',
        `${before}\nChart summary from provider.\n${after}`);
    ordered(result.text, [before, 'Chart summary from provider.', after, 'Restored choice']);
    assert.equal(result.fallbackBlocks, 1);
    assert.deepEqual(result.unsupported, ['CustomChart']);
    assert.equal(result.incomplete, false);
    const unicodeBefore = 'Long enough neighboring text 𐐀&#65;';
    const unicodeAfter = 'Following paragraph that anchors the end.';
    const unicode = snapshot(`<box>${unicodeBefore}<CustomChart/>${unicodeAfter}</box>`,
        `${unicodeBefore}\nChart description.\n${unicodeAfter}`);
    ordered(unicode.text, [unicodeBefore, 'Chart description.', unicodeAfter]);
    assert.equal(unicode.fallbackBlocks, 1);
    assert.equal(unicode.text.match(/&#65;/g)?.length, 1);
});

test('Unknown, malformed and ambiguous components preserve fallback or explicitly report unavailable content', () => {
    for (const raw of ['<custom-chart/>', '<LearningViz type_id="UNKNOWN"/>', '<box>Unclosed', '{#each missing as x}{x}{/each}', '<text>{run()}</text>', '<box>'.repeat(70)]) {
        const fallback = 'Known provider content'; const result = snapshot(raw, fallback);
        assert.equal(result.text, fallback); assert.equal(result.incomplete, false); assert.ok(result.fallbackBlocks);
        assert.equal(snapshot(raw).incomplete, true, raw);
    }
    assert.equal(snapshot('x'.repeat(1_000_001), 'Full fallback').text, 'Full fallback');
    assert.equal(snapshot('').incomplete, true);
    assert.equal(snapshot('', 'Fallback only').text, 'Fallback only');
    assert.equal(snapshot('<radio>One label</radio>', 'Extra question\nOne label\nOther label').text,
        'Extra question\nOne label\nOther label', 'source discrepancy does not erase additional provider content');
});

test('Expressions and handlers cannot execute calls, access prototypes, or expand arbitrary data', () => {
    for (const source of ['fetch("https://invalid.example")', '[{q:run()}]', '["hidden"].map(run)',
        '[...secrets]', '[{get q(){return "hidden"}}]', '({}).constructor', 'x.__proto__', 'x["constructor"]',
        'new Function("return 1")', '(()=>1)()', '1/0', '"x".repeat(1e9)']) {
        assert.throws(() => expression(source, new Map([['x', []]])), source);
        const result = snapshot(`{@body const questions = ${source}}{#each questions as q}<text>{q}</text>{/each}`, '[Submit]');
        assert.equal(result.text, '[Submit]'); assert.ok(result.unsupported.length);
    }
    assert.throws(() => expression('x + x', new Map([['x', 'x'.repeat(600_000)]])), /string limit/);
    assert.equal(snapshot('<button onClick={() => fetch("https://invalid.example")}>Submit</button>').text.trim(), '[Submit]');
    assert.equal(snapshot('<checkbox checked={run()} onChange={run}>Label</checkbox>').text.trim(), '- Label');
});
