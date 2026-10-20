/**
 * tests/html-canonical-migration.test.ts
 * Item 1 (P0): production HTML export routes through the canonical path
 * (ChatFormatter.formatHtmlCanonical: normalizeGeminiConversation ->
 * CanonicalHtmlRenderer).
 *
 * History: this file originally compared the legacy toHtml() output with
 * the new production entry as migration evidence. Item 2 (P0) removed the
 * legacy toHtml() pipeline entirely; the remaining assertions verify the
 * production entry directly: turn count/order and no dropped content
 * class (text, attachments, images, thought, code, table, citation).
 * Not pixel-perfect: tags/styles may differ.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { ChatFormatter } = require('../src/core/engine/chatFormatter.js');

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

test('migration setup: production entry returns a valid HTML FormattedResult', async () => {
    const res = await ChatFormatter.formatHtmlCanonical(chat);
    assert.strictEqual(res.ext, 'html');
    assert.strictEqual(res.mime, 'text/html');
    assert.ok(String(res.content).startsWith('<!DOCTYPE html>'), 'must be a full HTML document');
    newHtml = String(res.content);
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

test('migration: duplicate message IDs fail closed at the production export boundary', async () => {
    // Repeated pagination IDs remain an ingestion data-integrity diagnostic.
    const dupChat: any = {
        id: 'dup_001',
        title: 'Duplicate Id Chat',
        messages: [
            { id: 'c_dup_001', role: 'user', content: 'first user prompt' },
            { id: 'rc_dup_1', role: 'model', content: 'model answer' },
            { id: 'c_dup_001', role: 'user', content: 'first user prompt' },
        ],
    };
    const { normalizeGeminiConversation } = require('../src/core/export/canonical/index.js');
    const { diagnostics } = await normalizeGeminiConversation(dupChat);
    assert.ok(diagnostics.some((d: any) => d.code === 'MSG_DUP_ID'));
    await assert.rejects(() => ChatFormatter.formatHtmlCanonical(dupChat), /MSG_DUP_ID/);
});
