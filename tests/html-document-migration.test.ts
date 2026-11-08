import { fixtureResourceResults } from './helpers/documentFixture.js';
const { historicalFixture } = require('./helpers/nativeFixture.js');
const { fixtureAccountFor } = require('./helpers/domainFixture.js');
const { composeDomainDocument } = require('../src/l3b/compose/composeDomainDocument.js');
const { renderDocumentHtml } = require('../src/l4/format/html/renderHtml.js');
/**
 * tests/html-document-migration.test.ts
 * Item 1 (P0): the Domain -> Document AST -> HTML interface preserves all content classes.
 *
 * History: this file originally compared the legacy toHtml() output with
 * the new production entry as migration evidence. Item 2 (P0) removed the
 * legacy toHtml() pipeline entirely; the remaining assertions verify the
 * Composer/Renderer boundary directly: turn count/order and no dropped content
 * class (text, attachments, images, thought, code, table, citation).
 * Not pixel-perfect: tags/styles may differ.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

async function renderFixture(native: ReturnType<typeof historicalFixture>) {
    const results = await fixtureResourceResults(native.conversation, native.resourceHints, native.acquisitionHints);
    const resources = Object.fromEntries(results.map(result => [result.resourceId, result.value.path]));
    return renderDocumentHtml(composeDomainDocument(native.conversation, fixtureAccountFor(native.conversation)), resources);
}

const chat: any = {
    id: 'migrate_001',
    title: 'HTML Canonical Migration',
    url: 'https://gemini.google.com/app/migrate_001',
    messages: [
        {
            role: 'user',
            content: 'Please analyze this screenshot and the attached report. The **key metric** is `delta = 42`.',
            attachments: [
                { type: 'image', localName: 'assets/screen.png', name: 'screen.png', mimeType: 'image/png' },
                { type: 'file', localName: 'assets/report.pdf', name: 'report.pdf', title: 'report.pdf' },
            ],
            images: [
                { localName: 'assets/inline-photo.jpg', fileName: 'inline-photo.jpg' },
            ],
        },
        {
            role: 'model',
            thoughts: 'The user wants analysis. Verify the numbers in the table before answering.',
            content: [
                '## Analysis',
                '',
                'The screenshot shows a **rising** trend with `delta = 42`.',
                '',
                '```python',
                'def trend(xs):',
                '    return sum(xs) / len(xs)',
                '```',
                '',
                '| Metric | Value |',
                '|---|---|',
                '| delta | 42 |',
                '| trend | rising |',
                '',
                'See [1] for the raw dataset.',
            ].join('\n'),
            citations: [{ title: 'Raw dataset', url: 'https://example.com/dataset.csv' }],
        },
        {
            role: 'user',
            content: 'Thanks. Now explain the `trend` function step by step.',
        },
        {
            role: 'model',
            content: '1. It sums the values.\n2. It divides by the count.\n\nDone — nothing else to add.',
        },
    ],
};

/** Role sequence of top-level turn sections, in document order. */
function turnRoles(html: string): string[] {
    const roles: string[] = [];
    const re = /<section class="gem-turn gem-turn-(user|model)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) roles.push(m[1]);
    return roles;
}

let newHtml: string;

// Build independent test evidence in a suite hook, not in a preceding test.
test.before(async () => {
    const native = historicalFixture(chat);
    const res = await renderFixture(native);
    assert.ok(res.html.startsWith('<!DOCTYPE html>'), 'must be a full HTML document');
    newHtml = res.html;
});

test('migration: message count and order are correct', () => {
    const newRoles = turnRoles(newHtml);
    assert.deepStrictEqual(newRoles, ['user', 'model', 'user', 'model']);
});

test('migration: body text not dropped', () => {
    for (const needle of [
        'Please analyze this screenshot',
        'key metric',
        'rising',
        'explain the',
        'It sums the values',
    ]) {
        assert.ok(newHtml.includes(needle), `body text missing: ${needle}`);
    }
});

test('migration: attachments and images not dropped', () => {
    assert.ok(newHtml.includes('report.pdf'), 'file attachment name missing');
    assert.ok(newHtml.includes('screen.png'), 'image attachment name missing');
    assert.ok(newHtml.includes('inline-photo.jpg'), 'inline image name missing');
    assert.ok(newHtml.includes('assets/inline-photo.jpg'), 'inline image src missing');
    const imgCount = (newHtml.match(/<img\b/g) || []).length;
    assert.ok(imgCount >= 2, `expected >=2 <img> tags, got ${imgCount}`);
});

test('migration: thought not dropped', () => {
    assert.ok(newHtml.includes('gem-thoughts'), 'thought block missing');
    assert.ok(newHtml.includes('Verify the numbers in the table'), 'thought text missing');
});

test('migration: code block not dropped', () => {
    assert.ok(newHtml.includes('def trend(xs):'), 'code text missing');
    assert.ok(newHtml.includes('language-python'), 'code language marker missing');
});

test('migration: table not dropped', () => {
    assert.ok(newHtml.includes('<table'), 'table element missing');
    assert.ok(newHtml.includes('Metric'), 'table header cell missing');
    assert.ok(newHtml.includes('rising'), 'table body cell missing');
});

test('migration: citation not dropped', () => {
    assert.ok(newHtml.includes('https://example.com/dataset.csv'), 'citation URL missing');
    assert.ok(newHtml.includes('gem-citation'), 'citation markup missing');
});

test('migration: duplicate source message IDs preserve every message at export', async () => {
    const dupChat: any = {
        id: 'dup_001',
        title: 'Duplicate Id Chat',
        messages: [
            { id: 'c_dup_001', role: 'user', content: 'first user prompt' },
            { id: 'rc_dup_1', role: 'model', content: 'model answer' },
            { id: 'c_dup_001', role: 'user', content: 'first user prompt' },
        ],
    };
    const result = await renderFixture(historicalFixture(dupChat));
    assert.deepStrictEqual(turnRoles(result.html), ['user', 'model', 'user']);
    assert.equal(result.html.match(/first user prompt/g)?.length, 2);
    assert.ok(result.html.includes('model answer'));
});
