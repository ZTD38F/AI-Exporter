import { fixtureKey, fixtureAccountFor } from './helpers/domainFixture.js';
import { restoreDomainSnapshot } from '../src/l2/runtimeValidation.js';
const { historicalFixture } = require('./helpers/nativeFixture.js');
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderDocumentMarkdown } = require('../src/l4/format/markdown/renderMarkdown.js');
const { composeDomainDocument } = require('../src/l3b/compose/composeDomainDocument.js');
const exportDomainMarkdown = (conversation: Parameters<typeof composeDomainDocument>[0], account: Parameters<typeof composeDomainDocument>[1]) => renderDocumentMarkdown(composeDomainDocument(conversation, account), {});
const renderFixtureMarkdown = (parsed: ReturnType<typeof historicalFixture>): string => renderDocumentMarkdown(composeDomainDocument(parsed.conversation, parsed.account), {});
const txt = (text: string) => ({ type: 'text', text });
const para = (text: string) => ({ type: 'paragraph', children: [txt(text)] });
function domainFixture(blocks: any[], extra: any = {}): DomainConversationWithDetail {
    return restoreDomainSnapshot({ index: { key: fixtureKey(String('c'), 'gemini'),   titleSource: "derived",   title: 'Title' }, detail: { key: fixtureKey(String('c'), 'gemini'), quality: { status: 'unknown' }, assets: extra.assets ?? [], messages: [{ id: 'm', role: 'assistant', content: blocks, reasoning: extra.reasoning, citations: extra.citations ?? [] }] } });
}
const render = (blocks: any[], extra: any = {}) => renderDocumentMarkdown(composeDomainDocument(domainFixture(blocks, extra), fixtureAccountFor(domainFixture(blocks, extra))), extra.resources ?? {});

test('Markdown code serialization preserves existing final newlines without adding a blank line', () => {
    for (const source of ['run()', 'run()\n', 'run()\n\n']) {
        const expected = '```python\n' + source + (source.endsWith('\n') ? '' : '\n') + '```';
        assert.ok(render([{ type: 'code', language: 'python', code: source }]).includes(expected));
    }
});

test('Markdown export envelope uses Domain metadata and omits absent optional fields', async () => {
    const b = domainFixture([]); Object.assign(b.index, { createdAt: Date.parse('2026-01-01T00:00:00Z') });
    const md = await exportDomainMarkdown({ ...b, index: { ...b.index, updatedAt: Date.parse('2026-01-02T00:00:00Z') } }, fixtureAccountFor({ ...b, index: { ...b.index, updatedAt: Date.parse('2026-01-02T00:00:00Z') } }));
    assert.ok(md.startsWith('---\ntitle: "Title"\nid: "c"\nprovider: "gemini"\ndate: "2026-01-01T00:00:00.000Z"\nupdated: "2026-01-02T00:00:00.000Z"\ntags:'));
    assert.ok(md.includes('tags:\n  - gemini-export\n---\n\n# Title'));
    const minimal = await exportDomainMarkdown(domainFixture([]), fixtureAccountFor(domainFixture([]))); assert.ok(!/^url:|^date:|^updated:/m.test(minimal));
});

test('Markdown paragraph preserves nested inline formatting and line breaks', () => {
    const md = render([{ type: 'paragraph', children: [txt('plain '), { type: 'strong', children: [{ type: 'emphasis', children: [txt('nested')] }] }, txt(' '), { type: 'strikethrough', children: [txt('gone')] }, { type: 'lineBreak', kind: 'soft' }, { type: 'inlineCode', code: 'x`y' }, { type: 'lineBreak', kind: 'hard' }, { type: 'link', href: 'https://example.com', children: [txt('link')] }] }]);
    assert.ok(md.includes('plain ***nested*** ~~gone~~\n``x`y``  \n[link](https://example.com/)'));
});

test('Markdown emits headings and every message role in source order', () => {
    const b = domainFixture([{ type: 'heading', level: 3, children: [txt('Section')] }]);
    b.detail.messages = (['user', 'assistant', 'system', 'developer', 'unknown'] as const).map((role, i) => ({ id: `${i}`, role, content: b.detail.messages[0].content }));
    const md = renderDocumentMarkdown(composeDomainDocument(b, fixtureAccountFor(b)), {}); const headings = ['## 👤 You', '## 🤖 Assistant', '## ⚙️ System', '## 🛠 Developer', '## Message'];
    assert.deepEqual(headings.map((h) => md.indexOf(h)), headings.map((h) => md.indexOf(h)).sort((a, b) => a - b));
    assert.ok(md.includes('### Section'));
});

