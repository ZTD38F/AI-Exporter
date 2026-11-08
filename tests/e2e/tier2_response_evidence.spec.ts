import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const source = readFileSync('scripts/framework/driver/authored_response.js', 'utf8');

test('Canvas preview error UI is excluded while the attachment title and identical authored prose survive', async ({ page }) => {
    // Minimal structure from live c_431c4a7cf71308c4: the preview error is
    // application chrome absent from the native reply's attachment link.
    const literal = 'Something went wrong. There was a problem when running your code.';
    await page.setContent(`<model-response id="answer"><model-response-content><p>Introduction.</p><immersive-entry-chip><a>Thermodynamic Analysis of Chemical Equilibrium</a><inline-preview><code-error-card><div class="error-container"><div class="error-info"><strong>Something went wrong</strong><div>There was a problem when running your code.</div></div><button>Fix error</button></div></code-error-card></inline-preview></immersive-entry-chip><p>${literal}</p><p>Conclusion.</p></model-response-content></model-response>`);
    const before = await page.locator('#answer').innerHTML();
    const evidence = await page.evaluate(source => {
        const extract = new Function('return (\n' + source + '\n)')();
        return extract(document.querySelector('#answer')) as { text: string; pdfSegments: {kind: string; text: string}[] };
    }, source);
    const expected = 'Introduction.Thermodynamic Analysis of Chemical Equilibrium' + literal + 'Conclusion.';
    expect(evidence.text).toBe(expected);
    expect(evidence.pdfSegments.map(segment => segment.text).join('')).toBe(expected);
    expect(await page.locator('#answer').innerHTML()).toBe(before);
});

test('live evidence preserves source math and final code while excluding collapsed execution and UI', async ({ page }) => {
    await page.setContent(`<model-response id="answer"><h5>Gemini said</h5><model-response-content><div class="markdown-main-panel">
        <div class="code-block-decoration">Python<button>Copy code</button></div>
        <div style="display: none">Hidden reasoning
            <pre>print('intermediate execution')</pre>
        </div>
        <div style="display:none"><code-block><pre><code class="code-container">print('executed')
    value = 1</code></pre><pre><code class="code-result-container">executed
</code></pre></code-block></div>
        <follow-up><div>Suggested follow-up</div></follow-up>
        <div class="attachment-container unknown md-has-block-component"><response-element class="no-md"><elicitations class="lm-enabled"><div hide-from-message-actions="" class="elicitations-container"><div class="elicitations-message">To explore advanced concurrency control validation:</div><button class="elicitation-item"><div>Simulate dynamic lock managers</div></button></div></elicitations></response-element></div>
        <mini-app><div>Was this visual helpful?</div></mini-app>
        <p>波速<span data-math="v = \\frac{c}{\\sqrt{\\varepsilon_r}}"><span aria-hidden="true">vc√εr</span></span>。</p>
        <code-block><div class="code-block-decoration">Python</div><pre><code>print('final code')
value = '&lt;br&gt;'</code></pre></code-block>
        </div><div class="markdown-main-panel"><p>Keep the entire final recommendation.</p>
        <span class="cdk-visually-hidden">Gemini said</span><button>Share</button>
        <button class="image-button"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></button>
    </div></model-response-content><footer>Outside feedback</footer></model-response>`);
    const before = await page.locator('#answer').innerHTML();
    const evidence = await page.evaluate(source => {
        const extract = new Function('return (\n' + source + '\n)')();
        return extract(document.querySelector('#answer')) as { text: string; hasImages: boolean; codeBlocks: string[]; executionBlocks: {code: string; stdout: string}[] };
    }, source);
    expect(evidence.text).toContain('v = \\frac{c}{\\sqrt{\\varepsilon_r}}');
    expect(evidence.text).toContain("print('final code')");
    expect(evidence.text).toContain("value = '<br>'");
    expect(evidence.text).toContain('Keep the entire final recommendation.');
    expect(evidence.text).not.toContain('Outside feedback');
    expect(evidence.text).not.toMatch(/reasoning|intermediate execution|Copy code|Python|Gemini said|Share|Suggested follow-up|To explore advanced concurrency|Simulate dynamic lock managers|Was this visual helpful/);
    expect(evidence.hasImages).toBe(true);
    expect(evidence.codeBlocks).toEqual(["print('final code')\nvalue = '<br>'"]);
    expect(evidence.executionBlocks).toEqual([{code: "print('executed')\n    value = 1", stdout: 'executed\n'}]);
    expect(await page.locator('#answer').innerHTML()).toBe(before);
});

