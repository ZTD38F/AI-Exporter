import { decodeGeminiStructuredPayload as decodeBody } from '../src/l1/parsers/gemini/rpc/structuredContent.js';
import { fixtureKey, fixtureAccountFor } from './helpers/domainFixture.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { decodeGeminiStructuredNode, decodeGeminiStructuredPayload } from '../src/l1/parsers/gemini/rpc/structuredContent.js';
import { parseGeminiBody } from '../src/l1/parsers/gemini/shared/contentAdapter.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';

test('captured execution panels survive structured RPC, Domain and physical Markdown grammar with exact code/stdout', () => {
    const fixture = JSON.parse(readFileSync('tests/fixtures/provider/gemini_execution_nodes.json', 'utf8')) as { nodes: [{ '39': [string, string, number, null, number] }][] };
    const content = parseGeminiBody('', decodeGeminiStructuredPayload(fixture.nodes) ?? undefined);
    assert.equal(content.length, 2);
    assert.ok(content.every(node => node.type === 'code'));
    const domain: DomainConversationWithDetail = { index: { key: fixtureKey(String('execution'), 'gemini'),   titleSource: "derived",   title: 'Execution' }, detail: { key: fixtureKey(String('execution'), 'gemini'), quality: { status: 'unknown' }, assets: [], messages: [{ id: 'm', role: 'assistant', content }] } };
    const serialized = renderDocumentMarkdown(composeDomainDocument(validateParserDomain(domain), fixtureAccountFor(validateParserDomain(domain))), {});
    const result = spawnSync('node', ['scripts/framework/markdown_evidence.mjs'], { input: JSON.stringify(serialized), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout) as { executionBlocks: { code: string; stdout: string }[]; codeBlocks: string[] };
    const canonical = (text: string) => text.replace(/^\n+|\n+$/g, '');
    assert.deepEqual(evidence.executionBlocks.map(event => ({ code: canonical(event.code), stdout: canonical(event.stdout) })), [{ code: canonical(fixture.nodes[0][0]['39'][0]), stdout: canonical(fixture.nodes[1][0]['39'][0]) }]);
    assert.deepEqual(evidence.codeBlocks, []);
});
test('unrecognized execution extension layouts fall back rather than inventing source or hiding body', () => {
    for (const event of [[], ['code', 'python', 1, null, 2], ['code', 'python', 0, null, 0], ['code', 'python\nunsafe', 1, null, 0]]) {
        assert.equal(decodeGeminiStructuredNode([{ '39': event }]), null);
    }
    assert.deepEqual(decodeGeminiStructuredNode([{ 'attachment': [] }]), { nodeType: 0 });
    const visible = parseGeminiBody('Visible provider reply', decodeBody({ children: [{ nodeType: 999 }] }) ?? undefined);
    assert.ok(visible.some(block => block.type === 'paragraph' && block.children.some(node =>
        node.type === 'text' && node.text === 'Visible provider reply')),
    'unknown structured extension must not replace the raw visible response');
});
