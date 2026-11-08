/**
 * 2. Original LaTeX source is preserved inside MathML <annotation encoding="application/x-tex">
 *    for accessibility and copyability.
 * 3. Unsupported LaTeX environments (TikZ) are detected and fail gracefully with diagnostic warnings
 *    and copyable fallback blocks.
 * 4. Unknown LaTeX commands / syntax errors trigger graceful diagnostic fallback blocks.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { renderMathHtml } = require('../src/l4/format/html/htmlMath.js');
const { getRendererStrings } = require('../src/l4/format/shared/renderStrings.js');
const { renderDocumentHtml } = require('../src/l4/format/html/renderHtml.js');
const { parseFixture } = require('./helpers/documentFixture.js');

test('PR 3: Supported LaTeX math compiles to valid MathML', () => {
    const resInline = renderMathHtml('E = mc^2', false, getRendererStrings('zh').mathFallback);
    assert.strictEqual(resInline.diagnostic, undefined);
    assert.ok(resInline.html.includes('<math xmlns="http://www.w3.org/1998/Math/MathML">'));
    assert.ok(resInline.html.includes('<annotation encoding="application/x-tex">E = mc^2</annotation>'));

    const resFrac = renderMathHtml(String.raw`\frac{a}{b}`, true, getRendererStrings('zh').mathFallback);
    assert.strictEqual(resFrac.diagnostic, undefined);
    assert.ok(resFrac.html.includes('<mfrac>'));
    const withoutAnnotation = resFrac.html.replace(/<annotation\b[\s\S]*?<\/annotation>/g, '');
    assert.strictEqual(withoutAnnotation.includes(String.raw`\frac`), false, 'Visible MathML DOM must use <mfrac> instead of raw \\frac text');

    const resScripts = renderMathHtml('x_i^2', false, getRendererStrings('zh').mathFallback);
    assert.strictEqual(resScripts.diagnostic, undefined);
    assert.ok(resScripts.html.includes('<msubsup>') || resScripts.html.includes('<msub>'));

    const resMatrix = renderMathHtml(String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}`, true, getRendererStrings('zh').mathFallback);
    assert.strictEqual(resMatrix.diagnostic, undefined);
    assert.ok(resMatrix.html.includes('<mtable'));
    assert.ok(resMatrix.html.includes('<mtr>'));

    const resCases = renderMathHtml(String.raw`\begin{cases} 1 & x > 0 \\ 0 & x \le 0 \end{cases}`, true, getRendererStrings('zh').mathFallback);
    assert.strictEqual(resCases.diagnostic, undefined);
    assert.ok(resCases.html.includes('<mtable'));

    const resOp = renderMathHtml(String.raw`\operatorname{tr}(A) + \hbar \Omega`, false, getRendererStrings('zh').mathFallback);
    assert.strictEqual(resOp.diagnostic, undefined);
    assert.ok(resOp.html.includes('<mi>tr</mi>') || resOp.html.includes('tr'));
});

test('PR 3: TikZ diagrams fail gracefully with HTML_MATH_UNSUPPORTED_TIKZ diagnostic', () => {
    const tikzSource = [
        String.raw`\begin{tikzpicture}[scale=1.5]`,
        String.raw`\draw[thick,->] (0,0) -- (1,0) node[anchor=north west] {x};`,
        String.raw`\draw[thick,->] (0,0) -- (0,1) node[anchor=south east] {y};`,
        String.raw`\end{tikzpicture}`,
    ].join('\n');

    const res = renderMathHtml(tikzSource, true, getRendererStrings('zh').mathFallback);
    assert.ok(res.diagnostic);
    assert.strictEqual(res.diagnostic.code, 'HTML_MATH_UNSUPPORTED_TIKZ');
    assert.strictEqual(res.diagnostic.severity, 'warning');
    assert.ok(res.html.includes('gem-math-unsupported'));
    assert.ok(res.html.includes('无法排版该公式；保留原始 LaTeX：'));
    assert.ok(res.html.includes(String.raw`\begin{tikzpicture}`));
});

test('PR 3: Unknown LaTeX commands fail gracefully with HTML_MATH_RENDER_FAILED diagnostic', () => {
    const unkSource = String.raw`\completelyUnknownMacro{foo}{bar}`;
    const res = renderMathHtml(unkSource, true, getRendererStrings('en').mathFallback);
    assert.ok(res.diagnostic);
    assert.strictEqual(res.diagnostic.code, 'HTML_MATH_RENDER_FAILED');
    assert.ok(res.html.includes('gem-math-unsupported'));
    assert.ok(res.html.includes('Could not typeset this formula; original LaTeX preserved:'));
    assert.ok(res.html.includes(unkSource));
});

test('PR 3: Empty math source handles gracefully', () => {
    const res = renderMathHtml('   ', true, getRendererStrings('zh').mathFallback);
    assert.ok(res.diagnostic);
    assert.strictEqual(res.diagnostic.code, 'HTML_MATH_EMPTY');
    assert.ok(res.html.includes('gem-math-empty'));
});

test('PR 3: End-to-end integration via provider parsing, composition and HTML rendering', async () => {
    const raw = {
        id: 'math_policy_integration_test',
        title: 'Math Policy Test',
        messages: [{
            id: 'm1',
            role: 'model',
            content: [
                '爱因斯坦质能方程为 $E = mc^2$。',
                '',
                '$$',
                String.raw`\hbar \Omega = \int_0^\infty f(x) dx`,
                '$$',
                '',
                '以下是复杂绘图：',
                '$$',
                String.raw`\begin{tikzpicture}`,
                String.raw`\draw (0,0) -- (1,1);`,
                String.raw`\end{tikzpicture}`,
                '$$',
            ].join('\n'),
        }],
    };

    const { document, resources } = await parseFixture(raw);
    const { html, diagnostics } = renderDocumentHtml(document, resources, { locale: 'zh' });
    const tikzDiag = diagnostics.find((d: { code: string }) => d.code === 'HTML_MATH_UNSUPPORTED_TIKZ');
    assert.ok(tikzDiag, 'Expected HTML_MATH_UNSUPPORTED_TIKZ diagnostic in renderCanonicalHtml');
    assert.ok(html.includes('无法排版该公式；保留原始 LaTeX：'));
    assert.ok(html.includes(String.raw`\begin{tikzpicture}`));

    assert.ok(html.includes('<math xmlns="http://www.w3.org/1998/Math/MathML">'));
    assert.ok(html.includes('<annotation encoding="application/x-tex">E = mc^2</annotation>'));
    assert.ok(html.includes(String.raw`\hbar \Omega = \int_0^\infty f(x) dx`));
});

test('live centered negation renders as MathML while retaining original TeX', () => {
    const source = String.raw`a \centernot\implies b`;
    const result = renderMathHtml(source, true, 'fallback');
    assert.equal(result.diagnostic, undefined);
    assert.ok(result.html.includes('⇏'));
    assert.ok(result.html.includes(source), 'retain original TeX annotation');
    assert.ok(!result.html.includes('gem-math-unsupported'));
});
