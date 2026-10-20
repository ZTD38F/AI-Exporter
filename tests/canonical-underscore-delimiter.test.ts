/**
 * tests/canonical-underscore-delimiter.test.ts
 * Parser-level regression for parseEmphasis() underscore delimiter rules.
 *
 * Underscore markers (`_` / `__` / `___`) may only open/close emphasis when
 * CommonMark left/right-flanking rules allow it. Intra-word underscores
 * (foo_bar, T_N, LaTeX subscripts, file names) must stay plain text.
 * No LaTeX-specific special-casing is used; the fix is delimiter rules only.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const canonical = require('../src/core/export/canonical/index.js');
const { normalizeGeminiConversation } = canonical;

async function inlineNodes(content: string): Promise<any[]> {
    const raw: any = {
        id: 'c1',
        messages: [{ id: 'm1', role: 'user', content }],
    };
    const { bundle } = await normalizeGeminiConversation(raw);
    const msg = bundle.conversation.messages[0];
    const out: any[] = [];
    for (const b of msg.blocks) {
        if (b.children) out.push(...b.children);
    }
    return out;
}

function hasEmphasis(nodes: any[]): boolean {
    for (const n of nodes) {
        if (n.type === 'emphasis' || n.type === 'strong') return true;
        if (n.children && hasEmphasis(n.children)) return true;
    }
    return false;
}

function allText(nodes: any[]): string {
    return nodes
        .map((n) => {
            if (n.type === 'text') return n.text ?? '';
            if (n.children) return allText(n.children);
            return '';
        })
        .join('');
}

// Must stay plain text: no emphasis/strong node anywhere, text preserved verbatim.
const STAY_TEXT = [
    'foo_bar',
    'foo_bar_baz',
    'T_N',
    'S_i',
    'V_{eff}',
    '\\omega_c',
    '\\sum_{\\langle i, j \\rangle} \\vec{S}_i',
    '|\\Theta_{CW}|/T_N',
    'gemini_test_1790464921_a7b4a079.custom',
    'file_name.txt',
    'snake_case_variable',
    'gemini_test_123',
];

for (const input of STAY_TEXT) {
    test(`underscore stays text: ${input}`, async () => {
        const nodes = await inlineNodes(input);
        assert.ok(!hasEmphasis(nodes), `unexpected emphasis/strong in ${JSON.stringify(input)}`);
        assert.strictEqual(allText(nodes), input, 'text must be preserved verbatim');
    });
}

// Legit underscore Markdown must keep working.
test('legit italic: _this is italic_', async () => {
    const nodes = await inlineNodes('_this is italic_');
    assert.ok(hasEmphasis(nodes), 'expected an emphasis node');
    assert.strictEqual(allText(nodes), 'this is italic');
});

test('legit italic inside sentence: word _italic_ word', async () => {
    const nodes = await inlineNodes('word _italic_ word');
    const kinds = nodes.map((n: any) => n.type);
    assert.ok(kinds.includes('emphasis'), `expected emphasis, got ${JSON.stringify(kinds)}`);
    assert.strictEqual(allText(nodes), 'word italic word');
});

test('legit strong: __strong__', async () => {
    const nodes = await inlineNodes('__strong__');
    const kinds = nodes.map((n: any) => n.type);
    assert.ok(kinds.includes('strong'), `expected strong, got ${JSON.stringify(kinds)}`);
    assert.strictEqual(allText(nodes), 'strong');
});

test('legit strong inside sentence: word __strong__ word', async () => {
    const nodes = await inlineNodes('word __strong__ word');
    const kinds = nodes.map((n: any) => n.type);
    assert.ok(kinds.includes('strong'), `expected strong, got ${JSON.stringify(kinds)}`);
    assert.strictEqual(allText(nodes), 'word strong word');
});

// Star markers keep their existing (non-flanking) behavior.
test('star emphasis unchanged: *italic* and **bold**', async () => {
    const a = await inlineNodes('*italic*');
    assert.ok(hasEmphasis(a), 'expected emphasis for *italic*');
    const b = await inlineNodes('**bold**');
    assert.ok(b.some((n: any) => n.type === 'strong'), 'expected strong for **bold**');
});
