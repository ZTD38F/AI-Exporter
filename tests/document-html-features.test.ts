import { fixtureKey, fixtureAccountFor } from './helpers/domainFixture.js';
export {};
const test = require('node:test');
const assert = require('node:assert');

const { renderDocumentHtml } = require('../src/l4/format/html/renderHtml.js');
const { composeDomainDocument } = require('../src/l3b/compose/composeDomainDocument.js');

function domainFixture(messages: any[], assets: any[] = []) {
    return { index: { key: fixtureKey(String('c1'), 'gemini'),   titleSource: "derived",   title: 't' }, detail: { key: fixtureKey(String('c1'), 'gemini'), quality: { status: 'unknown' }, assets, messages } };
}

function msg(blocks: any[]) {
    return { id: 'm1', role: 'assistant', content: blocks };
}

function text(s: string) {
    return { type: 'text', text: s };
}

const resources = { a1: 'https://example.com/a.png' };

test('image card shows caption', () => {
    const b = domainFixture(
        [msg([{ type: 'image', assetId: 'a1', alt: 'pic', caption: [text('A nice view')] }])],
        [{ id: 'a1', kind: 'image', name: 'a.png' }],
    );
    const out = renderDocumentHtml(composeDomainDocument(b, fixtureAccountFor(b)), resources);
    assert.ok(out.html.includes('gem-att-caption'));
    assert.ok(out.html.includes('A nice view'));
});

test('file card shows description', () => {
    const b = domainFixture(
        [msg([{ type: 'file', assetId: 'a2', label: 'notes.pdf', description: [text('Q3 planning doc')] }])],
        [{ id: 'a2', kind: 'file', name: 'notes.pdf' }],
    );
    const out = renderDocumentHtml(composeDomainDocument(b, fixtureAccountFor(b)), resources);
    assert.ok(out.html.includes('gem-att-desc'));
    assert.ok(out.html.includes('Q3 planning doc'));
});

test('code header prefers filename, shows meta', () => {
    const withName = domainFixture([msg([{ type: 'code', code: 'x=1', language: 'python', filename: 'app.py', meta: '±2 lines' }])]);
    const out = renderDocumentHtml(composeDomainDocument(withName, fixtureAccountFor(withName)), resources);
    const blockHtml = out.html.slice(out.html.indexOf('<div class="gem-code-block">'));
    assert.ok(blockHtml.includes('>python<'));
    assert.ok(blockHtml.includes('class="gem-code-meta"'));
    assert.ok(blockHtml.includes('±2 lines'));

    const bare = domainFixture([msg([{ type: 'code', code: 'x=1', language: 'python' }])]);
    const out2 = renderDocumentHtml(composeDomainDocument(bare, fixtureAccountFor(bare)), resources);
    const bareHtml = out2.html.slice(out2.html.indexOf('<div class="gem-code-block">'));
    assert.ok(bareHtml.includes('>python</span>'));
    assert.ok(!bareHtml.includes('class="gem-code-meta"'));
});

test('table honors column alignment', () => {
    const cell = (s: string) => ({ children: [text(s)] });
    const b = domainFixture([msg([{
        type: 'table',
        columns: [{ align: 'left' }, { align: 'center' }, { align: 'right' }],
        headerRows: [{ cells: [cell('A'), cell('B'), cell('C')] }],
        rows: [{ cells: [cell('1'), cell('2'), cell('3')] }],
    }])]);
    const out = renderDocumentHtml(composeDomainDocument(b, fixtureAccountFor(b)), resources);
    assert.ok(out.html.includes('<th style="text-align:left">A</th>'));
    assert.ok(out.html.includes('<th style="text-align:center">B</th>'));
    assert.ok(out.html.includes('<th style="text-align:right">C</th>'));
    assert.ok(out.html.includes('<td style="text-align:center">2</td>'));
});

test('table without columns renders no alignment styles', () => {
    const cell = (s: string) => ({ children: [text(s)] });
    const b = domainFixture([msg([{
        type: 'table',
        rows: [{ cells: [cell('1'), cell('2')] }],
    }])]);
    const out = renderDocumentHtml(composeDomainDocument(b, fixtureAccountFor(b)), resources);
    const tableHtml = out.html.slice(out.html.indexOf('<table class="gem-table">'), out.html.indexOf('</table>'));
    assert.ok(!tableHtml.includes('text-align'));
});
