import { useIndexStorage } from './helpers/indexStorage.js';
useIndexStorage();
import { indexFixture } from './helpers/indexFixture.js';
const { historicalFixture } = require('./helpers/nativeFixture.js');
export {};
import test from 'node:test';
const assert = require('node:assert');
import { composeFixture } from './helpers/documentFixture.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { serializeDomainJson } from '../src/l4/format/json/serializeDomainJson.js';
import { convertHtmlToMarkdown } from '../src/l1/parsers/shared/html/htmlToMarkdown.js';
import { runExport } from '../src/application/export/runExport.js';
import { v2ExportHost, exportRequest, exportKey, seedExportConversation } from './helpers/v2ExportHost.js';
import { getExportRecord } from '../src/l3a/storageService.js';

test('chat_formatter - formatMarkdownDocument', async () => {
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

    const { document, resources } = await composeFixture(historicalFixture(mockChat).conversation);
    const markdown = renderDocumentMarkdown(document, resources);
    assert.ok(markdown.startsWith('---\n'), 'Markdown must start with YAML frontmatter delimiter');
    assert.ok(markdown.includes('\n---\n\n'), 'YAML frontmatter must close with --- delimiter');
    assert.ok(markdown.includes('title: "Quantum Physics Guide"'), 'Frontmatter must contain title key');
    assert.ok(markdown.includes('id: "12345678"'), 'Frontmatter must contain id key');
    assert.ok(!/^url:/m.test(markdown), 'Composer does not synthesize a source URL');
    assert.ok(markdown.includes('tags:\n  - gemini-export'), 'Frontmatter must contain gemini-export tag');
    assert.ok(markdown.includes('# Quantum Physics Guide'), 'Must render H1 title');
    assert.ok(markdown.includes('What is superposition?'), 'Must contain user message');
    assert.ok(markdown.includes('Superposition is a fundamental principle'), 'Must contain model message');
    const userIdx = markdown.search(/## 👤/);
    const modelIdx = markdown.search(/## 🤖/);
    assert.ok(userIdx !== -1 && modelIdx !== -1, 'Must include both user and model role headings');
    assert.ok(userIdx < modelIdx, 'User heading must precede model heading');
});


test('chat_formatter - convertHtmlToMarkdown converts html elements safely', () => {
    const rawHtml = '<p>Here is a code snippet:</p><pre><code class="language-js">console.log(&quot;hello&quot;);</code></pre><p>And some <b>bold</b> and <i>italic</i> text with <br/>break.</p>';
    const md = convertHtmlToMarkdown(rawHtml);
    assert.ok(md.includes('```js'), 'Code block should have language');
    assert.ok(md.includes('console.log("hello");'), 'Entities should be unescaped');
    assert.ok(md.includes('**bold**'), 'Bold should be markdown');
    assert.ok(md.includes('*italic*'), 'Italic should be markdown');
    const fenceCount = (md.match(/```/g) || []).length;
    assert.strictEqual(fenceCount % 2, 0, 'Code fence backticks must be properly paired');
});

test('htmlConverter preserves emphasis on strong and em tags with attributes', () => {
    const { convertHtmlToMarkdown } = require('../src/l1/parsers/shared/html/htmlToMarkdown.js');
    assert.strictEqual(convertHtmlToMarkdown('<strong class="x">bold</strong>'), '**bold**');
    assert.strictEqual(convertHtmlToMarkdown('<em data-x="1">italics</em>'), '*italics*');
});

test('chat_formatter - convertHtmlToMarkdown converts html tables to GFM tables', () => {
    const tableHtml = '<table><thead><tr><th align="left">维度</th><th align="left">经典</th><th align="left">量子</th></tr></thead><tbody><tr><td>状态</td><td>0 或 1</td><td>叠加态<br>|psi></td></tr></tbody></table>';
    const md = convertHtmlToMarkdown(tableHtml);
    assert.ok(md.includes('| 维度 | 经典 | 量子 |'), 'Table header should be converted');
    assert.ok(md.includes('| --- | --- | --- |'), 'Table separator should be present');
    assert.ok(md.includes('| 状态 | 0 或 1 | 叠加态<br>\\|psi> |'), 'Table cells with pipe and br should be properly formatted');
    assert.ok(/\|\s*:?-{3,}:?\s*\|/.test(md), 'Matches table markdown regex');
});

test('engine - unified export processes a batch, honors abort and completes an empty batch', async t => {
    const host = v2ExportHost(t);
    for (const id of ['queue-one', 'queue-two']) await seedExportConversation(id);
    const controller = new AbortController(); controller.abort();
    assert.equal((await runExport(exportRequest(['queue-one']), { signal: controller.signal })).aborted, true);
    assert.equal(host.clicks(), 0);
    assert.equal((await runExport(exportRequest([]))).exported, 0);
    assert.equal(host.clicks(), 0);
    const result = await runExport(exportRequest(['queue-one']));
    assert.equal(result.exported, 1); assert.equal(host.clicks(), 1);
});

test('engine - L1 rejects a brand placeholder while L2 preserves the derived user question title', async () => {
    const { ingestIndexes } = require('../src/l2/ingestion.js');
    const { getIndex } = require('../src/l3a/storageService.js');
    const { parseGeminiIndexObservation } = require('../src/l1/parsers/gemini/parseIndexObservation.js');
    const key = exportKey('test_123');
    await ingestIndexes(key.accountId, [{ conversationId: key.conversationId,
        fields: { title: '如何设计微服务架构', titleSource: 'derived' } }]);
    await ingestIndexes(key.accountId, [parseGeminiIndexObservation({ id: key.conversationId,
        title: 'Google Gemini', titleSource: 'rpc' }, 'rpc-list')]);
    assert.equal((await getIndex(key))?.title, '如何设计微服务架构');
});



test('engine - completion persists the delivered source version without a recovery session', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('completion', 100);
    const result = await runExport(exportRequest(['completion']));
    assert.equal(result.exported, 1); assert.equal(host.clicks(), 1);
    const record = await getExportRecord(exportKey('completion'));
    assert.equal(record?.chatTime, 100); assert.equal(record?.status, 'ok');
    assert.equal(Number.isSafeInteger(record?.exportedAt), true);
    const local = await chrome.storage.local.get(null);
    assert.equal(Object.hasOwn(local, 'gemini_last_export_session'), false);
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
    const { document, resources } = await composeFixture(historicalFixture(mockChat).conversation);
    const markdown = renderDocumentMarkdown(document, resources);
    assert.ok(!markdown.includes('```javascript\nPlease explain'), 'Natural language prompt must not be wrapped in javascript code block');
    assert.ok(markdown.includes('Please explain the following architectural concepts'), 'Prompt content must remain plain text');
});

test('focused formatters consume their declared inputs: Document AST for Markdown and trusted Domain for JSON', async () => {
    const parsed = historicalFixture({ id: 'c1', title: 'Test', messages: [{ role: 'user', content: 'hello' }] });
    const { document, resources } = await composeFixture(parsed.conversation);
    assert.ok(renderDocumentMarkdown(document, resources).includes('title: "Test"'));
    assert.ok(serializeDomainJson(parsed.conversation, parsed.account, {}).includes('"conversationId": "c1"'));
    assert.ok(convertHtmlToMarkdown('<b>bold</b>').includes('**bold**'));
});
