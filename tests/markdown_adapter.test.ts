/**
 * tests/markdown_adapter.test.ts
 *
 * Layer M1 (MDAST -> Canonical AST Adapter Unit Tests) &
 * Layer M2 (Integration Smoke Tests for micromark / mdast-util-from-markdown pipeline)
 *
 * Conforms to Section 8 of the Parser Migration & Validation Plan.
 */

export {};
const test = require('node:test');
const assert = require('node:assert');

const {
    parseMarkdownToBlocks,
    parseMarkdownToInlines,
    mdastRootToBlocks,
    adaptInlines,
    mergeAdjacentTextNodes,
} = require('../src/core/export/canonical/markdown/index.js');
const { newAssetLinkIndex, indexAssetRef } = require('../src/core/export/canonical/gemini/normalizeAssets.js');

function createTestContext(overrides: any = {}) {
    let blockSeq = 0;
    const diagnostics: any[] = [];
    const inlineAssets: any[] = [];
    const assetIndex = newAssetLinkIndex();
    const ctx = {
        idPrefix: 'test-msg',
        nextBlockId: () => `test-msg-b${blockSeq++}`,
        diagnostics,
        inlineAssets,
        assetIndex,
        sourceRef: { providerId: 'test-provider', locator: 'test.0' },
        ...overrides,
    };
    return { ctx, diagnostics, inlineAssets, assetIndex };
}

// =========================================================================
// Layer M1: Adapter Unit Tests (Direct MDAST -> Canonical Mapping)
// =========================================================================

test('Layer M1: Text node coalescing merges adjacent text nodes', () => {
    const raw = [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'World' },
    ];
    const merged = mergeAdjacentTextNodes(raw as any);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual((merged[0] as any).text, 'Hello World');
});

test('Layer M1: Nested inlines coalesce adjacent text nodes inside parents', () => {
    const raw = [
        {
            type: 'strong',
            children: [
                { type: 'text', text: 'Part 1 ' },
                { type: 'text', text: 'Part 2' },
            ],
        },
    ];
    const merged = mergeAdjacentTextNodes(raw as any);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual((merged[0] as any).children.length, 1);
    assert.strictEqual((merged[0] as any).children[0].text, 'Part 1 Part 2');
});

test('Layer M1: adaptInlines maps text with newlines to text and soft lineBreak', () => {
    const { ctx } = createTestContext();
    const mdastNodes: any[] = [
        { type: 'text', value: 'Line 1\nLine 2\nLine 3' },
    ];
    const inlines = adaptInlines(mdastNodes, ctx);
    assert.strictEqual(inlines.length, 5);
    assert.strictEqual(inlines[0].type, 'text');
    assert.strictEqual((inlines[0] as any).text, 'Line 1');
    assert.strictEqual(inlines[1].type, 'lineBreak');
    assert.strictEqual((inlines[1] as any).kind, 'soft');
    assert.strictEqual(inlines[2].type, 'text');
    assert.strictEqual((inlines[2] as any).text, 'Line 2');
    assert.strictEqual(inlines[3].type, 'lineBreak');
    assert.strictEqual((inlines[3] as any).kind, 'soft');
    assert.strictEqual(inlines[4].type, 'text');
    assert.strictEqual((inlines[4] as any).text, 'Line 3');
});

test('Layer M1: adaptInlines maps break and <br> to hard lineBreak', () => {
    const { ctx } = createTestContext();
    const mdastNodes: any[] = [
        { type: 'text', value: 'Before' },
        { type: 'break' },
        { type: 'html', value: '<br />' },
        { type: 'text', value: 'After' },
    ];
    const inlines = adaptInlines(mdastNodes, ctx);
    assert.strictEqual(inlines.length, 4);
    assert.strictEqual((inlines[1] as any).kind, 'hard');
    assert.strictEqual((inlines[2] as any).kind, 'hard');
});

test('Layer M1: adaptInlines maps delete to strikethrough', () => {
    const { ctx } = createTestContext();
    const mdastNodes: any[] = [
        {
            type: 'delete',
            children: [{ type: 'text', value: 'struck' }],
        },
    ];
    const inlines = adaptInlines(mdastNodes, ctx);
    assert.strictEqual(inlines.length, 1);
    assert.strictEqual(inlines[0].type, 'strikethrough');
    assert.strictEqual((inlines[0] as any).children[0].text, 'struck');
});

