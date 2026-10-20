export {};
const test = require('node:test');
const assert = require('node:assert');

const { renderCanonicalHtml } = require('../src/core/export/canonical/renderCanonicalHtml.js');

function bundle(messages: any[], assets: any[] = []) {
    return {
        schemaVersion: 1,
        conversation: {
            key: { providerId: 'gemini', accountId: 't', conversationId: 'c1' },
            title: 't',
            createdAt: '2026-09-20T10:00:00Z',
            messages,
        },
        assets,
        citations: [],
    };
}

function msg(blocks: any[]) {
    return { id: 'm1', role: 'model', blocks };
}

function text(s: string) {
    return { type: 'text', text: s };
}

const assetOpts = { assetUrl: (_a: any) => 'https://example.com/a.png' };

test('image card shows caption', () => {
    const b = bundle(
        [msg([{ id: 'i1', type: 'image', assetId: 'a1', alt: 'pic', caption: [text('A nice view')] }])],
        [{ id: 'a1', kind: 'image', name: 'a.png' }],
    );
    const out = renderCanonicalHtml(b, assetOpts);
    assert.ok(out.html.includes('gem-att-caption'));
    assert.ok(out.html.includes('A nice view'));
});

test('file card shows description', () => {
    const b = bundle(
        [msg([{ id: 'f1', type: 'file', assetId: 'a2', label: 'notes.pdf', description: [text('Q3 planning doc')] }])],
        [{ id: 'a2', kind: 'file', name: 'notes.pdf' }],
    );
    const out = renderCanonicalHtml(b, assetOpts);
    assert.ok(out.html.includes('gem-att-desc'));
    assert.ok(out.html.includes('Q3 planning doc'));
});

test('code header prefers filename, shows meta', () => {
    const withName = bundle([msg([{ id: 'c1', type: 'code', code: 'x=1', language: 'python', filename: 'app.py', meta: '±2 lines' }])]);
    const out = renderCanonicalHtml(withName, {});
    const blockHtml = out.html.slice(out.html.indexOf('<div class="gem-code-block">'));
    assert.ok(blockHtml.includes('>app.py · python<'));
    assert.ok(blockHtml.includes('class="gem-code-meta"'));
    assert.ok(blockHtml.includes('±2 lines'));

    const bare = bundle([msg([{ id: 'c2', type: 'code', code: 'x=1', language: 'python' }])]);
    const out2 = renderCanonicalHtml(bare, {});
    const bareHtml = out2.html.slice(out2.html.indexOf('<div class="gem-code-block">'));
    assert.ok(bareHtml.includes('>python</span>'));
    assert.ok(!bareHtml.includes('class="gem-code-meta"'));
});

test('table honors column alignment', () => {
    const cell = (s: string) => ({ children: [text(s)] });
    const b = bundle([msg([{
        id: 't1', type: 'table',
        columns: [{ align: 'left' }, { align: 'center' }, { align: 'right' }],
        headerRows: [{ cells: [cell('A'), cell('B'), cell('C')] }],
        rows: [{ cells: [cell('1'), cell('2'), cell('3')] }],
    }])]);
    const out = renderCanonicalHtml(b, {});
    assert.ok(out.html.includes('<th style="text-align:left">A</th>'));
    assert.ok(out.html.includes('<th style="text-align:center">B</th>'));
    assert.ok(out.html.includes('<th style="text-align:right">C</th>'));
    assert.ok(out.html.includes('<td style="text-align:center">2</td>'));
});

test('table without columns renders no alignment styles', () => {
    const cell = (s: string) => ({ children: [text(s)] });
    const b = bundle([msg([{
        id: 't1', type: 'table',
        rows: [{ cells: [cell('1'), cell('2')] }],
    }])]);
    const out = renderCanonicalHtml(b, {});
    const tableHtml = out.html.slice(out.html.indexOf('<table class="gem-table">'), out.html.indexOf('</table>'));
    assert.ok(!tableHtml.includes('text-align'));
});
