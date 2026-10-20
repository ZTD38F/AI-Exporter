export {};
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderCanonicalMarkdown } = require('../src/core/export/canonical/renderCanonicalMarkdown.js');
const { formatMarkdownCanonical } = require('../src/core/engine/chatFormatter.js');
const txt = (text: string) => ({ type: 'text', text });
const para = (text: string) => ({ id: 'p', type: 'paragraph', children: [txt(text)] });
function bundle(blocks: any[], extra: any = {}) {
    return { schemaVersion: 1, conversation: { key: { providerId: 'gemini', accountId: 'a', conversationId: 'c' }, title: 'Title', messages: [{ id: 'm', role: 'assistant', blocks }] }, assets: [], citations: [], ...extra };
}
const render = (blocks: any[], extra: any = {}) => renderCanonicalMarkdown(bundle(blocks, extra));

test('Markdown header uses Canonical metadata and omits absent optional fields', () => {
    const b = bundle([]); Object.assign(b.conversation, { url: 'https://example.com/chat', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' });
    const md = renderCanonicalMarkdown(b);
    assert.ok(md.startsWith('---\ntitle: "Title"\nid: "c"\nprovider: "gemini"\nurl: "https://example.com/chat"\ndate: "2026-01-01T00:00:00Z"\nupdated: "2026-01-02T00:00:00Z"\nexported: "'));
    assert.ok(md.includes('tags:\n  - gemini-export\n---\n\n# Title'));
    const minimal = render([]); assert.ok(!/^url:|^date:|^updated:/m.test(minimal));
});

test('Markdown paragraph preserves nested inline formatting and line breaks', () => {
    const md = render([{ id: 'p', type: 'paragraph', children: [txt('plain '), { type: 'strong', children: [{ type: 'emphasis', children: [txt('nested')] }] }, txt(' '), { type: 'strikethrough', children: [txt('gone')] }, { type: 'lineBreak', kind: 'soft' }, { type: 'inlineCode', code: 'x`y' }, { type: 'lineBreak', kind: 'hard' }, { type: 'link', href: 'https://example.com', children: [txt('link')] }] }]);
    assert.ok(md.includes('plain ***nested*** ~~gone~~\n``x`y``  \n[link](https://example.com)'));
});

test('Markdown emits headings and every message role in source order', () => {
    const b = bundle([{ id: 'h', type: 'heading', level: 3, children: [txt('Section')] }]);
    b.conversation.messages = ['user', 'assistant', 'system', 'developer', 'unknown'].map((role, i) => ({ id: `${i}`, role, blocks: b.conversation.messages[0].blocks }));
    const md = renderCanonicalMarkdown(b); const headings = ['## 👤 You', '## 🤖 Assistant', '## ⚙️ System', '## 🛠 Developer', '## Message'];
    assert.deepEqual(headings.map((h) => md.indexOf(h)), headings.map((h) => md.indexOf(h)).sort((a, b) => a - b));
    assert.ok(md.includes('### Section'));
});

test('Markdown nested lists preserve ordered start and multiline item indentation', () => {
    const md = render([{ id: 'l', type: 'list', ordered: true, start: 3, items: [{ blocks: [para('first'), { id: 'n', type: 'list', ordered: false, items: [{ blocks: [para('nested')] }] }] }, { blocks: [para('second')] }] }]);
    assert.ok(md.includes('3. first\n   \n   - nested\n4. second'));
});

test('Markdown quotes and thematic breaks serialize without losing nested text', () => {
    assert.ok(render([{ id: 'q', type: 'quote', blocks: [para('quote'), para('more')] }, { id: 'r', type: 'thematicBreak' }]).includes('> quote\n> \n> more\n\n---'));
});

test('Markdown code uses standard fences longer than embedded runs and labels metadata', () => {
    const md = render([{ id: 'code', type: 'code', code: '```\n# literal', language: 'md', filename: 'readme.md', meta: 'demo' }]);
    assert.ok(md.includes('**readme.md · demo**\n\n````md\n```\n# literal\n````'));
});

test('Markdown inline and display math use the original LaTeX source', () => {
    const md = render([{ id: 'p', type: 'paragraph', children: [{ type: 'inlineMath', source: '\\alpha' }] }, { id: 'm', type: 'math', source: '\\frac{a}{b}' }]);
    assert.ok(md.includes('$\\alpha$')); assert.ok(md.includes('$$\n\\frac{a}{b}\n$$'));
});

test('Markdown tables serialize alignment, captions, spans, pipes and newlines visibly', () => {
    const md = render([{ id: 't', type: 'table', caption: [txt('caption')], columns: [{ align: 'left' }, { align: 'right' }], headerRows: [{ cells: [{ children: [txt('A')] }, { children: [txt('B')] }] }], rows: [{ cells: [{ children: [txt('x|y\nz')], colSpan: 2 }] }] }]);
    assert.ok(md.includes('caption\n\n| A | B |\n| :--- | ---: |\n| x\\|y<br>z |  |'));
});

test('Markdown table separators preserve backslashes and formatted inline content', () => {
    const md = render([{ id: 't', type: 'table', rows: [{ cells: [{ children: [txt('a\\b|c '), { type: 'strong', children: [txt('bold')] }, { type: 'inlineCode', code: 'x|y' }] }] }] }]);
    assert.ok(md.includes('a\\\\b\\|c **bold**`x\\|y`'));
});

test('Markdown block and inline images use local storageRef only', () => {
    const md = render([{ id: 'i', type: 'image', assetId: 'a', alt: 'block', caption: [txt('caption')] }, { id: 'p', type: 'paragraph', children: [{ type: 'image', assetId: 'a', alt: 'inline' }] }], { assets: [{ id: 'a', kind: 'image', status: 'available', storageRef: 'assets/pic.png', sourceUrl: 'https://remote/pic.png' }] });
    assert.ok(md.includes('![block](assets/pic.png)\n\ncaption')); assert.ok(md.includes('![inline](assets/pic.png)')); assert.ok(!md.includes('https://remote'));
});

test('Markdown missing and remote-only images remain visible without remote embedding', () => {
    const md = render([{ id: 'i', type: 'image', assetId: 'a' }, { id: 'p', type: 'paragraph', children: [{ type: 'image', assetId: 'missing', alt: 'inline' }] }], { assets: [{ id: 'a', kind: 'image', status: 'remote', name: 'pic.png', sourceUrl: 'https://remote/pic.png' }] });
    assert.ok(md.includes('[Image unavailable: pic.png]')); assert.ok(md.includes('[Image unavailable: inline]')); assert.ok(!md.includes('https://remote'));
});

test('Markdown files use local links or a visible unavailable label', () => {
    const md = render([{ id: 'f', type: 'file', assetId: 'a', description: [txt('description')] }, { id: 'g', type: 'file', assetId: 'none', label: 'missing.pdf' }], { assets: [{ id: 'a', kind: 'file', status: 'available', name: 'file.pdf', storageRef: 'files/file.pdf' }] });
    assert.ok(md.includes('[file.pdf](files/file.pdf)\n\ndescription')); assert.ok(md.includes('[Attachment unavailable: missing.pdf]'));
});

test('Markdown thought blocks contain nested Markdown inside details', () => {
    assert.ok(render([{ id: 'th', type: 'thought', disclosure: 'providerExposed', kind: 'reasoning', blocks: [para('thinking')] }]).includes('<details>\n<summary>🧠 Thinking Process</summary>\n\nthinking\n\n</details>'));
});

test('Markdown inline citations link URLs and retain labels without URLs', () => {
    const md = render([{ id: 'p', type: 'paragraph', children: [{ type: 'citationRef', citationId: 'c', label: 'read' }, txt(' '), { type: 'citationRef', citationId: 'd', label: 'offline' }] }], { citations: [{ id: 'c', kind: 'web', title: 'Web', url: 'https://example.com' }, { id: 'd', kind: 'file', title: 'Local' }] });
    assert.ok(md.includes('[read](https://example.com) [offline]'));
});

test('Markdown message Sources preserve citation order after the body', () => {
    const b = bundle([para('body')], { citations: [{ id: 'c', kind: 'web', title: 'Web', url: 'https://example.com' }, { id: 'd', kind: 'file', title: 'Local' }] }); b.conversation.messages[0].citationIds = ['d', 'c'];
    assert.ok(renderCanonicalMarkdown(b).includes('body\n\n> 🌐 **Sources:**\n> [1] [Local]\n> [2] [Web](https://example.com)'));
});

test('Markdown unknown content remains visible as escaped text', () => {
    const md = render([{ id: 'u', type: 'unknown', sourceType: 'widget', text: '<script>opaque</script>' }]);
    assert.ok(md.includes('Unsupported · widget')); assert.ok(md.includes('&lt;script&gt;opaque&lt;/script&gt;')); assert.ok(!md.includes('<script>'));
});

test('Gemini structuredContent reaches Canonical Markdown without using the string body', async () => {
    const result = await formatMarkdownCanonical({ id: 'c', title: 'Structured', messages: [{ id: 'm', role: 'model', content: 'wrong string', structuredContent: { children: [{ nodeType: 18, text: 'structured answer' }] } }] });
    assert.ok(result.content.includes('structured answer')); assert.ok(!result.content.includes('wrong string'));
});

test('Gemini Markdown fallback reaches Canonical Markdown with semantic formatting', async () => {
    const result = await formatMarkdownCanonical({ id: 'c', title: 'Fallback', messages: [{ id: 'm', role: 'model', content: '**bold**\n\n```js\nconst x = 1;\n```' }] });
    assert.ok(result.content.includes('**bold**')); assert.ok(result.content.includes('```js\nconst x = 1;\n```'));
});

test('Markdown escapes unsafe links, local paths and YAML title boundaries', () => {
    const b = bundle([{ id: 'p', type: 'paragraph', children: [{ type: 'link', href: 'javascript:alert(1)', children: [txt('safe')] }, { type: 'image', assetId: 'a', alt: 'blocked' }] }], { assets: [{ id: 'a', kind: 'image', status: 'remote', storageRef: 'https://remote/pic.png' }] });
    b.conversation.title = 'Title"\nextra: yes'; const md = renderCanonicalMarkdown(b);
    assert.ok(md.includes('title: "Title\\" extra: yes"')); assert.ok(!md.includes('javascript:')); assert.ok(!md.includes('https://remote')); assert.ok(md.includes('[Image unavailable: blocked]'));
});

test('Canonical Markdown rejects duplicate message IDs like HTML and PDF', async () => {
    await assert.rejects(formatMarkdownCanonical({ id: 'c', messages: [{ id: 'm', role: 'user', content: 'one' }, { id: 'm', role: 'model', content: 'two' }] }), /MSG_DUP_ID/);
});


test('Markdown table pipe and backslash cases preserve two columns and visible content', async () => {
    const { fromMarkdown } = await import('mdast-util-from-markdown');
    const { gfm } = await import('micromark-extension-gfm');
    const { gfmFromMarkdown } = await import('mdast-util-gfm');
    const samples = [
        { node: txt('a|b'), text: 'a|b' },
        { node: txt('a\\|b'), text: 'a\\|b' },
        { node: txt('a\\\\|b'), text: 'a\\\\|b' },
        { node: { type: 'inlineCode', code: 'a|b' }, text: 'a|b' },
        { node: { type: 'inlineCode', code: 'a\\|b' }, text: 'a\\|b' },
        { node: { type: 'link', href: 'https://example.com', children: [txt('a|b')] }, text: 'a|b' },
    ];
    const md = render([{ id: 't', type: 'table', headerRows: [{ cells: [{ children: [txt('content')] }, { children: [txt('sentinel')] }] }],
        rows: samples.map(({ node }) => ({ cells: [{ children: [node] }, { children: [txt('kept')] }] })) }]);
    const tree = fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
    const table: any = tree.children.find((node: any) => node.type === 'table');
    const visible = (node: any): string => node.type === 'html' ? '' : typeof node.value === 'string' ? node.value : (node.children ?? []).map(visible).join('');
    assert.ok(table, 'serialized output parses as a GFM table');
    assert.strictEqual(table.children.length, samples.length + 1);
    samples.forEach(({ text }, index) => {
        const row = table.children[index + 1];
        assert.strictEqual(row.children.length, 2, `two columns for ${JSON.stringify(text)}`);
        assert.strictEqual(visible(row.children[0]), text);
        assert.strictEqual(visible(row.children[1]), 'kept');
    });
});
