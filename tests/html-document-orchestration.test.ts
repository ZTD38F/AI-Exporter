/** Public HTML orchestration and the pure Document AST backend. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFixture } from './helpers/documentFixture.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';
test('HTML export returns the delivery contract and uses prepared offline destinations', async () => {
    const raw = { id: 'html', title: 'HTML export', messages: [{ role: 'user', content: 'look at this', attachments: [{ type: 'image', localName: 'assets/x.png', name: 'x.png' }] }] };
    const { domain, document, resources } = await parseFixture(raw);
    const result = renderDocumentHtml(document, resources);
    assert.ok(result.html.startsWith('<!DOCTYPE html>'));
    assert.ok(result.html.includes('assets/x.png'));
    assert.deepEqual([...collectDocumentResources(document).referencedIds], [domain.detail.assets[0].id]);
    assert.equal(resources[domain.detail.assets[0].id], 'assets/x.png');
    assert.ok(!JSON.stringify(domain).includes('assets/x.png'));
});
test('unprepared resources remain visible and carry an explicit backend diagnostic', async () => {
    const { document } = await parseFixture({ id: 'missing', messages: [{ role: 'model', content: 'file below', attachments: [{ type: 'file', name: 'y.pdf' }] }] });
    const result = renderDocumentHtml(document, {});
    assert.ok(result.html.includes('gem-missing-asset'));
    assert.ok(result.html.includes('y.pdf'));
    assert.equal(result.diagnostics.filter(d => d.code === 'HTML_ASSET_UNRESOLVED').length, 1);
});
