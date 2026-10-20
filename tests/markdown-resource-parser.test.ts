import { test } from 'node:test';
import { parseMarkdownAst } from '../src/core/export/canonical/markdown/parseMarkdown.js';
import assert from 'node:assert/strict';
import { extractMarkdownResourceReferences } from '../scripts/extract_markdown_resource_refs.js';

test('production MDAST links and images retain URLs and reference definition precedence', () => {
    assert.deepEqual(extractMarkdownResourceReferences(
        '[attachment][ref]\n\n[ref]: files/foo.md "title"\n[ref]: files/wrong.md\n\n![image](assets/foo.png)',
    ), [
        { kind: 'link', reference: 'files/foo.md' },
        { kind: 'image', reference: 'assets/foo.png' },
    ]);
});

test('syntax helper emits external references for the archive resolver to classify', () => {
    assert.deepEqual(extractMarkdownResourceReferences('[remote](https://example.com) [section](#section)'), [
        { kind: 'link', reference: 'https://example.com' },
        { kind: 'link', reference: '#section' },
    ]);
});

import { renderCanonicalMarkdown } from '../src/core/export/canonical/renderCanonicalMarkdown.js';
import type { CanonicalConversationBundle } from '../src/core/export/canonical/conversation.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('serialized literal dollars round-trip as text while links and math retain their nodes', () => {
    const bundle: CanonicalConversationBundle = {
        schemaVersion: 1, assets: [], citations: [],
        conversation: {
            key: { providerId: 'gemini', accountId: 'test', conversationId: 'currency' },
            messages: [{ id: 'message', role: 'assistant', blocks: [
                { id: 'paragraph', type: 'paragraph', children: [
                    { type: 'text', text: 'The price changed from $5 ' },
                    { type: 'link', href: 'files/foo.pdf', children: [{ type: 'text', text: 'receipt' }] },
                    { type: 'text', text: ' to $10. ' },
                    { type: 'inlineMath', source: 'E = mc^2' },
                ] },
                { id: 'math', type: 'math', source: String.raw`\left[W(k)\right](\mathbf{t})` },
                { id: 'code', type: 'code', language: 'md', code: '[fake](files/missing.pdf)' },
                { id: 'inline-code', type: 'paragraph', children: [{ type: 'inlineCode', code: '[fake](files/missing.pdf)' }] },
            ] }],
        },
    };
    const markdown = renderCanonicalMarkdown(bundle);
    assert.ok(markdown.includes(String.raw`The price changed from \$5 [receipt](files/foo.pdf) to \$10. $E = mc^2$`));
    assert.ok(markdown.includes('$$\n' + String.raw`\left[W(k)\right](\mathbf{t})` + '\n$$'));
    const tree = parseMarkdownAst(markdown);
    const paragraph = tree.children.find(node => node.type === 'paragraph' && node.children.some(child => child.type === 'link'));
    assert.ok(paragraph?.type === 'paragraph');
    assert.deepEqual(paragraph.children.map(node => node.type), ['text', 'link', 'text', 'inlineMath']);
    assert.equal(paragraph.children[0].type === 'text' && paragraph.children[0].value, 'The price changed from $5 ');
    assert.equal(paragraph.children[2].type === 'text' && paragraph.children[2].value, ' to $10. ');
    assert.equal(paragraph.children[3].type === 'inlineMath' && paragraph.children[3].value, 'E = mc^2');
    assert.deepEqual(extractMarkdownResourceReferences(markdown), [{ kind: 'link', reference: 'files/foo.pdf' }]);

    const root = mkdtempSync(join(tmpdir(), 'serialized-resources-'));
    try {
        const validate = () => {
            const result = spawnSync('python3', ['-c',
                'import json,sys; from scripts.framework.archive_resources import validate_archive_resources; print(json.dumps(validate_archive_resources(sys.argv[1], "chat.md", sys.stdin.read())))', root,
            ], { input: markdown, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            return JSON.parse(result.stdout) as string[];
        };
        assert.equal(validate().length, 1);
        mkdirSync(join(root, 'files'));
        writeFileSync(join(root, 'files/foo.pdf'), 'nonempty attachment');
        assert.deepEqual(validate(), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shared AST primitive preserves source offsets without Gemini preprocessing', () => {
    // GM-MD-001 inserts fence newlines for raw Gemini fallback. The syntax
    // primitive must preserve the final artifact exactly, including positions.
    const source = '$$\\begin{aligned}\nx = 1\n\\end{aligned}$$\n';
    const tree = parseMarkdownAst(source);
    assert.equal(tree.position?.end.offset, source.length);
});