test('Markdown nested lists preserve ordered start and multiline item indentation', () => {
    const md = render([{ type: 'list', ordered: true, start: 3, items: [{ blocks: [para('first'), { type: 'list', ordered: false, items: [{ blocks: [para('nested')] }] }] }, { blocks: [para('second')] }] }]);
    assert.ok(md.includes('3. first\n   \n   - nested\n4. second'));
});

test('Markdown quotes and thematic breaks serialize without losing nested text', () => {
    assert.ok(render([{ type: 'quote', blocks: [para('quote'), para('more')] }, { type: 'thematicBreak' }]).includes('> quote\n> \n> more\n\n---'));
});

test('Markdown code uses standard fences longer than embedded runs and labels metadata', () => {
    const md = render([{ type: 'code', code: '```\n# literal', language: 'md', meta: 'demo' }]);
    assert.ok(md.includes('**demo**\n\n````md\n```\n# literal\n````'));
});

test('Markdown inline and display math use the original LaTeX source', () => {
    const md = render([{ type: 'paragraph', children: [{ type: 'inlineMath', source: '\\alpha' }] }, { type: 'math', source: '\\frac{a}{b}' }]);
    assert.ok(md.includes('$\\alpha$')); assert.ok(md.includes('$$\n\\frac{a}{b}\n$$'));
});

test('Markdown tables serialize alignment, captions, spans, pipes and newlines visibly', () => {
    const md = render([{ type: 'table', caption: [txt('caption')], columns: [{ align: 'left' }, { align: 'right' }], headerRows: [{ cells: [{ children: [txt('A')] }, { children: [txt('B')] }] }], rows: [{ cells: [{ children: [txt('x|y\nz')], colSpan: 2 }] }] }]);
    assert.ok(md.includes('<table>') && md.includes('<caption>caption</caption>'));
    assert.ok(md.includes('<td colspan="2">x|y\nz</td>'), 'merged cell and its original text are preserved');
});

test('Markdown table separators preserve backslashes and formatted inline content', () => {
    const md = render([{ type: 'table', rows: [{ cells: [{ children: [txt('a\\b|c '), { type: 'strong', children: [txt('bold')] }, { type: 'inlineCode', code: 'x|y' }] }] }] }]);
    assert.ok(md.includes('a\\\\b\\|c **bold**`x\\|y`'));
});

test('Markdown block and inline images use prepared local bindings only', () => {
    const md = render([{ type: 'image', assetId: 'a', alt: 'block', caption: [txt('caption')] }, { type: 'paragraph', children: [{ type: 'image', assetId: 'a', alt: 'inline' }] }], { assets: [{ id: 'a', kind: 'image', sourceUri: 'https://remote/pic.png' }], resources: { a: 'assets/pic.png' } });
    assert.ok(md.includes('![block](assets/pic.png)\n\ncaption')); assert.ok(md.includes('![inline](assets/pic.png)')); assert.ok(!md.includes('https://remote'));
});

test('Markdown missing and remote-only images remain visible without remote embedding', () => {
    const md = render([{ type: 'image', assetId: 'a' }, { type: 'paragraph', children: [{ type: 'image', assetId: 'missing', alt: 'inline' }] }], { assets: [{ id: 'a', kind: 'image', name: 'pic.png', sourceUri: 'https://remote/pic.png' }, { id: 'missing', kind: 'image' }] });
    assert.ok(md.includes('[Image unavailable: pic.png]')); assert.ok(md.includes('[Image unavailable: inline]')); assert.ok(!md.includes('https://remote'));
});

test('Markdown files use local links or a visible unavailable label', () => {
    const md = render([{ type: 'file', assetId: 'a', description: [txt('description')] }, { type: 'file', assetId: 'none', label: 'missing.pdf' }], { assets: [{ id: 'a', kind: 'file', name: 'file.pdf' }, { id: 'none', kind: 'file', name: 'missing.pdf' }], resources: { a: 'files/file.pdf' } });
    assert.ok(md.includes('[file.pdf](files/file.pdf)\n\ndescription')); assert.ok(md.includes('[Attachment unavailable: missing.pdf]'));
});

