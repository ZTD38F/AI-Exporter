/**
 * tests/html_export.test.ts
 * HTML export via the production canonical path
 * (ChatFormatter.formatHtmlCanonical: normalizeGeminiConversation ->
 * CanonicalHtmlRenderer).
 *
 * Item 2 (P0): the legacy sync toHtml() / formatContent(chat, 'html') path
 * was removed; these tests now exercise the canonical renderer, which
 * shares GEM_HTML_CSS / GEM_HTML_SCRIPT / sanitizeUrl from htmlTemplate.ts.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const ChatFormatter = require('../src/core/engine/chatFormatter.js');

test('html_export - formatHtmlCanonical returns valid structure, metadata, and styles', async () => {
    const mockChat = {
        id: 'chat_html_test_123',
        title: 'Quantum Computing & Algorithms',
        url: 'https://gemini.google.com/app/chat_html_test_123',
        createdAt: 1700000000000,
        messages: [
            {
                role: 'user',
                content: 'What is Grover\'s algorithm?\n\nPlease explain the quadratic speedup.',
                attachments: [
                    {
                        type: 'image',
                        localName: 'assets/grover_circuit.png',
                        name: 'grover_circuit.png'
                    },
                    {
                        type: 'file',
                        localName: 'assets/quantum_notes.pdf',
                        name: 'quantum_notes.pdf',
                        title: 'quantum_notes.pdf'
                    }
                ]
            },
            {
                role: 'model',
                thoughts: 'Analyzing quantum search complexity and amplitude amplification principles...',
                content: 'Grover\'s algorithm provides a quadratic speedup for unstructured search.\n\n### Complexity Comparison\n\n| Algorithm | Classical | Quantum (Grover) |\n|---|---|---|\n| Search | $O(N)$ | $O(\\sqrt{N})$ |\n\nHere is a simple example in Python:\n\n```python\ndef grover_iterations(n):\n    import math\n    return int(math.pi / 4 * math.sqrt(n))\n```\n\nKey advantage is amplitude amplification.'
            }
        ]
    };

    const res = await ChatFormatter.formatHtmlCanonical(mockChat);
    assert.strictEqual(res.ext, 'html');
    assert.strictEqual(res.mime, 'text/html');

    const html = res.content;

    // 1. Valid HTML5 Doctype & Meta
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'Must start with <!DOCTYPE html>');
    assert.ok(html.includes('<title>Quantum Computing &amp; Algorithms</title>'), 'Title must be safely escaped in <title>');
    assert.ok(html.includes('generator" content="Gemini Exporter"'), 'Must contain generator meta');

    // 2. High fidelity Print Stylesheet (@media print) & Pure 1:1 Stream
    assert.ok(html.includes('@media print'), 'Must include @media print styles for PDF readiness');
    assert.ok(!html.includes('gem-top-bar'), 'Must NOT contain top bar to keep 1:1 fidelity');
    assert.ok(html.includes('prefers-color-scheme'), 'Must support adaptive system theme');

    // 3. User Turn & Attachments
    assert.ok(html.includes('gem-turn-user'), 'Must contain user turn section');
    assert.ok(html.includes('gem-user-bubble'), 'Must contain user bubble');
    assert.ok(html.includes("What is Grover&#39;s algorithm?"), 'Must contain user text escaped');
    assert.ok(!html.includes('gem-carousel-wrapper'), 'Must NOT render attachment carousel');
    assert.ok(html.includes('gem-image-block'), 'Must render image attachment block');
    assert.ok(html.includes('assets/grover_circuit.png'), 'Must link image attachment to assets/ path');
    assert.ok(html.includes('assets/quantum_notes.pdf'), 'Must link file attachment to assets/ path');
    assert.ok(html.includes('download="quantum_notes.pdf"'), 'File card must include download attribute');

    // 4. Model Turn: Thoughts, Table, Code Block, Math
    assert.ok(html.includes('gem-turn-model'), 'Must contain model turn section');
    assert.ok(html.includes('gem-thoughts'), 'Must contain thoughts accordion');
    assert.ok(html.includes('amplitude amplification principles'), 'Must contain thoughts text');
    assert.ok(html.includes('gem-table'), 'Must render markdown table');
    assert.ok(html.includes('<th>Algorithm</th>'), 'Must render table header cell');
    assert.ok(html.includes('<td>Search</td>'), 'Must render table data cell');
    assert.ok(html.includes('gem-code-block'), 'Must render code block container');
    assert.ok(html.includes('gem-copy-btn'), 'Must render copy code button');
    assert.ok(html.includes('grover_iterations'), 'Must contain code block content');
    assert.ok(html.includes('gem-math-inline'), 'Must format inline math');

    // 5. Clean Layout Assertions: Zero sidebar, zero bottom chat input, zero reaction bars
    assert.ok(!html.includes('class="sidebar"'), 'Must NOT contain sidebar');
    assert.ok(!html.includes('id="chat-input"'), 'Must NOT contain chat input box');
    assert.ok(!html.includes('thumb_up'), 'Must NOT contain thumbs up/down buttons');
});

test('html_export - supports English localization and handles empty conversation', async () => {
    const emptyChat = {
        id: 'empty_chat_001',
        title: 'Empty Session',
        messages: []
    };

    const resEn = await ChatFormatter.formatHtmlCanonical(emptyChat, { lang: 'en' });
    assert.ok(resEn.content.includes('lang="en"'), 'HTML lang attribute must be en');
    assert.ok(resEn.content.includes('Empty conversation or fetch failed.'), 'Must render English empty notice');

    const resZh = await ChatFormatter.formatHtmlCanonical(emptyChat, { lang: 'zh' });
    assert.ok(resZh.content.includes('lang="zh-CN"'), 'HTML lang attribute must be zh-CN');
    assert.ok(resZh.content.includes('暂无对话记录或拉取失败。'), 'Must render Chinese empty notice');
});

test('html_export - XSS protection escapes malicious tags', async () => {
    const attackChat = {
        id: 'xss_test',
        title: '<script>alert("hacked")</script>',
        messages: [
            {
                role: 'user',
                content: '<img src=x onerror=alert(1)>'
            }
        ]
    };

    const res = await ChatFormatter.formatHtmlCanonical(attackChat);
    assert.ok(!res.content.includes('<script>alert("hacked")</script>'), 'Title script tags must be escaped');
    assert.ok(res.content.includes('&lt;script&gt;alert(&quot;hacked&quot;)&lt;/script&gt;'), 'Title must be HTML encoded');
});

test('html_export - XSS pseudo-protocols in markdown links are disarmed to safe href', async () => {
    const attackChat = {
        id: 'xss_link_test',
        title: 'Safe Title',
        messages: [
            {
                role: 'user',
                content: '[Click Evil](javascript:alert("pwned")) and [Data Link](data:text/html,<script>alert(1)</script>) and [Safe Link](https://example.com)'
            },
            {
                role: 'model',
                content: '[![Evil Image](javascript:alert(2))](vbscript:msgbox(1)) and ![Good Image](https://example.com/pic.png)'
            }
        ]
    };

    const res = await ChatFormatter.formatHtmlCanonical(attackChat);
    const html = res.content;
    assert.ok(!html.includes('href="javascript:'), 'Must NOT contain javascript: in href');
    assert.ok(!html.includes('href="vbscript:'), 'Must NOT contain vbscript: in href');
    assert.ok(!html.includes('href="data:text/html'), 'Must NOT contain data:text/html in href');
    assert.ok(!html.includes('src="javascript:'), 'Must NOT contain javascript: in src');
    assert.ok(html.includes('href="https://example.com"'), 'Valid https links must be preserved');
    // Canonical renderer is offline-first: remote asset bytes are never
    // embedded, so a remote image renders a visible missing-asset placeholder
    // (alt text kept) instead of a remote <img src>.
    assert.ok(!html.includes('src="https://example.com/pic.png"'), 'Must NOT leak remote asset URLs into src');
    assert.ok(html.includes('gem-missing-inline'), 'Remote image must render a visible placeholder');
    assert.ok(html.includes('Good Image'), 'Placeholder must keep the alt text visible');
});
