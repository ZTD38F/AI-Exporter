/**
 * tests/canonical-gemini-markup-sanitization.test.ts
 * Tier 1 test for PR 2: Gemini Structured Content Sanitization.
 *
 * Verifies that Gemini provider-specific structured markup:
 * - <ElicitationsGroup message="..."> ... </ElicitationsGroup>
 * - <Elicitation label="..." query="..." />
 * - <FollowUp label="..." query="..." />
 * - <GenerateWidget id="..." />
 *
 * is intercepted and sanitized at the Provider Normalization boundary,
 * preventing any proprietary metadata syntax from leaking into Canonical AST
 * or final HTML / Markdown exports.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const canonical = require('../src/core/export/canonical/index.js');
const { normalizeGeminiConversation, renderCanonicalHtml } = canonical;

test('Gemini structured markup is sanitized at normalization boundary and never reaches Canonical AST or HTML', async () => {
    const rawContent = [
        '经典比特（Bit）与量子比特（Qubit）有着本质区别：',
        '',
        '| 对比维度 | 经典比特 (Bit) | 量子比特 (Qubit) |',
        '| :--- | :--- | :--- |',
        '| **叠加态** | **确定状态**<br>0 或 1 | **连续叠加**<br>线性组合 |',
        '',
        '<ElicitationsGroup message="想要进一步探索量子计算的相关概念，可以尝试以下方向：">',
        '  <Elicitation label="了解量子退相干（Decoherence）的物理机制" query="请详细解释量子退相干（Decoherence）的物理机制以及它是如何破坏量子叠加态的。"/>',
        '  <Elicitation label="对比 Shor 算法与 Grover 算法的原理及加速效果" query="请对比 Shor 算法与 Grover 算法的基本原理，以及它们相对于经典算法分别带来了怎样的加速效果。"/>',
        '</ElicitationsGroup>',
        '',
        '<FollowUp label="想了解阿斯佩（Aspect）等经典实验如何闭合检测漏洞与定域漏洞吗？" query="详细解释阿斯佩实验。"/>',
        '',
        '<GenerateWidget id="widget_interactive_quantum_sim" type="simulator" />',
        '',
        '总结：量子比特具备指数级并行潜力。',
    ].join('\n');

    const raw = {
        id: 'gemini_markup_test_chat',
        title: 'Structured Markup Sanitization Test',
        messages: [{
            id: 'm1',
            role: 'model',
            content: rawContent,
            thoughts: '思考过程：\n<Elicitation label="内部测试"/>\n分析比特与量子比特。',
        }],
    };

    const { bundle } = await normalizeGeminiConversation(raw);
    const msg = bundle.conversation.messages[0];

    // Canonical AST assertions
    const allText = JSON.stringify(msg.blocks);
    assert.strictEqual(allText.includes('ElicitationsGroup'), false, 'Canonical AST blocks must not contain ElicitationsGroup');
    assert.strictEqual(allText.includes('Elicitation'), false, 'Canonical AST blocks must not contain Elicitation');
    assert.strictEqual(allText.includes('FollowUp'), false, 'Canonical AST blocks must not contain FollowUp');
    assert.strictEqual(allText.includes('GenerateWidget'), false, 'Canonical AST blocks must not contain GenerateWidget');

    // Valid user content is preserved
    assert.ok(allText.includes('经典比特（Bit）与量子比特（Qubit）'));
    assert.ok(allText.includes('量子比特具备指数级并行潜力。'));

    // HTML export assertions
    const { html } = renderCanonicalHtml(bundle);
    assert.strictEqual(html.includes('ElicitationsGroup'), false, 'HTML output must not contain ElicitationsGroup');
    assert.strictEqual(html.includes('Elicitation'), false, 'HTML output must not contain Elicitation');
    assert.strictEqual(html.includes('FollowUp'), false, 'HTML output must not contain FollowUp');
    assert.strictEqual(html.includes('GenerateWidget'), false, 'HTML output must not contain GenerateWidget');
    assert.ok(html.includes('经典比特（Bit）与量子比特（Qubit）'));
    assert.ok(html.includes('量子比特具备指数级并行潜力。'));
});