test('Layer M1: mdastRootToBlocks maps heading levels 1 through 6', () => {
    const { ctx } = createTestContext();
    const mdastRoot: any = {
        type: 'root',
        children: [
            { type: 'heading', depth: 1, children: [{ type: 'text', value: 'H1' }] },
            { type: 'heading', depth: 3, children: [{ type: 'text', value: 'H3' }] },
            { type: 'heading', depth: 6, children: [{ type: 'text', value: 'H6' }] },
        ],
    };
    const blocks = mdastRootToBlocks(mdastRoot, ctx, '');
    assert.strictEqual(blocks.length, 3);
    assert.strictEqual(blocks[0].type, 'heading');
    assert.strictEqual((blocks[0] as any).level, 1);
    assert.strictEqual((blocks[1] as any).level, 3);
    assert.strictEqual((blocks[2] as any).level, 6);
});

test('Layer M1: mdastRootToBlocks maps code block language and meta', () => {
    const { ctx } = createTestContext();
    const mdastRoot: any = {
        type: 'root',
        children: [
            {
                type: 'code',
                lang: 'typescript',
                meta: 'filename=main.ts',
                value: 'const x = 1;',
            },
        ],
    };
    const blocks = mdastRootToBlocks(mdastRoot, ctx, '');
    assert.strictEqual(blocks.length, 1);
    const code = blocks[0] as any;
    assert.strictEqual(code.type, 'code');
    assert.strictEqual(code.language, 'typescript');
    assert.strictEqual(code.meta, 'filename=main.ts');
    assert.strictEqual(code.code, 'const x = 1;');
});

test('Layer M1: mdastRootToBlocks maps table alignments and cell structures', () => {
    const { ctx } = createTestContext();
    const mdastRoot: any = {
        type: 'root',
        children: [
            {
                type: 'table',
                align: ['left', 'center', 'right', null],
                children: [
                    {
                        type: 'tableRow',
                        children: [
                            { type: 'tableCell', children: [{ type: 'text', value: 'H1' }] },
                            { type: 'tableCell', children: [{ type: 'text', value: 'H2' }] },
                            { type: 'tableCell', children: [{ type: 'text', value: 'H3' }] },
                            { type: 'tableCell', children: [{ type: 'text', value: 'H4' }] },
                        ],
                    },
                    {
                        type: 'tableRow',
                        children: [
                            { type: 'tableCell', children: [{ type: 'text', value: 'D1' }] },
                            { type: 'tableCell', children: [{ type: 'text', value: 'D2' }] },
                            { type: 'tableCell', children: [{ type: 'text', value: 'D3' }] },
                            { type: 'tableCell', children: [{ type: 'text', value: 'D4' }] },
                        ],
                    },
                ],
            },
        ],
    };
    const blocks = mdastRootToBlocks(mdastRoot, ctx, '');
    assert.strictEqual(blocks.length, 1);
    const table = blocks[0] as any;
    assert.strictEqual(table.type, 'table');
    assert.deepStrictEqual(table.columns.map((c: any) => c.align), ['left', 'center', 'right', 'default']);
    assert.strictEqual(table.headerRows.length, 1);
    assert.strictEqual(table.rows.length, 1);
    assert.strictEqual(table.headerRows[0].cells[0].children[0].text, 'H1');
    assert.strictEqual(table.rows[0].cells[2].children[0].text, 'D3');
});

test('Layer M1: Task list checkbox prepends marker to item text', () => {
    const { ctx } = createTestContext();
    const mdastRoot: any = {
        type: 'root',
        children: [
            {
                type: 'list',
                ordered: false,
                children: [
                    {
                        type: 'listItem',
                        checked: false,
                        children: [
                            { type: 'paragraph', children: [{ type: 'text', value: 'Todo task' }] },
                        ],
                    },
                    {
                        type: 'listItem',
                        checked: true,
                        children: [
                            { type: 'paragraph', children: [{ type: 'text', value: 'Done task' }] },
                        ],
                    },
                ],
            },
        ],
    };
    const blocks = mdastRootToBlocks(mdastRoot, ctx, '');
    const list = blocks[0] as any;
    assert.strictEqual(list.items.length, 2);
    assert.strictEqual(list.items[0].blocks[0].children[0].text, '[ ] Todo task');
    assert.strictEqual(list.items[1].blocks[0].children[0].text, '[x] Done task');
});

