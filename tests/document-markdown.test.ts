import { fixtureAccountFor } from './helpers/domainFixture.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { API } from 'typescript/unstable/sync';
import { markdownBoundaryViolations } from './helpers/markdownBoundary.js';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
import type { DocumentAst } from '../src/l3b/ast/ast.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';

function fixture(): DomainConversationWithDetail {
    return JSON.parse(readFileSync('tests/fixtures/document-domain/document-markdown.json', 'utf8'));
}

function freeze(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    Object.freeze(value); Object.values(value).forEach(freeze);
}

test('Markdown backend preserves merged table cells while the neutral tree retains all headers', () => {
    const input = fixture(); const before = JSON.stringify(input); freeze(input);
    const composed = composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input)));
    assert.deepEqual(composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input))), composed);
    assert.equal(JSON.stringify(input), before);
    const table = composed.messages[0].blocks.find(block => block.type === 'table')!; assert.equal(table.type, 'table');
    if (table.type !== 'table') throw new Error('Expected table');
    assert.equal(table.headerRows.length, 2); assert.equal(table.rows.length, 1);
    assert.equal(table.headerRows[0][0].colSpan, 2); assert.equal(table.headerRows[0][0].rowSpan, 2);
    const md = renderDocumentMarkdown(composed, { a: 'assets/a.png' });
    assert.ok(md.includes('<table>') && md.includes('colspan="2"') && md.includes('rowspan="2"'));
    assert.ok(md.includes('Second header'), 'all authored table headers remain visible');
});

test('Markdown consumes only JSON display choices, explicit time and prepared paths', () => {
    const document = composeDomainDocument(validateParserDomain(fixture()), fixtureAccountFor(validateParserDomain(fixture())));
    const restored: DocumentAst = JSON.parse(JSON.stringify(document));
    const resources = { a: 'assets/a.png' };
    assert.equal(renderDocumentMarkdown(restored, resources), renderDocumentMarkdown(document, resources));
    const md = renderDocumentMarkdown(restored, resources);
    assert.ok(!md.includes('exported:')); assert.ok(md.includes('**123**'));
    assert.equal(md.match(/!\[/g)?.length, 2); assert.ok(md.includes('Preserved description'));
    restored.messages[0].role = 'developer';
    restored.messages[0].sources = [{ id: 'ignored', label: 'Chosen source', number: 7 }];
    const disclosure = restored.messages[0].blocks.find(block => block.type === 'disclosure');
    if (!disclosure || disclosure.type !== 'disclosure') throw new Error('Expected disclosure');
    disclosure.title = 'Chosen disclosure';
    const changed = renderDocumentMarkdown(restored, resources);
    assert.ok(changed.includes('## 🛠 Developer')); assert.ok(changed.includes('> 🌐 **Sources:**\n> [7] [Chosen source]'));
    assert.ok(changed.includes('<details>\n<summary>Chosen disclosure</summary>'), 'disclosures are collapsed by default');
    assert.ok(renderDocumentMarkdown(document, {}).includes('[Image unavailable:'));
    assert.ok(renderDocumentHtml(document, resources).html.includes('<strong>123</strong>'));
});

test('Markdown renderer owns unavailability and emits diagnostics without remote embedding', () => {
    const document = composeDomainDocument(validateParserDomain(fixture()), fixtureAccountFor(validateParserDomain(fixture())));
    const output = renderDocumentMarkdown(document, {});
    assert.ok(output.includes('[Image unavailable:')); assert.ok(output.includes('**123**'));
    assert.ok(!output.includes('https://remote'));
    assert.deepEqual(composeDomainDocument(validateParserDomain(fixture()), fixtureAccountFor(validateParserDomain(fixture()))), document);
});

test('Markdown renderer cannot depend on provider, Domain or storage services', () => {
    const code = readFileSync('src/l4/format/markdown/renderMarkdown.ts', 'utf8');
    const path = resolve('src/l4/format/markdown/renderMarkdown.ts');
    const api = new API({ cwd: process.cwd() });
    try {
        const snapshot = api.updateSnapshot({ openFiles: [path] });
        const source = snapshot.getDefaultProjectForFile(path)?.program.getSourceFile(path);
        assert.ok(source, 'compiler must parse the actual renderer');
        assert.deepEqual(markdownBoundaryViolations(source), []);
        snapshot.dispose();
    } finally { api.close(); }
    assert.doesNotMatch(code, /\bDate\.now\s*\(/, 'renderers must not invent export timestamps');
    assert.doesNotMatch(code, /\.storageRef\b/, 'renderers must not inspect storage-only fields');
});

test('Markdown front matter reads identity and source dates only from Document AST', () => {
    const input = fixture(); input.index.updatedAt = 1000;
    const document = composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input)));
    document.title = 'true';
    document.metadata!.id = 'null';
    const markdown = renderDocumentMarkdown(document, {});
    assert.ok(markdown.includes('title: "true"'));
    assert.ok(markdown.includes('id: "null"'));
    assert.ok(!/^url:/m.test(markdown), 'L3b metadata no longer supplies provider URLs');
    assert.ok(markdown.includes('updated: "1970-01-01T00:00:01.000Z"'));
    assert.ok(!/^exported:/m.test(markdown), 'renderer must not invent an export timestamp');
    // @ts-expect-error Metadata is required; still reject malformed runtime callers explicitly.
    assert.throws(() => renderDocumentMarkdown({ ...document, metadata: undefined }, {}), /metadata is required/);
});

