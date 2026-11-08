import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v2Document } from './helpers/l4V2Fixtures.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import type { DisplayBlock } from '../src/l3b/ast/ast.js';

const table: Extract<DisplayBlock, { type: 'table' }> = {
    type: 'table', columnAlignments: ['default', 'default'],
    headerRows: [[
        { column: 0, colSpan: 1, rowSpan: 2, children: [{ type: 'text', text: 'Group' }] },
        { column: 1, colSpan: 1, rowSpan: 1, children: [{ type: 'text', text: 'Label' }] },
    ]],
    rows: [[{ column: 1, colSpan: 1, rowSpan: 1, children: [{ type: 'text', text: 'Value' }] }]],
};

test('HTML and Markdown keep a header rowspan crossing the first body row in one table rowgroup', () => {
    const doc = v2Document([table]);
    const html = renderDocumentHtml(doc, {}).html;
    const markdown = renderDocumentMarkdown(doc, {});
    for (const output of [html, markdown]) {
        assert.doesNotMatch(output, /<thead>/, 'a spanning cell cannot cross HTML rowgroup boundaries');
        assert.match(output, /<tbody>\s*<tr><th rowspan="2">Group<\/th><th>Label<\/th><\/tr>\s*<tr><td>Value<\/td><\/tr>\s*<\/tbody>/);
    }
});

test('ordinary HTML tables retain separate rowgroups while Markdown keeps GFM output', () => {
    const ordinary = { ...table, headerRows: table.headerRows.map(row => row.map(cell => ({ ...cell, rowSpan: 1 }))) };
    const doc = v2Document([ordinary]);
    const html = renderDocumentHtml(doc, {}).html;
    assert.match(html, /<thead>\s*<tr><th>Group<\/th><th>Label<\/th><\/tr>\s*<\/thead>/);
    assert.match(html, /<tbody>\s*<tr><td>Value<\/td><\/tr>\s*<\/tbody>/);
    const markdown = renderDocumentMarkdown(doc, {});
    assert.doesNotMatch(markdown, /<thead>|<tbody>/);
    assert.match(markdown, /\| Group \| Label \|\n\| --- \| --- \|\n\|  \| Value \|/);
});
