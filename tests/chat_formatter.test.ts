export {};
const test = require('node:test');
const assert = require('node:assert');
const ChatFormatter = require('../src/core/engine/chatFormatter.js');

test('chat_formatter - formatMarkdownCanonical', async () => {
    const mockChat = {
        id: '12345678',
        title: 'Quantum Physics Guide',
        url: 'https://gemini.google.com/app/12345678',
        timestamp: 1700000000000,
        messages: [
            { role: 'user', content: 'What is superposition?' },
            { role: 'model', content: 'Superposition is a fundamental principle of quantum mechanics.' }
        ]
    };

    const res = await ChatFormatter.formatMarkdownCanonical(mockChat);
    assert.strictEqual(res.ext, 'md');
    // Frontmatter structure assertions
    assert.ok(res.content.startsWith('---\n'), 'Markdown must start with YAML frontmatter delimiter');
    assert.ok(res.content.includes('\n---\n\n'), 'YAML frontmatter must close with --- delimiter');
    assert.ok(res.content.includes('title: "Quantum Physics Guide"'), 'Frontmatter must contain title key');
    assert.ok(res.content.includes('id: "12345678"'), 'Frontmatter must contain id key');
    assert.ok(res.content.includes('url: "https://gemini.google.com/app/12345678"'), 'Frontmatter must contain url key');
    assert.ok(res.content.includes('tags:\n  - gemini-export'), 'Frontmatter must contain gemini-export tag');
    // Heading and content assertions
    assert.ok(res.content.includes('# Quantum Physics Guide'), 'Must render H1 title');
    assert.ok(res.content.includes('What is superposition?'), 'Must contain user message');
    assert.ok(res.content.includes('Superposition is a fundamental principle'), 'Must contain model message');
    // Role ordering assertion
    const userIdx = res.content.search(/## 👤/);
    const modelIdx = res.content.search(/## 🤖/);
    assert.ok(userIdx !== -1 && modelIdx !== -1, 'Must include both user and model role headings');
    assert.ok(userIdx < modelIdx, 'User heading must precede model heading');
});

test('chat_formatter - formatContent json_openai', () => {
    const mockChat = {
        id: '12345678',
        title: 'Test',
        messages: [
            { role: 'user', content: 'Hello' },
            { role: 'model', content: 'Hi there!' }
        ]
    };

    const res = ChatFormatter.formatContent(mockChat, 'json_openai');
    assert.strictEqual(res.ext, 'json');
    const parsed = JSON.parse(res.content);
    assert.strictEqual(parsed.messages.length, 2);
    assert.strictEqual(parsed.messages[0].role, 'user');
    assert.strictEqual(parsed.messages[0].content, 'Hello');
    assert.strictEqual(parsed.messages[1].role, 'assistant');
    assert.strictEqual(parsed.messages[1].content, 'Hi there!');
});

test('chat_formatter - convertHtmlToMarkdown converts html elements safely', () => {
    const rawHtml = '<p>Here is a code snippet:</p><pre><code class="language-js">console.log(&quot;hello&quot;);</code></pre><p>And some <b>bold</b> and <i>italic</i> text with <br/>break.</p>';
    const md = ChatFormatter.convertHtmlToMarkdown(rawHtml);
    assert.ok(md.includes('```js'), 'Code block should have language');
    assert.ok(md.includes('console.log("hello");'), 'Entities should be unescaped');
    assert.ok(md.includes('**bold**'), 'Bold should be markdown');
    assert.ok(md.includes('*italic*'), 'Italic should be markdown');
    const fenceCount = (md.match(/```/g) || []).length;
    assert.strictEqual(fenceCount % 2, 0, 'Code fence backticks must be properly paired');
});

test('htmlConverter preserves emphasis on strong and em tags with attributes', () => {
    const { convertHtmlToMarkdown } = require('../src/core/engine/formatters/htmlConverter.js');
    assert.strictEqual(convertHtmlToMarkdown('<strong class="x">bold</strong>'), '**bold**');
    assert.strictEqual(convertHtmlToMarkdown('<em data-x="1">italics</em>'), '*italics*');
});

test('chat_formatter - convertHtmlToMarkdown converts html tables to GFM tables', () => {
    const tableHtml = '<table><thead><tr><th align="left">维度</th><th align="left">经典</th><th align="left">量子</th></tr></thead><tbody><tr><td>状态</td><td>0 或 1</td><td>叠加态<br>|psi></td></tr></tbody></table>';
    const md = ChatFormatter.convertHtmlToMarkdown(tableHtml);
    assert.ok(md.includes('| 维度 | 经典 | 量子 |'), 'Table header should be converted');
    assert.ok(md.includes('| --- | --- | --- |'), 'Table separator should be present');
    assert.ok(md.includes('| 状态 | 0 或 1 | 叠加态<br>\\|psi> |'), 'Table cells with pipe and br should be properly formatted');
    assert.ok(/\|\s*:?-{3,}:?\s*\|/.test(md), 'Matches table markdown regex');
});

test('engine - AsyncQueue supports concurrent queueing, abort signals, and closing', async () => {
    const { AsyncQueue } = require('../src/core/engine/export/exportOrchestrator.js');
    const q = new AsyncQueue();
    assert.strictEqual(q.length, 0);

    const popPromise1 = q.pop();
    q.push('item1');
    const res1 = await popPromise1;
    assert.strictEqual(res1, 'item1');

    const ac = new AbortController();
    const popPromise2 = q.pop(ac.signal);
    ac.abort();
    const res2 = await popPromise2;
    assert.strictEqual(res2, null, 'Aborted pop must resolve to null');

    const popPromise3 = q.pop();
    q.close();
    const res3 = await popPromise3;
    assert.strictEqual(res3, null, 'Closing queue must resolve waiters to null');
    assert.strictEqual(await q.pop(), null, 'Pop on closed queue must return null');
});

test('engine - BatchWorker.resolveChat skips bad brand titles and preserves user sniff', async () => {
    const BatchWorker = require('../src/core/engine/export/batchWorker.js');
    const chat = {
        id: 'test_123',
        title: 'Google Gemini',
        titles: { rpc: 'Google Gemini', sniff: '如何设计微服务架构' },
        titleSource: 'sniff'
    };
    const listConv = {
        id: 'test_123',
        title: '如何设计微服务架构',
        titles: { rpc: 'Google Gemini', sniff: '如何设计微服务架构' },
        titleSource: 'sniff'
    };

    const resolved = await BatchWorker.resolveChat(
        chat as any,
        { id: 'test_123', title: '如何设计微服务架构' },
        listConv as any,
        null,
        'u0',
        () => {},
        () => {}
    );

    assert.strictEqual(resolved.isError, false);
    assert.notStrictEqual(resolved.listTitle, 'Google Gemini');
    assert.strictEqual(resolved.listTitle, '如何设计微服务架构');
});

test('engine - RateLimiter detects 429 status and calculates backoff with jitter', () => {
    const { RateLimitManager, isRateLimited, calculateBackoff } = require('../src/core/engine/export/rateLimiter.js');
    assert.strictEqual(isRateLimited({ status: 429 }), true);
    assert.strictEqual(isRateLimited({ error: 'RESOURCE_EXHAUSTED: Rate limit exceeded' }), true);
    assert.strictEqual(isRateLimited({ error: 'Too many requests, quota exceeded' }), true);
    assert.strictEqual(isRateLimited({ success: true } as any), false);
    assert.strictEqual(isRateLimited({ status: 200 }), false);
    assert.strictEqual(isRateLimited(null), false);

    const b0 = calculateBackoff(0, { initialDelayMs: 1000, jitterMs: 200, maxDelayMs: 5000 });
    assert.ok(b0 >= 1000 && b0 <= 1200, `Expected b0 between 1000 and 1200, got ${b0}`);

    const manager = new RateLimitManager({ initialDelayMs: 500, maxDelayMs: 2000, jitterMs: 100 });
    assert.strictEqual(manager.rateLimitCooldownUntil, 0);
    manager.recordRateLimit(1500);
    assert.ok(manager.rateLimitCooldownUntil > Date.now());
    manager.reset();
    assert.strictEqual(manager.rateLimitCooldownUntil, 0);
});

test('engine - SessionRecovery.updateSessionStatus updates chrome.storage.local safely', async () => {
    const SessionRecovery = require('../src/core/engine/export/sessionRecovery.js');
    assert.strictEqual(typeof SessionRecovery.updateSessionStatus, 'function');

    const origChrome = (global as any).chrome;
    let storedSession: any = { status: 'running', slot: 'u0', current: 1 };
    (global as any).chrome = {
        storage: {
            local: {
                get: async (_keys: any) => ({ gemini_last_export_session: storedSession }),
                set: async (obj: any) => {
                    if (obj.gemini_last_export_session) {
                        storedSession = obj.gemini_last_export_session;
                    }
                }
            }
        }
    };

    try {
        await SessionRecovery.updateSessionStatus({ current: 2, status: 'completed' });
        assert.strictEqual(storedSession.current, 2);
        assert.strictEqual(storedSession.status, 'completed');
        assert.ok(typeof storedSession.updatedAt === 'number');
    } finally {
        (global as any).chrome = origChrome;
    }
});

test('chat_formatter - natural language prompt > 400 chars with code keywords is never mangled into javascript fence', async () => {
    const longPrompt = 'Please explain the following architectural concepts in detail. In JavaScript and TypeScript, developers often ask why const and let were introduced to replace var in ES6, and how lexical scoping works with closures inside a function() declaration. ' + 'Extra discussion text for length padding. '.repeat(10);
    assert.ok(longPrompt.length > 400);
    const mockChat = {
        id: 'natural_lang_prompt_test',
        title: 'Variable Scoping',
        messages: [
            { role: 'user', content: longPrompt },
            { role: 'model', content: 'Here is the detailed explanation of const vs var.' }
        ]
    };
    const res = await ChatFormatter.formatMarkdownCanonical(mockChat);
    assert.ok(!res.content.includes('```javascript\nPlease explain'), 'Natural language prompt must not be wrapped in javascript code block');
    assert.ok(res.content.includes('Please explain the following architectural concepts'), 'Prompt content must remain plain text');
});

test('chat_formatter - decoupled formatters export valid focused functions', async () => {
    const { toOpenAIJson, toJsonStandard, toJsonRaw } = require('../src/core/engine/formatters/jsonFormatter.js');
    const { convertHtmlToMarkdown } = require('../src/core/engine/formatters/htmlConverter.js');

    assert.strictEqual(typeof toOpenAIJson, 'function');
    assert.strictEqual(typeof toJsonStandard, 'function');
    assert.strictEqual(typeof toJsonRaw, 'function');
    assert.strictEqual(typeof convertHtmlToMarkdown, 'function');

    const testChat = { id: 'c1', title: 'Test', messages: [{ role: 'user', content: 'hello' }] };
    assert.ok((await ChatFormatter.formatMarkdownCanonical(testChat)).content.includes('title: "Test"'));
    assert.throws(() => ChatFormatter.formatContent(testChat, 'markdown'), /unsupported format/);
    assert.ok(toOpenAIJson(testChat).includes('"content": "hello"'));
    assert.ok(toJsonStandard(testChat).includes('"id": "c1"'));
    assert.ok(convertHtmlToMarkdown('<b>bold</b>').includes('**bold**'));
});




test('chat_formatter - legacy chats without provider keep Gemini presentation exactly', () => {
    const chat = {
        id: 'c_legacy123',
        title: 'Legacy Gemini',
        timestamp: 1700000000000,
        messages: [
            { role: 'user', content: 'Hello' },
            { role: 'model', content: 'Hi' }
        ]
    };

    const md = ChatFormatter.toMarkdown(chat, { lang: 'en' });
    assert.ok(md.includes('url: "https://gemini.google.com/app/legacy123"'));
    assert.ok(md.includes('  - gemini-export'));
    assert.ok(md.includes('## 🤖 Gemini'));
    assert.ok(!md.includes('## 🤖 ChatGPT'));
});

test('chat_formatter - ChatGPT presentation uses ChatGPT URL, tag and assistant heading', () => {
    const chat = {
        providerId: 'chatgpt',
        id: 'chatgpt-uuid-123',
        title: 'ChatGPT Example',
        timestamp: 1700000000000,
        messages: [
            { role: 'user', content: 'Question' },
            { role: 'model', content: 'Answer' }
        ]
    };

    const md = ChatFormatter.toMarkdown(chat, { lang: 'en' });
    assert.ok(md.includes('url: "https://chatgpt.com/c/chatgpt-uuid-123"'));
    assert.ok(md.includes('  - chatgpt-export'));
    assert.ok(md.includes('## 🤖 ChatGPT'));
    assert.ok(!md.includes('## 🤖 Gemini'));
    assert.ok(!md.includes('https://gemini.google.com/'));
});

test('chat_formatter - explicit URL wins over provider fallback URL', () => {
    const chat = {
        providerId: 'chatgpt',
        id: 'chatgpt-uuid-123',
        url: 'https://chatgpt.com/share/custom-link',
        title: 'Explicit URL',
        timestamp: 1700000000000,
        messages: [{ role: 'user', content: 'Question' }]
    };

    const md = ChatFormatter.toMarkdown(chat, { lang: 'en' });
    assert.ok(md.includes('url: "https://chatgpt.com/share/custom-link"'));
    assert.ok(!md.includes('https://chatgpt.com/c/chatgpt-uuid-123'));
});

test('chat_formatter - array thoughts render without .trim crash', () => {
    const chat = {
        providerId: 'chatgpt',
        id: 'reasoning-1',
        title: 'Reasoning',
        timestamp: 1700000000000,
        messages: [
            {
                role: 'model',
                content: 'Final answer',
                thoughts: ['First thought', 'Second thought']
            }
        ]
    };

    const md = ChatFormatter.toMarkdown(chat, { lang: 'en' });
    assert.ok(md.includes('First thought'));
    assert.ok(md.includes('Second thought'));

    const json = JSON.parse(ChatFormatter.toOpenAIJson(chat));
    assert.strictEqual(json.messages[0].reasoning_content, 'First thought\n\nSecond thought');
});

test('chat_formatter - OpenAI JSON preserves system role instead of rewriting it as user', () => {
    const chat = {
        providerId: 'chatgpt',
        id: 'system-1',
        title: 'System',
        messages: [
            { role: 'system', providerRole: 'tool', content: 'Tool output' },
            { role: 'user', content: 'Question' },
            { role: 'model', content: 'Answer' }
        ]
    };

    const json = JSON.parse(ChatFormatter.toOpenAIJson(chat));
    assert.deepStrictEqual(json.messages.map((m: any) => m.role), ['system', 'user', 'assistant']);
    assert.strictEqual(json.url, 'https://chatgpt.com/c/system-1');

    const md = ChatFormatter.toMarkdown(chat, { lang: 'en' });
    assert.ok(md.includes('## ⚙️ System'));
    assert.ok(md.includes('Provider role: `tool`'));
    assert.ok(md.includes('## 🤖 ChatGPT'));
});
