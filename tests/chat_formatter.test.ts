export {};
const test = require('node:test');
const assert = require('node:assert');
const ChatFormatter = require('../src/core/engine/chatFormatter.js');

test('chat_formatter - formatContent markdown', () => {
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

    const res = ChatFormatter.formatContent(mockChat, 'markdown');
    assert.strictEqual(res.ext, 'md');
    assert.ok(res.content.includes('# Quantum Physics Guide'));
    assert.ok(res.content.includes('What is superposition?'));
    assert.ok(res.content.includes('Superposition is a fundamental principle'));
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
});

test('chat_formatter - adjustHeadingHierarchy shifts headings outside code blocks', () => {
    const md = '# Title\n## Subtitle\n```\n# Not a heading\n```\n### Inner';
    const shifted = ChatFormatter.adjustHeadingHierarchy(md, 2);
    const lines = shifted.split('\n');
    assert.strictEqual(lines[0], '### Title');
    assert.strictEqual(lines[1], '#### Subtitle');
    assert.strictEqual(lines[3], '# Not a heading');
    assert.strictEqual(lines[5], '##### Inner');
});

test('chat_formatter - cleanMessageBody strips placeholder urls and chips', () => {
    const text = 'Hello world\nhttps://googleusercontent.com/immersive_entry_chip/12345\nNext line';
    const cleaned = ChatFormatter.cleanMessageBody(text);
    assert.ok(!cleaned.includes('immersive_entry_chip'), 'Immersive chip url should be stripped');
    assert.ok(cleaned.includes('Hello world'));
    assert.ok(cleaned.includes('Next line'));
});

test('chat_formatter - renderAttachments renders images and file attachments', () => {
    const atts = [
        { type: 'image', localName: 'assets/cat.png', alt: 'Cute cat', src: 'https://images.google.com/cat.png' },
        { type: 'file', localName: 'files/data.csv', name: 'data.csv', title: 'Data File' }
    ];
    const rendered = ChatFormatter.renderAttachments(atts, true);
    assert.ok(rendered.includes('![Cute cat](assets/cat.png)'), 'Image markdown should be rendered');
    assert.ok(rendered.includes('- 📎 [Data File](files/data.csv)'), 'File attachment should be rendered');
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


