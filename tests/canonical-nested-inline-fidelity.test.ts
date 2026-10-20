/**
 * tests/canonical-nested-inline-fidelity.test.ts
 * Tier 1 unit tests for HTML export fidelity & nested inline Markdown semantics.
 *
 * Verifies:
 * - Table cell bold: <strong>bold</strong>, not literal **bold**
 * - Table cell line breaks: <br>, not literal &lt;br&gt;
 * - Mixed inline semantics: **State**<br>`code` and *italic*
 * - Code and math spans nested inside emphasis: **bold `code` bold**, **bold $x$ bold**
 * - Links nested inside emphasis and emphasis inside links: **[link](...)**, [**bold**](...)
 * - Various break variants (<br>, <br/>, <br />) supported in paragraphs and tables
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const canonical = require('../src/core/export/canonical/index.js');
const { normalizeGeminiConversation, renderCanonicalHtml } = canonical;

async function normAndRender(content: string, options: any = {}) {
    const raw: any = {
        id: 'fidelity_test_chat',
        title: 'Fidelity Test',
        messages: [{ id: 'm1', role: 'model', content }],
    };
    const { bundle, diagnostics } = await normalizeGeminiConversation(raw, options);
    const { html } = renderCanonicalHtml(bundle);
    const msg = bundle.conversation.messages[0];
    return { bundle, msg, html, diagnostics };
}

test('Fidelity 1: Table cell bold renders as <strong> and does not leak **', async () => {
    const md = '| Dimension |\n| :--- |\n| **bold text** |\n';
    const { msg, html } = await normAndRender(md);

    const table = msg.blocks.find((b: any) => b.type === 'table');
    assert.ok(table, 'table block found');
    const cellChildren = table.rows[0].cells[0].children;
    assert.strictEqual(cellChildren.length, 1);
    assert.strictEqual(cellChildren[0].type, 'strong');
    assert.strictEqual(cellChildren[0].children[0].text, 'bold text');

    // HTML assertions
    assert.ok(html.includes('<strong>bold text</strong>'), 'HTML contains <strong>bold text</strong>');
    assert.ok(!html.includes('**bold text**'), 'HTML does not leak **bold text**');
});

test('Fidelity 2: Table cell HTML break <br> renders as lineBreak and does not leak literal &lt;br&gt;', async () => {
    const md = '| 对比维度 | 经典比特 (Bit) |\n| :--- | :--- |\n| **叠加态** | **确定状态**<br>任意时刻只能处于确定的 $0$ 或 $1$ 状态。 |\n';
    const { msg, html } = await normAndRender(md);

    const table = msg.blocks.find((b: any) => b.type === 'table');
    assert.ok(table, 'table block found');
    const cellChildren = table.rows[0].cells[1].children;

    // Check canonical AST structure
    assert.strictEqual(cellChildren[0].type, 'strong');
    assert.strictEqual(cellChildren[0].children[0].text, '确定状态');
    assert.strictEqual(cellChildren[1].type, 'lineBreak');
    assert.strictEqual(cellChildren[1].kind, 'hard');

    // HTML assertions
    assert.ok(html.includes('<strong>确定状态</strong><br>任意时刻只能处于确定的'), 'HTML contains <br> line break after strong');
    assert.ok(!html.includes('&lt;br&gt;'), 'HTML does not escape <br> to literal &lt;br&gt;');
    assert.ok(!html.includes('&lt;br/&gt;'), 'HTML does not contain literal &lt;br/&gt;');
});

test('Fidelity 3: Mixed inline semantics (**State**<br>`code` and *italic*) render completely and accurately', async () => {
    const md = '**State**<br>`code` and *italic*';
    const { msg, html } = await normAndRender(md);

    const p = msg.blocks[0];
    assert.strictEqual(p.type, 'paragraph');
    const types = p.children.map((c: any) => c.type);
    assert.deepStrictEqual(types, ['strong', 'lineBreak', 'inlineCode', 'text', 'emphasis']);

    assert.strictEqual(p.children[0].children[0].text, 'State');
    assert.strictEqual(p.children[2].code, 'code');
    assert.strictEqual(p.children[3].text, ' and ');
    assert.strictEqual(p.children[4].children[0].text, 'italic');

    // HTML assertions
    assert.ok(html.includes('<strong>State</strong><br><code class="gem-inline-code">code</code> and <em>italic</em>'),
        'HTML contains all inline elements correctly typeset');
    assert.ok(!html.includes('**State**'), 'HTML does not leak **State**');
    assert.ok(!html.includes('&lt;br&gt;'), 'HTML does not leak &lt;br&gt;');
});

test('Fidelity 4: Emphasis wrapping code spans and math spans preserves nesting without delimiter leakage', async () => {
    const md = '**bold `code` bold** and *italic `code` italic* and **bold $x$ bold**';
    const { msg, html } = await normAndRender(md);

    const p = msg.blocks[0];
    assert.strictEqual(p.type, 'paragraph');

    // First node is strong
    assert.strictEqual(p.children[0].type, 'strong');
    const strongChildren = p.children[0].children;
    assert.strictEqual(strongChildren[0].text, 'bold ');
    assert.strictEqual(strongChildren[1].type, 'inlineCode');
    assert.strictEqual(strongChildren[1].code, 'code');
    assert.strictEqual(strongChildren[2].text, ' bold');

    // HTML assertions
    assert.ok(html.includes('<strong>bold <code class="gem-inline-code">code</code> bold</strong>'),
        'HTML renders strong wrapping inline code');
    assert.ok(html.includes('<em>italic <code class="gem-inline-code">code</code> italic</em>'),
        'HTML renders emphasis wrapping inline code');
    assert.ok(html.includes('<strong>bold <span class="gem-math-inline">') && html.includes('<math') && html.includes('</span> bold</strong>'),
        'HTML renders strong wrapping inline math');
    assert.ok(!html.includes('**bold'), 'HTML does not leak **bold');
});

test('Fidelity 5: Emphasis wrapping links and links wrapping emphasis', async () => {
    const md = '**[bold link](https://example.com/1)** and [**nested bold**](https://example.com/2)';
    const { msg, html } = await normAndRender(md);

    const p = msg.blocks[0];
    // First: strong containing link
    assert.strictEqual(p.children[0].type, 'strong');
    const link1 = p.children[0].children[0];
    assert.strictEqual(link1.type, 'link');
    assert.strictEqual(link1.href, 'https://example.com/1');

    // Second: link containing strong
    assert.strictEqual(p.children[2].type, 'link');
    assert.strictEqual(p.children[2].href, 'https://example.com/2');
    assert.strictEqual(p.children[2].children[0].type, 'strong');
    assert.strictEqual(p.children[2].children[0].children[0].text, 'nested bold');

    // HTML assertions
    assert.ok(html.includes('<strong><a href="https://example.com/1"'), 'HTML renders strong wrapping <a>');
    assert.ok(html.includes('<a href="https://example.com/2" target="_blank" rel="noopener noreferrer" class="gem-link"><strong>nested bold</strong></a>'),
        'HTML renders <a> wrapping <strong>');
    assert.ok(!html.includes('**['), 'HTML does not leak **[');
    assert.ok(!html.includes('[**'), 'HTML does not leak [**');
});

test('Fidelity 7: Various break variants (<br>, <br/>, <br />) are supported in both paragraph and tables', async () => {
    const md = 'line1<br>line2<br/>line3<br />line4';
    const { msg, html } = await normAndRender(md);

    const p = msg.blocks[0];
    const breakCount = p.children.filter((c: any) => c.type === 'lineBreak').length;
    assert.strictEqual(breakCount, 3, 'all 3 breaks recognized');

    assert.ok(html.includes('line1<br>line2<br>line3<br>line4'), 'HTML renders clean <br> tags');
    assert.ok(!html.includes('&lt;br'), 'HTML does not leak escaped &lt;br');
});
