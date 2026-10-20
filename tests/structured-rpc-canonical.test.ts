/**
 * tests/structured-rpc-canonical.test.ts
 *
 * Verification suite for Gemini Structured RPC -> Canonical AST integration.
 * Tests:
 * 1. Structured path is actively used (decision point prioritized over Markdown parser).
 * 2. #705 Divergence cases:
 *    - Display math (multiline and after prose) mapped directly to Canonical math block.
 *    - Table + math pipe ($|\alpha|^2$ and $\|\psi\rangle$) preserving intact cells and math.
 * 3. Real Tier 2 Probe fixtures validation against Canonical schema.
 * 4. Wire JSPB decoding in Gemini parser layer.
 * 5. Fallback semantics:
 *    - Missing structuredContent -> fallback to Markdown parser.
 *    - Unknown nodeType -> fallback to Markdown parser.
 *    - Malformed node / crossing annotations -> fallback to Markdown parser.
 *    - Empty structured doc with non-empty raw markdown -> fallback to Markdown parser.
 * 6. HTML renderer compatibility with Canonical AST from structured path.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    normalizeGeminiConversation,
    validateBundle,
    renderCanonicalHtml,
} = require('../src/core/export/canonical/index.js');
const {
    geminiStructuredToCanonical,
    convertGeminiInlines,
} = require('../src/core/export/canonical/gemini/structuredAdapter.js');
const {
    decodeGeminiAnnotation,
    decodeGeminiStructuredNode,
    decodeGeminiStructuredPayload,
    extractStructuredContent,
} = require('../src/core/api/parser/structuredContent.js');
const { parseDetail } = require('../src/core/api/parser/parseDetail.js');
const { extractImages } = require('../src/core/api/parser/attachments.js');

const fixturesDir = path.join(__dirname, 'fixtures', 'canonical', 'structured_rpc');

function loadProbeFixture(filename: string): any {
    const fullPath = path.join(fixturesDir, filename);
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

test('Structured path is actively used and bypasses Markdown parser', async () => {
    const conv = {
        id: 'c_structured_test',
        title: 'Structured Test',
        messages: [
            {
                id: 'm1',
                role: 'user',
                content: 'Hello',
            },
            {
                id: 'm2',
                role: 'model',
                content: 'Raw markdown that would parse completely differently: **raw markdown text**',
                structuredContent: {
                    children: [
                        {
                            nodeType: 18,
                            text: 'Authoritative structured text from RPC',
                            annotations: [
                                { start: 14, end: 24, type: 0 }, // "structured" in bold
                            ],
                        },
                        {
                            nodeType: 12,
                            FTa: 'E = mc^2',
                        },
                    ],
                },
            },
        ],
    };

    const { bundle, diagnostics } = await normalizeGeminiConversation(conv as any);
    assert.strictEqual(diagnostics.filter((d: any) => d.severity === 'error').length, 0);

    const modelMsg = bundle.conversation.messages.find((m: any) => m.id === 'm2');
    assert.ok(modelMsg, 'Model message present');

    // Should have 2 blocks: paragraph and math (NOT the raw markdown text)
    assert.strictEqual(modelMsg.blocks.length, 2);
    assert.strictEqual(modelMsg.blocks[0].type, 'paragraph');
    assert.strictEqual(modelMsg.blocks[1].type, 'math');

    // Check paragraph inlines:
    const p = modelMsg.blocks[0];
    const strongInline = p.children.find((c: any) => c.type === 'strong');
    assert.ok(strongInline, 'Strong inline exists from annotation');
    assert.strictEqual(strongInline.children[0].text, 'structured');

    // Check math block:
    const math = modelMsg.blocks[1];
    assert.strictEqual(math.source, 'E = mc^2');

    // Ensure raw markdown string was NOT used
    const allText = JSON.stringify(modelMsg.blocks);
    assert.ok(!allText.includes('raw markdown text'), 'Raw markdown was bypassed');
});

test('#705 Divergence Case: Display Math directly to Canonical math block', async () => {
    const multilineFormula = 'W^{(1)}_{RB}(v) = \\begin{cases}    0 & \\text{若 } v \\in C_{RG} \\\\    W^{(0)}(v) & \\text{若 } v \\notin C_{RG}    \\end{cases}';
    const afterProseFormula = 'A(a, \\lambda) = \\pm 1, \\quad B(b, \\lambda) = \\pm 1';

    const conv = {
        id: 'c_math_test',
        title: 'Math Divergence Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'prose before math\n\n' + multilineFormula,
                structuredContent: {
                    children: [
                        {
                            nodeType: 18,
                            text: 'prose before math',
                        },
                        {
                            nodeType: 12,
                            FTa: multilineFormula,
                        },
                        {
                            nodeType: 12,
                            FTa: afterProseFormula,
                        },
                    ],
                },
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(conv as any);
    const msg = bundle.conversation.messages[0];
    assert.strictEqual(msg.blocks.length, 3);
    assert.strictEqual(msg.blocks[0].type, 'paragraph');
    assert.strictEqual(msg.blocks[1].type, 'math');
    assert.strictEqual(msg.blocks[2].type, 'math');

    const math1 = msg.blocks[1];
    assert.strictEqual(math1.source, multilineFormula);

    const math2 = msg.blocks[2];
    assert.strictEqual(math2.source, afterProseFormula);
});

test('#705 Divergence Case: Table + Math Pipe (|alpha|^2 and ||psi>) cell count and math intact', async () => {
    const tableFixture = loadProbeFixture('table-stack-structured.json');
    const psiTableFixture = loadProbeFixture('psi-table-stack-structured.json');

    // Case C-alpha
    const convAlpha = {
        id: 'c_table_alpha',
        title: 'Table Alpha Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'raw table markdown',
                structuredContent: tableFixture,
            },
        ],
    };

    const { bundle: bundleAlpha } = await normalizeGeminiConversation(convAlpha as any);
    const msgAlpha = bundleAlpha.conversation.messages[0];
    const tableBlockAlpha = msgAlpha.blocks.find((b: any) => b.type === 'table');
    assert.ok(tableBlockAlpha, 'Table block exists for Case C-alpha');

    // Header row should have exactly 5 cells
    assert.strictEqual(tableBlockAlpha.headerRows.length, 1);
    assert.strictEqual(tableBlockAlpha.headerRows[0].cells.length, 5);

    // All data rows must have exactly 5 cells
    assert.strictEqual(tableBlockAlpha.rows.length, 4);
    for (let r = 0; r < tableBlockAlpha.rows.length; r++) {
        assert.strictEqual(tableBlockAlpha.rows[r].cells.length, 5, `Row ${r} must have 5 cells`);
    }

    // Verify cell r2c4 contains the alpha^2 math intact
    const cellAlpha = tableBlockAlpha.rows[1].cells[4]; // row 2 in 0-indexed data rows is index 1
    const mathNodeAlpha = cellAlpha.children.find((c: any) => c.type === 'inlineMath' && c.source.includes('\\alpha'));
    assert.ok(mathNodeAlpha, 'InlineMath node found in table cell');
    assert.strictEqual(mathNodeAlpha.source, String.raw`\vert{}\alpha\vert{}^2`);

    // Case C-psi
    const convPsi = {
        id: 'c_table_psi',
        title: 'Table Psi Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'raw table psi markdown',
                structuredContent: psiTableFixture,
            },
        ],
    };

    const { bundle: bundlePsi } = await normalizeGeminiConversation(convPsi as any);
    const msgPsi = bundlePsi.conversation.messages[0];
    const tableBlockPsi = msgPsi.blocks.find((b: any) => b.type === 'table');
    assert.ok(tableBlockPsi, 'Table block exists for Case C-psi');

    // Header row should have exactly 3 cells
    assert.strictEqual(tableBlockPsi.headerRows[0].cells.length, 3);
    for (let r = 0; r < tableBlockPsi.rows.length; r++) {
        assert.strictEqual(tableBlockPsi.rows[r].cells.length, 3, `Row ${r} must have 3 cells`);
    }

    // Verify cell r1c2 contains \\Vert{}\\psi\\rangle math intact
    const cellPsi = tableBlockPsi.rows[0].cells[2];
    const mathNodePsi = cellPsi.children.find((c: any) => c.type === 'inlineMath' && c.source.includes('\\Vert{}\\psi'));
    assert.ok(mathNodePsi, 'InlineMath node found in table cell for psi');
    assert.ok(mathNodePsi.source.includes(String.raw`\Vert{}\psi\rangle`), 'Math source contains \\Vert{}\\psi\\rangle');
});

test('Real Tier 2 probe data: full documents validate cleanly against Canonical schema', async () => {
    const aStack = loadProbeFixture('a-stack-structured.json');
    const bStack = loadProbeFixture('b-stack-structured.json');

    // Case A: 50 root nodes
    assert.strictEqual(aStack.children.length, 50);
    const convA = {
        id: 'c_probe_a',
        title: 'Case A Multiline Display',
        messages: [{ id: 'm1', role: 'model', content: 'raw', structuredContent: aStack }],
    };
    const resA = await normalizeGeminiConversation(convA as any);
    const bundleErrorsA = validateBundle(resA.bundle).filter((d: any) => d.severity === 'error');
    assert.strictEqual(bundleErrorsA.length, 0, 'Case A bundle has no error diagnostics');

    // Case B: 49 root nodes
    assert.strictEqual(bStack.children.length, 49);
    const convB = {
        id: 'c_probe_b',
        title: 'Case B Display After Text',
        messages: [{ id: 'm1', role: 'model', content: 'raw', structuredContent: bStack }],
    };
    const resB = await normalizeGeminiConversation(convB as any);
    const bundleErrorsB = validateBundle(resB.bundle).filter((d: any) => d.severity === 'error');
    assert.strictEqual(bundleErrorsB.length, 0, 'Case B bundle has no error diagnostics');
});

test('Real wire decode: sanitized hNvQHb field 12 fixtures match runtime probe fixtures', () => {
    // 1. Psi-table wire fixture: real turn[3][12] from probe case-b turn 0
    const psiWire = loadProbeFixture('wire-turn-3-12-psi-table.json');
    const psiRuntime = loadProbeFixture('psi-table-stack-structured.json');

    const decodedPsi = decodeGeminiStructuredPayload(psiWire);
    assert.ok(decodedPsi, 'Decoded psi-table wire document');
    assert.strictEqual(decodedPsi.children.length, psiRuntime.children.length, 'Root node count matches');
    assert.deepStrictEqual(
        decodedPsi.children.map((c: any) => c.nodeType),
        psiRuntime.children.map((c: any) => c.nodeType),
        'Node types match ([18, 17, 0])'
    );

    // Text content matches
    const textNode = decodedPsi.children[0] as any;
    assert.strictEqual(textNode.text, psiRuntime.children[0].text);

    // Table shape, cell counts, and math intact
    const decodedTable = decodedPsi.children[1] as any;
    const runtimeTable = psiRuntime.children[1] as any;
    assert.strictEqual(decodedTable.rows.length, runtimeTable.rows.length, 'Row count matches (5 rows)');
    for (let r = 0; r < decodedTable.rows.length; r++) {
        assert.strictEqual(decodedTable.rows[r].cells.length, 3, `Row ${r} has 3 cells`);
    }

    // Verify cell math annotations in row 1 cell 2 (psi table cell)
    const decodedMathCell = decodedTable.rows[1].cells[2];
    const mathChild = decodedMathCell.children.find((c: any) => c.text && c.text.includes('\\Vert{}\\psi'));
    assert.ok(mathChild, 'Found math text child in row 1 cell 2');
    const mathAnnot = mathChild.annotations?.find((a: any) => a.type === 4);
    assert.ok(mathAnnot, 'Inline math annotation exists in decoded wire cell');
    assert.strictEqual(mathAnnot.type, 4);

    // 2. B-stack wire fixture: real turn[3][12] from probe case-b turn 1 (display math + lists + headings)
    const bWire = loadProbeFixture('wire-turn-3-12-b-stack.json');
    const bRuntime = loadProbeFixture('b-stack-structured.json');

    const decodedB = decodeGeminiStructuredPayload(bWire);
    assert.ok(decodedB, 'Decoded b-stack wire document');
    assert.strictEqual(decodedB.children.length, bRuntime.children.length, 'Root node count matches (49)');

    // Compare all 13 display math nodes
    const decodedMath = decodedB.children.filter((c: any) => c.nodeType === 12);
    const runtimeMath = bRuntime.children.filter((c: any) => c.nodeType === 12);
    assert.strictEqual(decodedMath.length, 13, 'Contains 13 display math blocks');
    assert.strictEqual(runtimeMath.length, 13, 'Runtime contains 13 display math blocks');
    for (let i = 0; i < decodedMath.length; i++) {
        assert.strictEqual((decodedMath[i] as any).FTa, (runtimeMath[i] as any).FTa, `Display math ${i} matches`);
    }
});

test('Nested unknown node in list/table/blockquote fails closed to Markdown parser', async () => {
    // 1. List with unsupported child: item 0 known, item 1 has unknown child, item 2 known
    const listConv = {
        id: 'c_nested_list',
        title: 'Nested List Unknown',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Raw list markdown fallback',
                structuredContent: {
                    children: [
                        {
                            nodeType: 20,
                            items: [
                                { children: [{ nodeType: 18, text: 'Item 1' }] },
                                { children: [{ nodeType: 9999, weird: 'data' }] }, // Unsupported!
                                { children: [{ nodeType: 18, text: 'Item 3' }] },
                            ],
                        },
                    ],
                },
            },
        ],
    };

    const resList = await normalizeGeminiConversation(listConv as any);
    assert.strictEqual(
        resList.bundle.conversation.messages[0].blocks[0].children[0].text,
        'Raw list markdown fallback',
        'List with unknown child must fail closed to markdown without silent item dropping'
    );

    // 2. Table with unsupported cell child
    const tableConv = {
        id: 'c_nested_table',
        title: 'Nested Table Unknown',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Raw table markdown fallback',
                structuredContent: {
                    children: [
                        {
                            nodeType: 17,
                            rows: [
                                {
                                    cells: [
                                        { children: [{ nodeType: 18, text: 'Cell 1' }] },
                                        { children: [{ nodeType: 9999, weird: 'data' }] },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            },
        ],
    };

    const resTable = await normalizeGeminiConversation(tableConv as any);
    assert.strictEqual(
        resTable.bundle.conversation.messages[0].blocks[0].children[0].text,
        'Raw table markdown fallback',
        'Table with unknown cell child must fail closed to markdown'
    );

    // 3. Blockquote with unsupported child
    const bqConv = {
        id: 'c_nested_bq',
        title: 'Nested Blockquote Unknown',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Raw bq markdown fallback',
                structuredContent: {
                    children: [
                        {
                            nodeType: 15,
                            children: [
                                { nodeType: 18, text: 'Quote 1' },
                                { nodeType: 9999, weird: 'data' },
                            ],
                        },
                    ],
                },
            },
        ],
    };

    const resBq = await normalizeGeminiConversation(bqConv as any);
    assert.strictEqual(
        resBq.bundle.conversation.messages[0].blocks[0].children[0].text,
        'Raw bq markdown fallback',
        'Blockquote with unknown child must fail closed to markdown'
    );
});

test('Unknown annotation shape/type fails closed and is never coerced to bold', async () => {
    // 1. Direct decoder checks: unknown annotation type must return null, never 0 (bold)
    assert.strictEqual(decodeGeminiAnnotation({ start: 0, end: 5, type: 999 }), null);
    assert.strictEqual(decodeGeminiAnnotation([0, 5, [[null, null, null, null, 999]]]), null);
    assert.strictEqual(decodeGeminiAnnotation([0, 5, [null, 'unknown-shape']]), null);

    // 2. Integration check: text node with unknown annotation falls back to raw markdown
    const conv = {
        id: 'c_unknown_annot',
        title: 'Unknown Annotation Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Raw markdown fallback for unknown annotation',
                structuredContent: {
                    children: [
                        {
                            nodeType: 18,
                            text: 'Text with unknown annotation',
                            annotations: [
                                { start: 0, end: 4, type: 999 }, // Unknown type!
                            ],
                        },
                    ],
                },
            },
        ],
    };

    const res = await normalizeGeminiConversation(conv as any);
    const msg = res.bundle.conversation.messages[0];
    assert.strictEqual(
        msg.blocks[0].children[0].text,
        'Raw markdown fallback for unknown annotation',
        'Unknown annotation must trigger Markdown fallback instead of guessing as bold'
    );
});

test('Multi-candidate turn attaches structuredContent only to proven candidate 0', async () => {
    const wirePsi = loadProbeFixture('wire-turn-3-12-psi-table.json');

    // Turn with 2 candidates: candidate 0 (primary) and candidate 1 (alternative draft)
    const multiCandTurn = [
        'r_multicand_turn',
        [1700000000, 0],
        [['What is a qubit?']],
        [
            // Model payload:
            // candidate 0: rc_0
            // candidate 1: rc_1
            [
                ['rc_0', [null, ['Draft 0 raw text']]],
                ['rc_1', [null, ['Draft 1 raw text']]],
            ],
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            wirePsi, // turn[3][12] structured document
        ],
    ];

    // Primary candidate (candidateIndex = 0)
    const struct0 = extractStructuredContent(multiCandTurn, multiCandTurn[3][0][0], 0);
    assert.ok(struct0, 'Candidate 0 receives structured content from turn[3][12]');
    assert.strictEqual(struct0.children.length, 3);

    // Alternative candidate (candidateIndex = 1)
    const struct1 = extractStructuredContent(multiCandTurn, multiCandTurn[3][0][1], 1);
    assert.strictEqual(struct1, undefined, 'Candidate 1+ must NOT receive turn[3][12] without proven evidence');

    // Verify end-to-end normalization of multi-candidate messages
    const conv = {
        id: 'c_multicand',
        title: 'Multi-Candidate Normalization',
        messages: [
            {
                id: 'm_cand0',
                role: 'model',
                content: 'Draft 0 raw text',
                structuredContent: struct0,
            },
            {
                id: 'm_cand1',
                role: 'model',
                content: 'Draft 1 raw text: **bold from markdown**',
                structuredContent: struct1, // undefined
            },
        ],
    };

    const res = await normalizeGeminiConversation(conv as any);
    const msg0 = res.bundle.conversation.messages[0];
    const msg1 = res.bundle.conversation.messages[1];

    // msg0 used structured content (contains table block)
    const tableBlock0 = msg0.blocks.find((b: any) => b.type === 'table');
    assert.ok(tableBlock0, 'Candidate 0 has table block from structured path');

    // msg1 used markdown fallback (contains paragraph with strong inline)
    assert.strictEqual(msg1.blocks.length, 1);
    assert.strictEqual(msg1.blocks[0].type, 'paragraph');
    const strong1 = msg1.blocks[0].children.find((c: any) => c.type === 'strong');
    assert.ok(strong1, 'Candidate 1 used markdown parser for bold');
    assert.strictEqual(strong1.children[0].text, 'bold from markdown');
});

test('Wire JSPB decoding in Gemini parser layer', () => {
    // Construct wire JSPB node for display math: field 34
    const wireMathNode = new Array(35).fill(null);
    wireMathNode[34] = ['\\sum_{i=1}^n i = \\frac{n(n+1)}{2}'];

    // Construct wire JSPB node for paragraph with inline math annotation
    const wireTextNode = [
        null,
        [null, 0, 'The formula is \\alpha + \\beta', [[15, 30, [null, null, []]]]],
    ];

    // Construct wire JSPB node for code block
    const wireCodeNode = [null, null, null, ['console.log(42);', 'typescript']];

    const wirePayload = [[[wireTextNode, wireMathNode, wireCodeNode]]];

    const decoded = decodeGeminiStructuredPayload(wirePayload);
    assert.ok(decoded, 'Decoded structured document');
    assert.strictEqual(decoded.children.length, 3);
    assert.strictEqual(decoded.children[0].nodeType, 18);
    assert.strictEqual(decoded.children[1].nodeType, 12);
    assert.strictEqual((decoded.children[1] as any).FTa, '\\sum_{i=1}^n i = \\frac{n(n+1)}{2}');
    assert.strictEqual(decoded.children[2].nodeType, 1);
    assert.strictEqual((decoded.children[2] as any).code, 'console.log(42);');
    assert.strictEqual((decoded.children[2] as any).info, 'typescript');

    // Test extractStructuredContent from turn
    const mockTurn = [
        'r_123',
        [1700000000, 0],
        [['User question']],
        [[['rc_ans', [null, ['Answer text']]]], null, null, null, null, null, null, null, null, null, null, null, wirePayload],
    ];

    const extracted = extractStructuredContent(mockTurn);
    assert.ok(extracted, 'Extracted structured document from turn');
    assert.strictEqual(extracted.children.length, 3);
});

test('Fallback: missing structuredContent falls back to existing Markdown parser', async () => {
    const conv = {
        id: 'c_fallback_missing',
        title: 'Fallback Missing Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: '# Header\n\nParagraph with **bold** text and `inline code`.',
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(conv as any);
    const msg = bundle.conversation.messages[0];
    assert.strictEqual(msg.blocks.length, 2);
    assert.strictEqual(msg.blocks[0].type, 'heading');
    assert.strictEqual(msg.blocks[1].type, 'paragraph');

    const strong = msg.blocks[1].children.find((c: any) => c.type === 'strong');
    assert.ok(strong, 'Markdown parser bold succeeded');
});

test('Fallback: unknown nodeType triggers complete fallback to Markdown parser', async () => {
    const conv = {
        id: 'c_fallback_unknown',
        title: 'Fallback Unknown Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Fallback to markdown text when structured has unknown nodeType.',
                structuredContent: {
                    children: [
                        { nodeType: 18, text: 'Normal text' },
                        { nodeType: 9999, weirdField: 'unknown' }, // Unknown nodeType!
                    ],
                },
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(conv as any);
    const msg = bundle.conversation.messages[0];
    assert.strictEqual(msg.blocks.length, 1);
    assert.strictEqual(msg.blocks[0].type, 'paragraph');
    assert.strictEqual(msg.blocks[0].children[0].text, 'Fallback to markdown text when structured has unknown nodeType.');
});

test('Fallback: crossing overlap annotations trigger fallback to Markdown parser', async () => {
    const conv = {
        id: 'c_fallback_overlap',
        title: 'Fallback Overlap Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Fallback text on crossing overlap.',
                structuredContent: {
                    children: [
                        {
                            nodeType: 18,
                            text: 'ABCDEFGHIJ',
                            annotations: [
                                { start: 0, end: 6, type: 0 }, // 0..6
                                { start: 3, end: 9, type: 2 }, // 3..9 (crosses 0..6!)
                            ],
                        },
                    ],
                },
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(conv as any);
    const msg = bundle.conversation.messages[0];
    assert.strictEqual(msg.blocks.length, 1);
    assert.strictEqual(msg.blocks[0].children[0].text, 'Fallback text on crossing overlap.');
});

test('Fallback: empty structured document with non-empty raw markdown triggers fallback', async () => {
    const conv = {
        id: 'c_fallback_empty',
        title: 'Fallback Empty Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Non-empty raw markdown should not be lost if structured is empty.',
                structuredContent: {
                    children: [],
                },
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(conv as any);
    const msg = bundle.conversation.messages[0];
    assert.strictEqual(msg.blocks.length, 1);
    assert.strictEqual(msg.blocks[0].children[0].text, 'Non-empty raw markdown should not be lost if structured is empty.');
});

test('Generic HTML renderer renders Canonical AST from structured path cleanly', async () => {
    const conv = {
        id: 'c_html_compat',
        title: 'HTML Compat Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'raw',
                structuredContent: {
                    children: [
                        { nodeType: 18, text: 'Heading 2 Title', jJ: 2 },
                        { nodeType: 18, text: 'Paragraph with math ', annotations: [{ start: 10, end: 14, type: 4 }] },
                        { nodeType: 12, FTa: '\\int_0^1 f(x) dx' },
                        { nodeType: 1, code: 'print("hello")', info: 'python' },
                        {
                            nodeType: 20,
                            items: [
                                { children: [{ nodeType: 18, text: 'Item 1' }] },
                                { children: [{ nodeType: 18, text: 'Item 2' }] },
                            ],
                        },
                    ],
                },
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(conv as any);
    const { html } = renderCanonicalHtml(bundle);
    assert.ok(html.includes('<h2'), 'Heading 2 rendered');
    assert.ok(html.includes('Heading 2 Title'), 'Heading text rendered');
    assert.ok(html.includes('language-python'), 'Code block rendered with language');
    assert.ok(html.includes('print(&quot;hello&quot;)'), 'Code rendered');
    assert.ok(html.includes('<ul'), 'Unordered list rendered');
    assert.ok(html.includes('<li>'), 'List item rendered');
});

test('PR #705 regression: nodeType 0 with attachmentType 36 (search image) preserved via existing asset pipeline without duplication', async () => {
    const bWire = loadProbeFixture('wire-turn-3-12-b-stack.json');
    const bRuntime = loadProbeFixture('b-stack-structured.json');

    // 1. extractImages extracts the image attachment from both wire and runtime representations
    const wireImages = extractImages(bWire);
    assert.strictEqual(wireImages.length, 1, 'Wire fixture yields 1 image attachment');
    assert.strictEqual(wireImages[0].fileName, '贝尔测试实验示意图.png');
    assert.strictEqual(wireImages[0].width, 700);
    assert.strictEqual(wireImages[0].height, 280);
    assert.ok(wireImages[0].sourceUrl.startsWith('https://encrypted-tbn0.gstatic.com'), 'Uses whitelisted Google media host');

    const runtimeImages = extractImages(bRuntime);
    assert.strictEqual(runtimeImages.length, 1, 'Runtime fixture yields 1 image attachment');
    assert.strictEqual(runtimeImages[0].fileName, '贝尔测试实验示意图.png');
    assert.strictEqual(runtimeImages[0].width, 700);
    assert.strictEqual(runtimeImages[0].height, 280);
    assert.strictEqual(runtimeImages[0].sourceUrl, wireImages[0].sourceUrl, 'Source URLs match between wire and runtime');

    // 2. Normalizing message with structuredContent preserves the image in Canonical AST
    const conv = {
        id: 'c_attachment36_test',
        title: 'Attachment 36 Preservation Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'raw',
                structuredContent: bRuntime,
            },
        ],
    };

    const { bundle, diagnostics } = await normalizeGeminiConversation(conv as any);
    const errorDiags = diagnostics.filter((d: any) => d.severity === 'error');
    assert.strictEqual(errorDiags.length, 0, 'No error diagnostics during normalization');

    const msg = bundle.conversation.messages[0];
    const imageBlocks = msg.blocks.filter((b: any) => b.type === 'image');
    assert.strictEqual(imageBlocks.length, 1, 'Exactly 1 image block placed in Canonical message');
    assert.strictEqual(imageBlocks[0].alt, '贝尔测试实验示意图.png');

    // Exactly 1 asset in bundle (no duplicate)
    assert.strictEqual(bundle.assets.length, 1, 'Exactly 1 asset in bundle');
    const asset = bundle.assets[0];
    assert.strictEqual(asset.kind, 'image');
    assert.strictEqual(asset.name, '贝尔测试实验示意图.png');
    assert.deepStrictEqual(asset.dimensions, { widthPx: 700, heightPx: 280 });
    assert.strictEqual(asset.id, imageBlocks[0].assetId, 'Block assetId links to bundle asset ID');

    // Validate the canonical bundle
    const bundleErrors = validateBundle(bundle).filter((d: any) => d.severity === 'error');
    assert.strictEqual(bundleErrors.length, 0, 'Bundle validates cleanly against Canonical schema');
});

test('PR #705 candidate wire fixture: candidate response parser preserves search image in both structured and fallback modes', async () => {
    const cand = loadProbeFixture('wire-case-b-cand.json');
    const bWire = loadProbeFixture('wire-turn-3-12-b-stack.json');

    // 1. Candidate array itself contains the search image in its attachment slot
    const candImages = extractImages(cand);
    assert.strictEqual(candImages.length, 1, 'extractImages(cand) extracts 1 image');
    assert.strictEqual(candImages[0].width, 700);
    assert.strictEqual(candImages[0].height, 280);
    assert.ok(candImages[0].sourceUrl.startsWith('https://encrypted-tbn0.gstatic.com'));

    // 2. Structured path normalization
    const convStructured = {
        id: 'c_cand_wire_test',
        title: 'Candidate Wire Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'raw content',
                images: candImages,
                structuredContent: decodeGeminiStructuredPayload(bWire),
            },
        ],
    };

    const resStructured = await normalizeGeminiConversation(convStructured as any);
    const msgStructured = resStructured.bundle.conversation.messages[0];
    const imgBlocksStructured = msgStructured.blocks.filter((b: any) => b.type === 'image');
    assert.strictEqual(imgBlocksStructured.length, 1, 'Structured path has exactly 1 image block');
    assert.strictEqual(resStructured.bundle.assets.length, 1, 'Structured path has exactly 1 asset');

    // 3. Fallback markdown path normalization (without structuredContent)
    const convFallback = {
        id: 'c_cand_fallback_test',
        title: 'Candidate Fallback Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'raw content without structured',
                images: candImages,
            },
        ],
    };

    const resFallback = await normalizeGeminiConversation(convFallback as any);
    const msgFallback = resFallback.bundle.conversation.messages[0];
    const imgBlocksFallback = msgFallback.blocks.filter((b: any) => b.type === 'image');
    assert.strictEqual(imgBlocksFallback.length, 1, 'Fallback path has exactly 1 image block');
    assert.strictEqual(resFallback.bundle.assets.length, 1, 'Fallback path has exactly 1 asset');
});

test('UI-only nodeType 0 (e.g. attachmentType 22/26 follow-up chips) continue to be skipped without creating unknown blocks or assets', async () => {
    const psiRuntime = loadProbeFixture('psi-table-stack-structured.json');

    // extractImages on UI chips returns empty
    const imgs = extractImages(psiRuntime);
    assert.strictEqual(imgs.length, 0, 'UI chips do not extract as images');

    // Normalizing conversation with UI chips produces 0 image blocks and 0 assets
    const conv = {
        id: 'c_chips_test',
        title: 'UI Chips Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'raw',
                structuredContent: psiRuntime,
            },
        ],
    };

    const { bundle, diagnostics } = await normalizeGeminiConversation(conv as any);
    const msg = bundle.conversation.messages[0];
    const imageBlocks = msg.blocks.filter((b: any) => b.type === 'image');
    assert.strictEqual(imageBlocks.length, 0, 'UI chips create 0 image blocks');
    assert.strictEqual(bundle.assets.length, 0, 'UI chips create 0 assets');

    // Only text paragraph and table blocks present
    assert.strictEqual(msg.blocks.length, 2);
    assert.strictEqual(msg.blocks[0].type, 'paragraph');
    assert.strictEqual(msg.blocks[1].type, 'table');
});