// =========================================================================
// Layer M2: Integration Smoke Tests (micromark -> mdast -> Canonical AST)
// =========================================================================

test('Layer M2: Smoke test - Headings, paragraphs, and standard inlines', () => {
    const { ctx } = createTestContext();
    const doc = [
        '# Document Title',
        '',
        'Here is a paragraph with **bold**, *italic*, and `code`.',
        '',
        'Visit [OpenAI](https://openai.com "AI Company") for more info.',
    ].join('\n');

    const blocks = parseMarkdownToBlocks(doc, 'smoke', ctx);
    assert.strictEqual(blocks.length, 3);
    assert.strictEqual(blocks[0].type, 'heading');
    assert.strictEqual((blocks[0] as any).level, 1);
    assert.strictEqual((blocks[0] as any).children[0].text, 'Document Title');

    assert.strictEqual(blocks[1].type, 'paragraph');
    const p1Inlines = (blocks[1] as any).children;
    assert.strictEqual(p1Inlines.find((c: any) => c.type === 'strong').children[0].text, 'bold');
    assert.strictEqual(p1Inlines.find((c: any) => c.type === 'emphasis').children[0].text, 'italic');
    assert.strictEqual(p1Inlines.find((c: any) => c.type === 'inlineCode').code, 'code');

    assert.strictEqual(blocks[2].type, 'paragraph');
    const link = (blocks[2] as any).children.find((c: any) => c.type === 'link');
    assert.ok(link, 'link found');
    assert.strictEqual(link.href, 'https://openai.com');
    assert.strictEqual(link.title, 'AI Company');
    assert.strictEqual(link.children[0].text, 'OpenAI');
});

test('Layer M2: Smoke test - Fenced code blocks with language and info', () => {
    const { ctx } = createTestContext();
    const doc = '```python title=script.py\nprint("hello world")\n```';
    const blocks = parseMarkdownToBlocks(doc, 'smoke', ctx);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].type, 'code');
    const code = blocks[0] as any;
    assert.strictEqual(code.language, 'python');
    assert.strictEqual(code.meta, 'title=script.py');
    assert.strictEqual(code.code, 'print("hello world")');
});

test('Layer M2: Smoke test - Blockquotes and thematic breaks', () => {
    const { ctx } = createTestContext();
    const doc = '> Quote line 1\n> Quote line 2\n\n---';
    const blocks = parseMarkdownToBlocks(doc, 'smoke', ctx);
    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(blocks[0].type, 'quote');
    assert.strictEqual(blocks[1].type, 'thematicBreak');
    const q = blocks[0] as any;
    assert.strictEqual(q.blocks.length, 1);
    assert.strictEqual(q.blocks[0].type, 'paragraph');
});

test('Layer M2: Smoke test - Ordered and nested lists', () => {
    const { ctx } = createTestContext();
    const doc = [
        '1. First item',
        '2. Second item',
        '   - Nested bullet A',
        '   - Nested bullet B',
        '3. Third item',
    ].join('\n');
    const blocks = parseMarkdownToBlocks(doc, 'smoke', ctx);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].type, 'list');
    const list = blocks[0] as any;
    assert.strictEqual(list.ordered, true);
    assert.strictEqual(list.items.length, 3);
    assert.strictEqual(list.items[1].blocks.length, 2);
    assert.strictEqual(list.items[1].blocks[1].type, 'list');
    assert.strictEqual(list.items[1].blocks[1].ordered, false);
});

test('Layer M2: Smoke test - GFM table parsing with column alignments', () => {
    const { ctx } = createTestContext();
    const doc = [
        '| Metric | Value | Status |',
        '| :--- | :---: | ---: |',
        '| Latency | 24ms | OK |',
        '| Error | 0% | Nominal |',
    ].join('\n');
    const blocks = parseMarkdownToBlocks(doc, 'smoke', ctx);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].type, 'table');
    const table = blocks[0] as any;
    assert.deepStrictEqual(table.columns.map((c: any) => c.align), ['left', 'center', 'right']);
    assert.strictEqual(table.headerRows.length, 1);
    assert.strictEqual(table.rows.length, 2);
    assert.strictEqual(table.headerRows[0].cells[0].children[0].text, 'Metric');
    assert.strictEqual(table.rows[0].cells[1].children[0].text, '24ms');
});

