import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertHtmlToMarkdown } from '../src/l1/parsers/shared/html/htmlToMarkdown.js';

const tableLines = (html: string) => convertHtmlToMarkdown(html).trim().split('\n');

test('LPC-03: a later row wider than the header retains every cell', () => {
    const rows = tableLines('<table><tr><th>Header</th></tr>'
        + '<tr><td>First</td><td>Second</td><td>Third</td></tr></table>');
    assert.deepEqual(rows, [
        '| Header |  |  |',
        '| --- | --- | --- |',
        '| First | Second | Third |',
    ]);
});

test('LPC-03: colspan occupies the right number of columns without dropping later rows', () => {
    const rows = tableLines('<table><tr><th colspan="2">Group</th><th>Final</th></tr>'
        + '<tr><td>One</td><td>Two</td><td>Three</td><td>Four</td></tr>'
        + '<tr><td colspan=2>Pair</td><td>Tail</td></tr></table>');
    assert.deepEqual(rows, [
        '| Group |  | Final |  |',
        '| --- | --- | --- | --- |',
        '| One | Two | Three | Four |',
        '| Pair |  | Tail |  |',
    ]);
});

test('LPC-03: rowspan reserves its occupied column in the next row', () => {
    const rows = tableLines("<table><tr><th rowspan='2'>Group</th><th>Metric</th></tr>"
        + '<tr><th>Value</th></tr>'
        + '<tr><td>A</td><td>10</td></tr></table>');
    assert.deepEqual(rows, [
        '| Group | Metric |',
        '| --- | --- |',
        '|  | Value |',
        '| A | 10 |',
    ]);
});

test('LPC-03: ordinary table and pipe escaping remain unchanged', () => {
    const rows = tableLines('<table><tr><th>A</th><th>B</th></tr>'
        + '<tr><td>left | right</td><td>two<br>lines</td></tr></table>');
    assert.deepEqual(rows, [
        '| A | B |',
        '| --- | --- |',
        '| left \\| right | two<br>lines |',
    ]);
});
