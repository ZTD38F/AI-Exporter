/** L4 HTML unit tests: L3b's frozen v2 DocumentAst is a fixture, not a live composer. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v2Document } from './helpers/l4V2Fixtures.js';
import type { ResourceBindings } from '../src/l4/packaging/resourceBindings.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';

test('HTML uses the supplied v2 AST and prepared offline file destination unchanged', () => {
    const document = v2Document([
        { type: 'paragraph', children: [{ type: 'text', text: 'look at this' }] },
        { type: 'file', resourceId: 'file-1', label: 'x.pdf', kind: 'file' },
    ], { title: 'HTML export', role: 'user' });
    const resources: ResourceBindings = { 'file-1': 'files/x.pdf' };
    const before = JSON.stringify(document);
    const result = renderDocumentHtml(document, resources);
    assert.ok(result.html.startsWith('<!DOCTYPE html>'));
    assert.match(result.html, /href="files\/x.pdf"/);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(JSON.stringify(document), before, 'L4 must not mutate its upstream AST fixture');
    assert.ok(!JSON.stringify(document).includes('files/x.pdf'), 'export paths are Packaging-owned');
});
test('HTML missing v2 resource binding emits a visible fallback and diagnostic', () => {
    const document = v2Document([
        { type: 'paragraph', children: [{ type: 'text', text: 'file below' }] },
        { type: 'file', resourceId: 'missing-file', kind: 'file', label: 'y.pdf' },
    ]);
    const result = renderDocumentHtml(document, {});
    assert.ok(result.html.includes('gem-missing-asset'));
    assert.ok(result.html.includes('y.pdf'));
    assert.equal(result.diagnostics.filter(d => d.code === 'HTML_ASSET_UNRESOLVED').length, 1);
});