test('Layer M2: Smoke test - Inline and display math formulas', () => {
    const { ctx } = createTestContext();
    const doc = [
        'The formula is $E = mc^2$ in relativity.',
        '',
        '$$',
        '\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}',
        '$$',
    ].join('\n');
    const blocks = parseMarkdownToBlocks(doc, 'smoke', ctx);
    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(blocks[0].type, 'paragraph');
    const inlineMath = (blocks[0] as any).children.find((c: any) => c.type === 'inlineMath');
    assert.ok(inlineMath, 'inlineMath found');
    assert.strictEqual(inlineMath.source, 'E = mc^2');

    assert.strictEqual(blocks[1].type, 'math');
    const mathBlock = blocks[1] as any;
    assert.strictEqual(mathBlock.source, '\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}');
});

test('Layer M2: Smoke test - Standalone single-line $$...$$ is recognized as MathBlock', () => {
    const { ctx } = createTestContext();
    const doc = '$$\\frac{a}{b}$$';
    const blocks = parseMarkdownToBlocks(doc, 'smoke', ctx);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].type, 'math');
    assert.strictEqual((blocks[0] as any).source, '\\frac{a}{b}');
});

test('Layer M2: Smoke test - Asset index link matching for inline images', () => {
    const { ctx, assetIndex } = createTestContext();
    indexAssetRef(assetIndex, 'https://example.com/photo.png', 'asset-img-001');

    const doc = 'Here is an image: ![A mountain](https://example.com/photo.png "Mountain peak")';
    const blocks = parseMarkdownToBlocks(doc, 'smoke', ctx);
    assert.strictEqual(blocks.length, 1);
    const img = (blocks[0] as any).children.find((c: any) => c.type === 'image');
    assert.ok(img, 'image found');
    assert.strictEqual(img.assetId, 'asset-img-001');
    assert.strictEqual(img.alt, 'A mountain');
    assert.strictEqual(img.title, 'Mountain peak');
});

test('Layer M2: Smoke test - parseMarkdownToInlines returns inline list', () => {
    const { ctx } = createTestContext();
    const text = 'Simple **bold** and *italic* text';
    const inlines = parseMarkdownToInlines(text, 'smoke', ctx);
    assert.strictEqual(inlines.length, 5);
    assert.strictEqual(inlines[0].text, 'Simple ');
    assert.strictEqual(inlines[1].type, 'strong');
    assert.strictEqual(inlines[2].text, ' and ');
    assert.strictEqual(inlines[3].type, 'emphasis');
    assert.strictEqual(inlines[4].text, ' text');
});

// =========================================================================
// Reference Nodes & Definition Resolution (PR 2.1 Hardening)
// =========================================================================

test('Reference Nodes: Standard full, collapsed, and shortcut linkReference resolve definitions', () => {
    const { ctx } = createTestContext();
    const doc = [
        'See [Google Link][google-ref], [GitHub][], and [CommonMark].',
        '',
        '[google-ref]: https://google.com "Google Search"',
        '[GitHub]: https://github.com',
        '[CommonMark]: https://commonmark.org "Specification"',
    ].join('\n');

    const blocks = parseMarkdownToBlocks(doc, 'ref-test', ctx);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].type, 'paragraph');

    const para = blocks[0] as any;
    const links = para.children.filter((c: any) => c.type === 'link');
    assert.strictEqual(links.length, 3);

    // Full reference
    assert.strictEqual(links[0].href, 'https://google.com');
    assert.strictEqual(links[0].title, 'Google Search');
    assert.strictEqual(links[0].children[0].text, 'Google Link');

    // Collapsed reference
    assert.strictEqual(links[1].href, 'https://github.com');
    assert.strictEqual(links[1].children[0].text, 'GitHub');

    // Shortcut reference
    assert.strictEqual(links[2].href, 'https://commonmark.org');
    assert.strictEqual(links[2].title, 'Specification');
    assert.strictEqual(links[2].children[0].text, 'CommonMark');
});

test('Reference Nodes: Case-insensitive definition matching and first-definition precedence', () => {
    const { ctx } = createTestContext();
    const doc = [
        'Jump to [Section A][SEC_A].',
        '',
        '[sec_a]: https://example.com/first',
        '[SEC_A]: https://example.com/second-ignored',
    ].join('\n');

    const blocks = parseMarkdownToBlocks(doc, 'case-test', ctx);
    assert.strictEqual(blocks.length, 1);
    const link = (blocks[0] as any).children.find((c: any) => c.type === 'link');
    assert.ok(link, 'Link must be resolved');
    // First definition takes precedence per CommonMark 4.7
    assert.strictEqual(link.href, 'https://example.com/first');
});