test('Markdown math fences outgrow source dollar runs without changing ordinary formulas', () => {
    const input = fixture();
    const document = composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input)));
    for (const [source, fence] of [
        ['x = 1\n$$\ny = 2', '$$$'],
        ['x = 1\n$$$$\ny = 2', '$$$$$'],
        ['E = mc^2', '$$'],
    ]) {
        document.messages[0].blocks = [{ type: 'math', source }];
        const markdown = renderDocumentMarkdown(document, {});
        assert.ok(markdown.includes(fence + '\n' + source + '\n' + fence), 'math source needs safe fence ' + fence);
    }
});

test('Markdown dependency gate rejects independent syntax and path bypasses without matching inert text', () => {
    const forbidden = [
        `import '../../../l1/parsers/gemini/rpc/parseConversation.js';`,
        `const load = () => import('../../../l2/conversation.js');`,
        `const storage = require('../../../l3a/storageService.js');`,
        `import storage = require('../../../l3a/storageService.js');`,
        `export { getIndex as read } from '../../../l3a/storageService.js';`,
        `export * from '../../../l2/conversation.js';`,
        `import { getIndex as read } from '../../../l3a/storageService.js';`,
        `import { value } from '../../../shared/../l2/conversation.js';`,
        'const load = () => import(`../../../l2/conversation.js`);',
        `import { type DomainMessage, value } from '../../../l2/conversation.js';`,
        `const load = (path: string) => import(path);`,
    ];
    const safe = [
        `import type { DomainMessage } from '../../../l2/conversationDetail.js';`,
        `import { type DomainMessage } from '../../../l2/conversationDetail.js';`,
        `import type Domain = require('../../../l2/conversation.js');`,
        `type Message = import('../../../l2/conversationDetail.js').DomainMessage;`,
        `export type { DomainMessage } from '../../../l2/conversationDetail.js';`,
        `export { type DomainMessage } from '../../../l2/conversationDetail.js';`,
        `import { renderDocumentMarkdown as render } from './renderMarkdown.js';`,
        `// import '../../../l2/conversation.js';\nconst text = "require('../../../l3a/storageService.js')";`,
    ];
    const cases = [...forbidden, ...safe];
    const virtual = new Map(cases.map((source, index) => [resolve(`tests/__markdown_boundary_${index}.ts`), source]));
    const api = new API({ cwd: process.cwd(), fs: {
        readFile: path => virtual.get(path), fileExists: path => virtual.has(path) ? true : undefined,
    } });
    try {
        const snapshot = api.updateSnapshot({ openFiles: [...virtual.keys()] });
        let index = 0;
        for (const [path, code] of virtual) {
            const source = snapshot.getDefaultProjectForFile(path)?.program.getSourceFile(path);
            assert.ok(source);
            const violations = markdownBoundaryViolations(source);
            if (index++ < forbidden.length) assert.ok(violations.length, code);
            else assert.deepEqual(violations, [], code);
        }
        snapshot.dispose();
    } finally { api.close(); }
});