test('live evidence captures silent execution source separately without leaking hidden thinking', async ({ page }) => {
    await page.setContent(`<model-response id="answer"><model-response-content>
        <code-block><div class="code-block" style="display:none"><pre><code class="code-container"># silent execution</code></pre></div></code-block>
        <thought-container style="display:none"><code-block><div class="code-block" style="display:none"><pre><code class="code-container"># hidden thought</code></pre></div></code-block></thought-container>
        <code-block><div class="code-block"><pre><code class="code-container">print('visible program')</code></pre></div></code-block>
        <p>Complete final answer.</p>
    </model-response-content></model-response>`);
    const evidence = await page.evaluate(source => {
        const extract = new Function('return (\n' + source + '\n)')();
        return extract(document.querySelector('#answer')) as { text: string; codeBlocks: string[]; executionBlocks: {code: string; stdout: string}[] };
    }, source);
    expect(evidence.executionBlocks).toEqual([{code: '# silent execution', stdout: ''}]);
    expect(evidence.codeBlocks).toEqual(["print('visible program')"]);
    expect(evidence.text).toContain('Complete final answer.');
    expect(evidence.text).not.toContain('# silent execution');
    expect(evidence.text).not.toContain('# hidden thought');
});

test('live evidence excludes hidden and collapsed thinking content from authored text', async ({ page }) => {
    await page.setContent(`<model-response id="answer"><model-response-content><div class="markdown-main-panel">
        <thought-container style="display:none">
            <p>Evaluating internal reasoning path A vs path B.</p>
            <pre><code>scratchpad = {'step': 1}</code></pre>
        </thought-container>
        <div class="thought-wrapper" hidden>
            <span>Candidate thought: this should be omitted from final answer.</span>
        </div>
        <div class="model-thought" style="visibility:hidden">
            <span>Hidden internal thought chain.</span>
        </div>
        <p>This is the authored answer paragraph.</p>
        <code-block><pre><code>result = compute_final_output()</code></pre></code-block>
    </div></model-response-content></model-response>`);

    const evidence = await page.evaluate(source => {
        const extract = new Function('return (\n' + source + '\n)')();
        return extract(document.querySelector('#answer')) as { text: string; hasImages: boolean; codeBlocks: string[]; executionBlocks: {code: string; stdout: string}[] };
    }, source);

    expect(evidence.text).toContain('This is the authored answer paragraph.');
    expect(evidence.text).toContain('result = compute_final_output()');
    expect(evidence.text).not.toMatch(/reasoning path|scratchpad|Candidate thought|thought chain|omitted/);
    expect(evidence.codeBlocks).toEqual(['result = compute_final_output()']);
});

test('live evidence preserves inline and block LaTeX formulas', async ({ page }) => {
    await page.setContent(`<model-response id="answer"><model-response-content><div class="markdown-main-panel">
        <p>质能方程：<span data-math="E = mc^2"><span aria-hidden="true">Emc2</span></span>，微积分基本定理：</p>
        <div data-math="\\int_{a}^{b} f(x)\\,dx = F(b) - F(a)"><span aria-hidden="true">rendered integral</span></div>
        <p>结论成立。</p>
    </div></model-response-content></model-response>`);

    const evidence = await page.evaluate(source => {
        const extract = new Function('return (\n' + source + '\n)')();
        return extract(document.querySelector('#answer')) as { text: string; hasImages: boolean; codeBlocks: string[]; executionBlocks: {code: string; stdout: string}[] };
    }, source);

    expect(evidence.text).toContain('E = mc^2');
    expect(evidence.text).toContain('\\int_{a}^{b} f(x)\\,dx = F(b) - F(a)');
    expect(evidence.text).not.toContain('Emc2');
    expect(evidence.text).not.toContain('rendered integral');
});