test('Reference Nodes: Definition lifetime is isolated per parse run (no leakage across calls with same ctx)', () => {
    const { ctx } = createTestContext();

    const doc1 = [
        'First: [x]',
        '',
        '[x]: https://example.com/A',
    ].join('\n');

    const doc2 = [
        'Second: [x]',
        '',
        '[x]: https://example.com/B',
    ].join('\n');

    const blocks1 = parseMarkdownToBlocks(doc1, 'run1', ctx);
    const link1 = (blocks1[0] as any).children.find((c: any) => c.type === 'link');
    assert.ok(link1, 'First link must be resolved');
    assert.strictEqual(link1.href, 'https://example.com/A');

    // Second parse run with the SAME ctx must resolve to B, never leaking A
    const blocks2 = parseMarkdownToBlocks(doc2, 'run2', ctx);
    const link2 = (blocks2[0] as any).children.find((c: any) => c.type === 'link');
    assert.ok(link2, 'Second link must be resolved');
    assert.strictEqual(link2.href, 'https://example.com/B');

    // Also test inline parse with the same ctx
    const inlines1 = parseMarkdownToInlines('[x]\n\n[x]: https://example.com/A', 'inline1', ctx);
    const inlineLink1 = inlines1.find((c: any) => c.type === 'link');
    assert.ok(inlineLink1);
    assert.strictEqual((inlineLink1 as any).href, 'https://example.com/A');

    const inlines2 = parseMarkdownToInlines('[x]\n\n[x]: https://example.com/B', 'inline2', ctx);
    const inlineLink2 = inlines2.find((c: any) => c.type === 'link');
    assert.ok(inlineLink2);
    assert.strictEqual((inlineLink2 as any).href, 'https://example.com/B');
});

test('Reference Nodes: Image reference resolves definition and asset linking', () => {
    const { ctx, assetIndex } = createTestContext();
    indexAssetRef(assetIndex, 'https://example.com/diagram.png', 'asset-diag-42');

    const doc = [
        'Architecture: ![System Diagram][diag-ref]',
        '',
        '[diag-ref]: https://example.com/diagram.png "Architecture Flow"',
    ].join('\n');

    const blocks = parseMarkdownToBlocks(doc, 'img-ref-test', ctx);
    assert.strictEqual(blocks.length, 1);
    const img = (blocks[0] as any).children.find((c: any) => c.type === 'image');
    assert.ok(img, 'Image must be resolved');
    assert.strictEqual(img.assetId, 'asset-diag-42');
    assert.strictEqual(img.alt, 'System Diagram');
    assert.strictEqual(img.title, 'Architecture Flow');
});

test('Reference Nodes: Programmatic linkReference without definition emits diagnostic and preserves text', () => {
    const { ctx, diagnostics } = createTestContext();
    const orphanRefNode: any = {
        type: 'linkReference',
        identifier: 'missing-ref',
        label: 'missing-ref',
        referenceType: 'full',
        children: [{ type: 'text', value: 'Unresolved Link' }],
    };

    const inlines = adaptInlines([orphanRefNode], ctx);
    assert.strictEqual(inlines.length, 1);
    assert.strictEqual(inlines[0].type, 'text');
    assert.strictEqual((inlines[0] as any).text, 'Unresolved Link');

    const diag = diagnostics.find((d: any) => d.code === 'REFERENCE_DEFINITION_MISSING');
    assert.ok(diag, 'Must record REFERENCE_DEFINITION_MISSING diagnostic');
});

test('Reference Nodes: Programmatic imageReference without definition emits diagnostic and preserves fallback text', () => {
    const { ctx, diagnostics } = createTestContext();
    const orphanImgRef: any = {
        type: 'imageReference',
        identifier: 'missing-img',
        label: 'missing-img',
        referenceType: 'full',
        alt: 'Missing Photo',
    };

    const inlines = adaptInlines([orphanImgRef], ctx);
    assert.strictEqual(inlines.length, 1);
    assert.strictEqual(inlines[0].type, 'text');
    assert.strictEqual((inlines[0] as any).text, '![Missing Photo][missing-img]');

    const diag = diagnostics.find((d: any) => d.code === 'REFERENCE_DEFINITION_MISSING');
    assert.ok(diag, 'Must record REFERENCE_DEFINITION_MISSING diagnostic');
});

