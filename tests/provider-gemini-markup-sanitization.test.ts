/**
 * tests/provider-gemini-markup-sanitization.test.ts
 * Runtime provider content-adapter and Document renderer contract.
 *
 * Verifies that Gemini provider-specific structured markup:
 * - <ElicitationsGroup message="..."> ... </ElicitationsGroup>
 * - <Elicitation label="..." query="..." />
 * - <FollowUp label="..." query="..." />
 * - <GenerateWidget id="..." />
 *
 * is intercepted and sanitized at the Gemini content adapter,
 * preventing any proprietary metadata syntax from leaking into Domain content
 * or final HTML / Markdown exports.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { parseGeminiBody, parseSourceReasoning } = require('../src/l1/parsers/gemini/shared/contentAdapter.js');

test('Gemini interactive markup is removed by provider content adapter before source AST output', () => {
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

    // This is the same provider adapter used by native Gemini RPC parsing.
    // Do not re-import the body through the historical record compatibility fixture.
    const reasoning = parseSourceReasoning(
        '思考过程：\n<Elicitation label="内部测试"/>\n分析比特与量子比特。',
        { diagnostics: [], sourceRef: { providerId: 'gemini', locator: 'messages[0].reasoning' } },
    );
    const msg = { content: parseGeminiBody(rawContent), reasoning };
    assert.ok(msg.reasoning?.length, 'authored reasoning must remain visible');
    assert.ok(JSON.stringify(msg.reasoning).includes('分析比特与量子比特'));

    // Domain content assertions
    const allText = JSON.stringify(msg.content);
    assert.strictEqual(allText.includes('ElicitationsGroup'), false, 'Domain content blocks must not contain ElicitationsGroup');
    assert.strictEqual(allText.includes('Elicitation'), false, 'Domain content blocks must not contain Elicitation');
    assert.strictEqual(allText.includes('FollowUp'), false, 'Domain content blocks must not contain FollowUp');
    assert.strictEqual(allText.includes('GenerateWidget'), false, 'Domain content blocks must not contain GenerateWidget');

    // Valid user content is preserved
    assert.ok(allText.includes('经典比特（Bit）与量子比特（Qubit）'));
    assert.ok(allText.includes('量子比特具备指数级并行潜力。'));

});