test('live evidence preserves exact code block indentation and internal line breaks', async ({ page }) => {
    const authoredCode = 'def process(data):\n    if not data:\n        return None\n\n    # Preserve empty line above\n    return [x * 2 for x in data]';
    await page.setContent(`<model-response id="answer"><model-response-content><div class="markdown-main-panel">
        <p>下面是实现函数：</p>
        <code-block><div class="code-block-decoration">Python<button>Copy</button></div><pre><code>${authoredCode.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre></code-block>
    </div></model-response-content></model-response>`);

    const evidence = await page.evaluate(source => {
        const extract = new Function('return (\n' + source + '\n)')();
        return extract(document.querySelector('#answer')) as { text: string; hasImages: boolean; codeBlocks: string[]; executionBlocks: {code: string; stdout: string}[] };
    }, source);

    expect(evidence.codeBlocks).toEqual([authoredCode]);
    expect(evidence.text).toContain('下面是实现函数：');
    expect(evidence.text).not.toContain('Copy');
});


test('real norm alias evidence keeps double bars distinct from absolute value and literal prose', async ({ page }) => {
    const fixture = JSON.parse(readFileSync('tests/fixtures/provider/math/gemini_norm_alias.json', 'utf8')) as { domSource: string; rpcSource: string };
    const literal = String.raw`Literal prose \Vert{} and code \Vert{} must stay exact.`;
    await page.setContent('<model-response id="answer"><model-response-content><div class="markdown-main-panel"><span id="norm" data-math=""></span><p id="literal"></p><span id="absolute" data-math=""></span></div></model-response-content></model-response>');
    await page.evaluate(({ fixture, literal }) => {
        document.querySelector('#norm')!.setAttribute('data-math', fixture.domSource);
        document.querySelector('#literal')!.textContent = literal;
        document.querySelector('#absolute')!.setAttribute('data-math', String.raw`\vert{}x\vert{} + \Vert{x}`);
    }, { fixture, literal });
    const evidence = await page.evaluate(source => {
        const extract = new Function('return (\n' + source + '\n)')();
        return extract(document.querySelector('#answer')) as { text: string };
    }, source);
    expect(evidence.text).toBe(fixture.rpcSource + literal + String.raw`|x| + \Vert{x}`);
    expect(evidence.text).toContain(String.raw`\|\vec{ab}\|`);
    expect(evidence.text).not.toContain(String.raw`|\vec{ab}|`);
});


test('PDF source segments cover every authored character in prose, table cells, math and code', async ({ page }) => {
    await page.setContent(`<model-response id="answer"><model-response-content><p>First <strong>sentence.</strong></p>
        <table><tr><td>Cell A <span data-math="x/y">rendered</span> tail.</td><td>Cell B.</td></tr></table>
        <pre><code>if x &lt; 3:\n    print("中文")</code></pre><p>Last sentence.</p>
    </model-response-content></model-response>`);
    const evidence = await page.evaluate(source => {
        const read = new Function('return (\n' + source + '\n)')();
        return read(document.querySelector('#answer')) as {text: string; pdfSegments: {kind: string; text: string}[]};
    }, source);
    expect(evidence.pdfSegments.map(segment => segment.text).join('').replace(/\s/g, '')).toBe(evidence.text.replace(/\s/g, ''));
    expect(evidence.pdfSegments.filter(segment => segment.kind === 'math')).toEqual([{kind: 'math', text: 'x/y'}]);
    expect(evidence.pdfSegments.filter(segment => segment.kind === 'code')).toEqual([{kind: 'code', text: 'if x < 3:\n    print("中文")'}]);
    expect(evidence.pdfSegments.filter(segment => segment.kind === 'text').map(segment => segment.text)).toEqual(['First sentence.', 'Cell A ', ' tail.', 'Cell B.', 'Last sentence.']);
});

test('empty native math placeholders do not become fabricated PDF formulas', async ({ page }) => {
    await page.setContent('<model-response><model-response-content><p>Before<span class="math-inline" data-math="" data-index-in-node="0"><span class="katex"><span class="katex-mathml"></span><span class="katex-html" aria-hidden="true"></span></span></span>after<span data-math="   "></span>end<span data-math="x=1"></span>.</p></model-response-content></model-response>');
    const evidence = await page.evaluate(source => {
        const extract = new Function('return (\n' + source + '\n)')();
        return extract(document.querySelector('model-response')) as { text: string; pdfSegments: {kind: string; text: string}[] };
    }, source);
    expect(evidence.text).toBe('Beforeafter   endx=1.');
    expect(evidence.pdfSegments.filter(segment => segment.kind === 'math')).toEqual([{kind:'math',text:'x=1'}]);
    expect(evidence.pdfSegments.map(segment => segment.text).join('').replace(/\s/g,'')).toBe(evidence.text.replace(/\s/g,''));
    expect(await page.locator('[data-math=""]').count()).toBe(1);
});