// =========================================================================
// Unknown != Disappear (Hardening: Never silently return [])
// =========================================================================

test('Unknown != Disappear: Unsupported phrasing node extracts child text and records diagnostic', () => {
    const { ctx, diagnostics } = createTestContext();
    const unknownWithChildren: any = {
        type: 'customPhrasingContainer',
        children: [{ type: 'text', value: 'nested text' }],
    };

    const inlines = adaptInlines([unknownWithChildren], ctx);
    assert.strictEqual(inlines.length, 1);
    assert.strictEqual(inlines[0].type, 'text');
    assert.strictEqual((inlines[0] as any).text, 'nested text');

    const diag = diagnostics.find((d: any) => d.code === 'MDAST_UNKNOWN_INLINE');
    assert.ok(diag, 'Must record MDAST_UNKNOWN_INLINE diagnostic');
});

test('unsupported inline wrapper flattens rich children to text without asset placements', () => {
    const { ctx, diagnostics, inlineAssets } = createTestContext();
    const inlines = adaptInlines([{ type: 'customWrapper', children: [
        { type: 'strong', children: [{ type: 'text', value: 'hello' }] },
        { type: 'break' },
        { type: 'image', alt: 'diagram', url: 'https://example.com/pic.png' },
        { type: 'inlineMath', value: 'x^2' },
        { type: 'link', url: 'https://example.com', children: [{ type: 'text', value: 'site' }] },
        { type: 'inlineCode', value: 'code' },
    ] } as any], ctx);
    assert.ok(inlines.every((node: any) => node.type === 'text' || node.type === 'lineBreak'));
    assert.strictEqual(inlines.map((node: any) => node.type === 'lineBreak' ? '\n' : node.text).join(''), 'hello\ndiagramx^2sitecode');
    assert.strictEqual(inlineAssets.length, 0);
    assert.strictEqual(diagnostics.filter((d: any) => d.code === 'MDAST_UNKNOWN_INLINE').length, 1);
    assert.deepStrictEqual(diagnostics[0].sourceRef, ctx.sourceRef);
});

test('Unknown != Disappear: Unsupported phrasing node with value preserves text and records diagnostic', () => {
    const { ctx, diagnostics } = createTestContext();
    const unknownWithValue: any = {
        type: 'customBadge',
        value: 'STATUS: OK',
    };

    const inlines = adaptInlines([unknownWithValue], ctx);
    assert.strictEqual(inlines.length, 1);
    assert.strictEqual(inlines[0].type, 'text');
    assert.strictEqual((inlines[0] as any).text, 'STATUS: OK');

    const diag = diagnostics.find((d: any) => d.code === 'MDAST_UNKNOWN_INLINE');
    assert.ok(diag, 'Must record MDAST_UNKNOWN_INLINE diagnostic');
});

test('Unknown != Disappear: Unsupported phrasing node without value/children returns visible text', () => {
    const { ctx, diagnostics } = createTestContext();
    const emptyUnknown: any = {
        type: 'mysteryInline',
        label: 'mystery-label',
    };

    const inlines = adaptInlines([emptyUnknown], ctx);
    assert.strictEqual(inlines.length, 1);
    assert.deepStrictEqual(inlines[0], { type: 'text', text: 'mystery-label' });
    assert.deepStrictEqual(adaptInlines([{ type: 'emptyWidget' } as any], ctx), [{ type: 'text', text: '[Unsupported inline: emptyWidget]' }]);

    const diag = diagnostics.find((d: any) => d.code === 'MDAST_UNKNOWN_INLINE');
    assert.ok(diag, 'Must record MDAST_UNKNOWN_INLINE diagnostic');
});

test('unsupported inline text follows children, value, alt, label, identifier priority', () => {
    const { ctx } = createTestContext();
    const samples = [
        { type: 'customInline', children: [{ type: 'text', value: 'child' }], value: 'value', alt: 'alt' },
        { type: 'customInline', value: 'value', alt: 'alt' },
        { type: 'customInline', alt: 'alt', label: 'label' },
        { type: 'customInline', label: 'label', identifier: 'identifier' },
        { type: 'customInline', identifier: 'identifier' },
    ];
    for (const [index, node] of samples.entries()) {
        assert.deepStrictEqual(adaptInlines([node as any], ctx), [{ type: 'text', text: ['child', 'value', 'alt', 'label', 'identifier'][index] }]);
    }
});

