import { fixtureAccountFor } from './helpers/domainFixture.js';
import { useIndexStorage } from './helpers/indexStorage.js';
useIndexStorage();
import { historicalFixture } from './helpers/nativeFixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
import { TypstSandboxCompiler } from '../src/l4/format/pdf/typst/typstSandboxCompiler.js';
import { RealWasmSandboxHost, repoRoot } from './helpers/realWasmSandbox.js';
import { extractPdfText } from './helpers/pdfTextExtract.js';

for (const messages of [
    [{ role: 'model', model: '  Gemini 2.5 Pro  ', content: 'Answer' }],
    [{ role: 'assistant', author: { model: '  Gemini 2.5 Pro  ' }, content: 'Answer' }],
]) test('provider model survives Domain, JSON AST and all renderers: ' + JSON.stringify(messages[0]), () => {
    const raw = { id: 'model', messages }; const before = JSON.stringify(raw);
    const domain = historicalFixture(raw, { providerId: 'gemini' }).conversation;
    assert.equal(domain.detail.messages[0].model, 'Gemini 2.5 Pro');
    const document = JSON.parse(JSON.stringify(composeDomainDocument(domain, fixtureAccountFor(domain))));
    assert.equal(document.messages[0].modelLabel, 'Gemini 2.5 Pro');
    assert.match(renderDocumentHtml(document, {}).html, /gem-model-label">Gemini 2.5 Pro</);
    assert.match(renderDocumentMarkdown(document, {}), /Gemini 2\.5 Pro/);
    assert.equal(renderDocumentTypst(document, {}).messages[0].model, 'Gemini 2.5 Pro');
    assert.equal(JSON.stringify(raw), before);
});

test('turn models, absent/invalid models and escaped model names', () => {
    const domain = historicalFixture({ id: 'turn', turns: [{ userContent: 'Question', modelContent: 'Answer', model: 'GPT-5' }] }, { providerId: 'gemini' }).conversation;
    assert.equal(domain.detail.messages[0].model, undefined);
    assert.equal(domain.detail.messages[1].model, 'GPT-5');
    for (const model of [undefined, null, '', '  ', 42, {}]) {
        assert.ok(!('model' in historicalFixture({ messages: [{ role: 'model', model, content: '' }] }, { providerId: 'gemini' }).conversation.detail.messages[0]));
    }
    const document = composeDomainDocument(historicalFixture({ messages: [{ role: 'assistant', model: '<script>**x**</script>', content: '' }] }, { providerId: 'gemini' }).conversation, fixtureAccountFor(historicalFixture({ messages: [{ role: 'assistant', model: '<script>**x**</script>', content: '' }] }, { providerId: 'gemini' }).conversation));
    assert.match(renderDocumentHtml(document, {}).html, /&lt;script&gt;\*\*x\*\*&lt;\/script&gt;/);
    assert.match(renderDocumentMarkdown(document, {}), /&lt;script&gt;\\\*\\\*x\\\*\\\*&lt;\/script&gt;/);
});

test('compiled PDF visibly retains the model name', async () => {
    const document = composeDomainDocument(historicalFixture({ messages: [{ role: 'model', model: 'Gemini 2.5 Pro', content: 'Answer' }] }, { providerId: 'gemini' }).conversation, fixtureAccountFor(historicalFixture({ messages: [{ role: 'model', model: 'Gemini 2.5 Pro', content: 'Answer' }] }, { providerId: 'gemini' }).conversation));
    const compiler = new TypstSandboxCompiler({ host: new RealWasmSandboxHost(repoRoot()) });
    try {
        const result = await compiler.compile({ rendererSchemaVersion: 1, document: renderDocumentTypst(document, {}), assetPaths: new Map() }, {
            assets: { resolve: async () => null }, signal: new AbortController().signal, reportProgress: () => undefined,
        });
        assert.match(extractPdfText(result.pdfBytes).text, /Gemini 2\.5 Pro/);
    } finally { compiler.dispose(); }
});