const replyScripts: { send: string; wait: string; retry: string } = JSON.parse(execFileSync('python3', ['-c', `
import json
from scripts.framework.pipeline.actions import SingleClickSendAction, AwaitStreamSettledAction
class Capture:
    def __init__(self, result): self.result, self.expressions = result, []
    def eval(self, expression):
        self.expressions.append(expression)
        return self.result
send, wait = Capture({'clicked': True}), Capture({'error': 'capture only'})
SingleClickSendAction(send_btn_selector='#send').execute(None, send)
AwaitStreamSettledAction().execute(None, wait)
class RetryCapture(Capture):
    def eval(self, expression):
        self.expressions.append(expression)
        return self.result if len(self.expressions) == 1 else False
retry = RetryCapture({'error': 'Page shows a retry control', 'newReply': True, 'replyId': 'current'})
AwaitStreamSettledAction().execute(None, retry)
print(json.dumps({'send': send.expressions[0], 'wait': wait.expressions[0], 'retry': retry.expressions[1]}))
`], { encoding: 'utf8' }));

test('live reply observation rejects Gemini response failure notices without aria labels', async ({ page }) => {
    await page.setContent('<model-response><model-response-content>Incomplete answer.</model-response-content>'
        + '<response-failure-notice><gem-banner data-test-id="response-failure-notice">An error occurred'
        + '<gem-button data-test-id="banner-action-button"><button>Try again</button></gem-button>'
        + '</gem-banner></response-failure-notice></model-response>');
    expect(await page.evaluate(replyScripts.wait)).toMatchObject({error: 'Page shows a retry control'});
});

test('provider retry stays bound to the failed current response and never submits another prompt', async ({ page }) => {
    const notice = '<response-failure-notice><gem-button data-test-id="banner-action-button"><button onclick="this.dataset.clicked=\'true\'">Try again</button></gem-button></response-failure-notice>';
    await page.setContent('<button id="send" onclick="this.dataset.clicked=\'true\'">Send</button>'
        + `<div class="conversation-container" id="old"><model-response>${notice}</model-response></div>`
        + '<div class="conversation-container" id="current"><user-query>Actual prompt</user-query><model-response>Pending</model-response></div>');
    expect(await page.evaluate(replyScripts.retry)).toBe(false);
    await expect(page.locator('[data-clicked]')).toHaveCount(0);
    await page.locator('#current model-response').evaluate((element, notice) => element.innerHTML += notice, notice);
    expect(await page.evaluate(replyScripts.retry)).toBe(true);
    await expect(page.locator('#current button')).toHaveAttribute('data-clicked', 'true');
    await expect(page.locator('#old button')).not.toHaveAttribute('data-clicked');
    await expect(page.locator('#send')).not.toHaveAttribute('data-clicked');
    await expect(page.locator('user-query')).toHaveCount(1);
    await page.locator('#current').evaluate(element => { element.id = 'replaced'; });
    expect(await page.evaluate(replyScripts.retry)).toBe(false);
});

test('live reply detection follows turn IDs when Gemini virtualizes or recycles five mounted responses', async ({ page }) => {
    await page.setContent('<button id="send">Send</button><div class="ql-editor" contenteditable="true"></div>'
        + Array.from({length: 5}, (_, i) => `<div class="conversation-container" id="turn-${i}"><model-response><model-response-content>OK</model-response-content></model-response></div>`).join(''));
    await page.evaluate(replyScripts.send);
    expect(await page.evaluate(replyScripts.wait)).toMatchObject({newReply: false, modelCount: 5});
    // Rerendering the old response must not count as a new answer.
    await page.evaluate(() => {
        const last = document.querySelectorAll('model-response')[4];
        last.replaceWith(last.cloneNode(true));
    });
    expect(await page.evaluate(replyScripts.wait)).toMatchObject({newReply: false, modelCount: 5});
    // Recycle the existing node with the next turn ID and identical prose.
    await page.evaluate(() => { document.getElementById('turn-4')!.id = 'turn-5'; });
    expect(await page.evaluate(replyScripts.wait)).toMatchObject({newReply: true, modelCount: 5, beforeSendCount: 5, replyId: 'turn-5'});
    // Removing older responses can even decrease the mounted count.
    await page.evaluate(() => { document.getElementById('turn-0')!.remove(); });
    expect(await page.evaluate(replyScripts.wait)).toMatchObject({newReply: true, modelCount: 4});
});