test('unsupported blocks retain raw slices, visible values, image alt text and empty placeholders', () => {
    const { ctx, diagnostics, inlineAssets } = createTestContext();
    const nodes: any[] = [
        { type: 'widget', position: { start: { offset: 0 }, end: { offset: 9 } }, value: 'value' },
        { type: 'widget', value: 'visible value' },
        { type: 'widget', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'see ' }, { type: 'image', alt: 'diagram', url: 'https://example.com/image.png' }] }] },
        { type: 'emptyWidget' },
    ];
    const blocks = mdastRootToBlocks({ type: 'root', children: nodes } as any, ctx, 'raw slice');
    assert.deepStrictEqual(blocks.map((b: any) => b.text), ['raw slice', 'visible value', 'see diagram', '[Unsupported block: emptyWidget]']);
    assert.strictEqual(inlineAssets.length, 0, 'text-only unknown blocks do not manufacture asset placements');
    assert.strictEqual(diagnostics.filter((d: any) => d.code === 'MDAST_UNKNOWN_BLOCK').length, 4);
});

test('Unknown != Disappear: Unsupported block node collapses visible content to text and records diagnostic', () => {
    const { ctx, diagnostics } = createTestContext();
    const root: any = {
        type: 'root',
        children: [
            {
                type: 'customCalloutBox',
                children: [
                    {
                        type: 'paragraph',
                        children: [{ type: 'text', value: 'Inside callout' }],
                    },
                ],
            },
        ],
    };

    const blocks = mdastRootToBlocks(root, ctx, '');
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].type, 'unknown');
    const unknownBlock = blocks[0] as any;
    assert.strictEqual(unknownBlock.sourceType, 'customCalloutBox');
    assert.strictEqual(unknownBlock.text, 'Inside callout');
    assert.deepStrictEqual(Object.keys(unknownBlock).sort(), ['id', 'sourceType', 'text', 'type']);

    const diag = diagnostics.find((d: any) => d.code === 'MDAST_UNKNOWN_BLOCK');
    assert.ok(diag, 'Must record MDAST_UNKNOWN_BLOCK diagnostic');
    assert.deepStrictEqual(diag.sourceRef, ctx.sourceRef, 'diagnostic retains parser location');
    assert.strictEqual(unknownBlock.sourceRef, undefined, 'document block has no sourceRef');
});

test('GM-MD-001 Regression: Attached multiline display math fences do not swallow following blocks', () => {
    const { ctx } = createTestContext();
    const doc = [
        '#### 3. Teukolsky 主方程（TME）',
        '',
        '将方向导数转化为 Boyer-Lindquist 坐标微商，Teukolsky 统一方程写作：',
        '$$\\begin{aligned}',
        '\\Biggl[ &\\left(\\frac{(r^2+a^2)^2}{\\Delta} - a^2\\sin^2\\theta\\right)\\frac{\\partial^2\\psi}{\\partial t^2} \\\\',
        '&+ (s^2\\cot^2\\theta - s) \\psi \\Biggr] = 4\\pi \\Sigma T',
        '\\end{aligned}$$',
        '在真空辐射规范（Radiation Gauge / 无外源）条件下，令源项 $T = 0$。',
        '',
        '---',
    ].join('\n');

    const blocks = parseMarkdownToBlocks(doc, 'gm-md-001-test', ctx);
    assert.strictEqual(blocks.length, 5, 'Must cleanly parse into 5 distinct blocks without unclosed fence swallowing');

    assert.strictEqual(blocks[0].type, 'heading');
    assert.strictEqual((blocks[0] as any).level, 4);

    assert.strictEqual(blocks[1].type, 'paragraph');

    assert.strictEqual(blocks[2].type, 'math');
    const mathBlock = blocks[2] as any;
    assert.ok(mathBlock.source.startsWith('\\begin{aligned}'), 'Must retain \\begin{aligned} in math source');
    assert.ok(mathBlock.source.endsWith('\\end{aligned}'), 'Must retain \\end{aligned} in math source');
    assert.ok(!mathBlock.source.includes('$$'), 'Must not contain fence delimiters in math source');

    assert.strictEqual(blocks[3].type, 'paragraph');
    assert.ok(!mathBlock.source.includes('真空辐射规范'), 'Subsequent paragraph must not be swallowed into math block');

    assert.strictEqual(blocks[4].type, 'thematicBreak');
});

