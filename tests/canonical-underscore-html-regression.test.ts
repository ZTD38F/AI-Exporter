/**
 * tests/canonical-underscore-html-regression.test.ts
 * Production regression: Tier-2-class inputs must survive the full
 * normalizeGeminiConversation -> CanonicalHtmlRenderer pipeline without
 * <em> being injected into LaTeX-like underscores or file names.
 *
 * Reuses the #636 Tier 2 gate assertions locally (the gate itself,
 * feat_html_export_download, needs live Chrome + a Gemini account and cannot
 * run on this VM; it is intentionally NOT modified here).
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { normalizeGeminiConversation, CanonicalHtmlRenderer } = require('../src/core/export/canonical/index.js');

function makeContext(bundle: any): any {
    return {
        bundle,
        assets: { resolve: async () => null },
        locale: 'zh',
        signal: AbortSignal.timeout(10000),
        reportProgress: () => {},
    };
}

// Mirrors the #636 Tier 2 gate: LaTeX macro followed by <em> means the parser
// shattered a formula (e.g. \hat{H}<em>{JC}, \omega<em>a).
const CORRUPTED_MATH_RE = /\\[a-zA-Z]+<em>[^<]+<\/em>/;

const CASES = [
    '\\sum_{\\langle i, j \\rangle} \\vec{S}_i',
    '|\\Theta_{CW}|/T_N',
    'gemini_test_1790464921_a7b4a079.custom',
    'foo_bar_baz and T_N stay intact',
];

test('full pipeline keeps LaTeX-like underscores and file names intact', async () => {
    const content = CASES.join('\n\n');
    const chat: any = {
        id: 'underscore_regression_001',
        title: 'Underscore regression',
        messages: [{ id: 'm1', role: 'user', content }],
    };
    const { bundle } = await normalizeGeminiConversation(chat);
    const renderer = new CanonicalHtmlRenderer();
    const artifact = await renderer.render(makeContext(bundle));
    const html = String(artifact.content);

    for (const c of CASES) {
        assert.ok(html.includes(c), `expected verbatim output to contain ${JSON.stringify(c)}`);
    }
    assert.ok(!CORRUPTED_MATH_RE.test(html), 'no <em> injected into LaTeX macros');
    assert.ok(!html.includes('\\sum<em>'), 'no \\sum<em>');
    assert.ok(!html.includes('\\Theta<em>'), 'no \\Theta<em>');
    assert.ok(!html.includes('gemini<em>'), 'no gemini<em>');
    // Intra-word underscores preserved as literal underscores.
    assert.ok(html.includes('foo_bar_baz'), 'foo_bar_baz preserved');
    assert.ok(html.includes('T_N'), 'T_N preserved');
});

test('legit underscore emphasis still renders in HTML', async () => {
    const chat: any = {
        id: 'underscore_regression_002',
        title: 'Underscore legit',
        messages: [{ id: 'm1', role: 'user', content: 'word _italic_ word and __strong__ here' }],
    };
    const { bundle } = await normalizeGeminiConversation(chat);
    const renderer = new CanonicalHtmlRenderer();
    const artifact = await renderer.render(makeContext(bundle));
    const html = String(artifact.content);
    assert.ok(html.includes('<em>italic</em>'), 'legit _italic_ renders');
    assert.ok(html.includes('<strong>strong</strong>'), 'legit __strong__ renders');
});