test('Markdown thought blocks contain nested Markdown inside details', () => {
    assert.ok(render([], { reasoning: [para('thinking')] }).includes('<details>\n<summary>Thinking Process</summary>\n\nthinking\n\n</details>'));
});

test('Markdown inline citations link URLs and retain labels without URLs', () => {
    const md = render([{ type: 'paragraph', children: [{ type: 'citationRef', citationId: 'c', label: 'read' }, txt(' '), { type: 'citationRef', citationId: 'd', label: 'offline' }] }], { citations: [{ id: 'c', title: 'Web', url: 'https://example.com' }, { id: 'd', title: 'Local' }] });
    assert.ok(md.includes('[read](https://example.com/) [offline]'));
});

test('Markdown message Sources preserve citation order after the body', () => {
    const b = domainFixture([para('body')], { citations: [{ id: 'c', title: 'Web', url: 'https://example.com' }, { id: 'd', title: 'Local' }] }); b.detail.messages[0].citations!.reverse();
    assert.ok(renderDocumentMarkdown(composeDomainDocument(b, fixtureAccountFor(b)), {}).includes('body\n\n> 🌐 **Sources:**\n> [1] [Local]\n> [2] [Web](https://example.com/)'));
});

test('Markdown unknown content remains visible as escaped text', () => {
    const md = render([{ type: 'unknown', sourceType: 'widget', text: '<script>opaque</script>' }]);
    assert.ok(md.includes('Unsupported · widget')); assert.ok(md.includes('&lt;script&gt;opaque&lt;/script&gt;')); assert.ok(!md.includes('<script>'));
});

test('Gemini structuredContent reaches Document Markdown without using the string body', async () => {
    const result = renderFixtureMarkdown(historicalFixture({ id: 'c', title: 'Structured', messages: [{ id: 'm', role: 'model', content: 'wrong string', structuredContent: { children: [{ nodeType: 18, text: 'structured answer' }] } }] }));
    assert.ok(result.includes('structured answer')); assert.ok(!result.includes('wrong string'));
});

test('Gemini Markdown fallback reaches Document Markdown with semantic formatting', async () => {
    const result = renderFixtureMarkdown(historicalFixture({ id: 'c', title: 'Fallback', messages: [{ id: 'm', role: 'model', content: '**bold**\n\n```js\nconst x = 1;\n```' }] }));
    assert.ok(result.includes('**bold**')); assert.ok(result.includes('```js\nconst x = 1;\n```'));
});

test('Markdown escapes unsafe links, local paths and YAML title boundaries', async () => {
    const b = domainFixture([{ type: 'paragraph', children: [{ type: 'link', href: 'javascript:alert(1)', children: [txt('safe')] }, { type: 'image', assetId: 'a', alt: 'blocked' }] }], { assets: [{ id: 'a', kind: 'image', sourceUri: 'https://remote/pic.png' }] });
    b.index.title = 'Title"\nextra: yes'; const md = await exportDomainMarkdown({ ...b, index: { ...b.index, updatedAt: Date.parse('2026-01-02T00:00:00Z') } }, fixtureAccountFor({ ...b, index: { ...b.index, updatedAt: Date.parse('2026-01-02T00:00:00Z') } }));
    assert.equal(md.split('\n')[1], 'title: ' + JSON.stringify(b.index.title)); assert.ok(!md.includes('javascript:')); assert.ok(!md.includes('https://remote')); assert.ok(md.includes('[Image unavailable: blocked]'));
});

test('Document Markdown preserves both messages with duplicate source IDs', async () => {
    const result = renderFixtureMarkdown(historicalFixture({ id: 'c', messages: [{ id: 'm', role: 'user', content: 'one' }, { id: 'm', role: 'model', content: 'two' }] }));
    assert.ok(result.includes('one'));
    assert.ok(result.includes('two'));
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
    const md = render([{ type: 'table', headerRows: [{ cells: [{ children: [txt('content')] }, { children: [txt('sentinel')] }] }],
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
