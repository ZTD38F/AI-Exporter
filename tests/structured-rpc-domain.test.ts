import { sourceConversation } from './helpers/l1SourceFixture.js';
/**
 * 1. Structured path is actively used (decision point prioritized over Markdown parser).
 * 2. #705 Divergence cases:
 *    - Display math (multiline and after prose) mapped directly to Canonical math block.
 *    - Table + math pipe ($|\alpha|^2$ and $\|\psi\rangle$) preserving intact cells and math.
 * 5. Fallback semantics:
 *    - Missing structuredContent -> fallback to Markdown parser.
 *    - Unknown nodeType -> fallback to Markdown parser.
 *    - Malformed node / crossing annotations -> fallback to Markdown parser.
 *    - Empty structured doc with non-empty raw markdown -> fallback to Markdown parser.
 */
export {};
const test = require('node:test');
import assert from 'node:assert/strict';
const fs = require('fs');
const path = require('path');

const { assertDomainClosure } = require('../src/l2/closure.js');
const {
    convertGeminiInlines,
} = require('../src/l1/parsers/gemini/shared/structuredContentAdapter.js');
const {
    decodeGeminiAnnotation,
    decodeGeminiStructuredNode,
    decodeGeminiStructuredPayload,
    inspectStructuredContent,
} = require('../src/l1/parsers/gemini/rpc/structuredContent.js');
const { decodeGeminiDetail } = require('../src/l1/parsers/gemini/rpc/detailDecoder.js');
const { decodeTurn } = require('../src/l1/parsers/gemini/rpc/extractors.js');
const { extractImageEvidence: extractImages } = require('../src/l1/parsers/gemini/rpc/sourceAttachments.js');

import type { BlockNode } from '../src/l2/content/blocks.js';
import type { InlineNode } from '../src/l2/content/inline.js';
function firstText(block: BlockNode): string {
    assert.ok(block.type === 'paragraph');
    return inlineText(block.children[0]);
}
function inlineText(inline: InlineNode): string {
    assert.ok(inline.type === 'text');
    return inline.text;
}

const fixturesDir = path.join(__dirname, 'fixtures', 'provider', 'structured_rpc');

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

    const { conversation: domain, diagnostics } = await sourceConversation(conv as any);
    assert.strictEqual(diagnostics.filter((d: any) => d.severity === 'error').length, 0);

    const modelMsg = domain.detail.messages.find((m: any) => m.id === 'm2');
    assert.ok(modelMsg, 'Model message present');

    assert.strictEqual(modelMsg.content.length, 2);
    assert.strictEqual(modelMsg.content[0].type, 'paragraph');
    assert.ok(modelMsg.content[0]?.type === 'paragraph');
    assert.strictEqual(modelMsg.content[1].type, 'math');
    assert.ok(modelMsg.content[1]?.type === 'math');

    const p = modelMsg.content[0];
    const strongInline = p.children.find((c: any) => c.type === 'strong');
    assert.ok(strongInline?.type === 'strong');
    assert.ok(strongInline, 'Strong inline exists from annotation');
    assert.strictEqual(inlineText(strongInline.children[0]), 'structured');

    const math = modelMsg.content[1];
    assert.strictEqual(math.source, 'E = mc^2');

    const allText = JSON.stringify(modelMsg.content);
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

    const { conversation: domain } = await sourceConversation(conv as any);
    const msg = domain.detail.messages[0];
    assert.strictEqual(msg.content.length, 3);
    assert.strictEqual(msg.content[0].type, 'paragraph');
    assert.ok(msg.content[0]?.type === 'paragraph');
    assert.strictEqual(msg.content[1].type, 'math');
    assert.ok(msg.content[1]?.type === 'math');
    assert.strictEqual(msg.content[2].type, 'math');
    assert.ok(msg.content[2]?.type === 'math');

    const math1 = msg.content[1];
    assert.strictEqual(math1.source, multilineFormula);

    const math2 = msg.content[2];
    assert.strictEqual(math2.source, afterProseFormula);
});

test('#705 Divergence Case: Table + Math Pipe (|alpha|^2 and ||psi>) cell count and math intact', async () => {
    const tableFixture = loadProbeFixture('table-stack-structured.json');
    const psiTableFixture = loadProbeFixture('psi-table-stack-structured.json');

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

    const { conversation: domainAlpha } = await sourceConversation(convAlpha as any);
    const msgAlpha = domainAlpha.detail.messages[0];
    const tableBlockAlpha = msgAlpha.content.find((b: any) => b.type === 'table');
    assert.ok(tableBlockAlpha?.type === 'table');
    assert.ok(tableBlockAlpha, 'Table block exists for Case C-alpha');

    assert.ok(tableBlockAlpha.headerRows);
    assert.strictEqual(tableBlockAlpha.headerRows.length, 1);
    assert.strictEqual(tableBlockAlpha.headerRows[0].cells.length, 5);

    assert.strictEqual(tableBlockAlpha.rows.length, 4);
    for (let r = 0; r < tableBlockAlpha.rows.length; r++) {
        assert.strictEqual(tableBlockAlpha.rows[r].cells.length, 5, `Row ${r} must have 5 cells`);
    }

    const cellAlpha = tableBlockAlpha.rows[1].cells[4]; // row 2 in 0-indexed data rows is index 1
    const mathNodeAlpha = cellAlpha.children.find((c: any) => c.type === 'inlineMath' && c.source.includes('\\alpha'));
    assert.ok(mathNodeAlpha?.type === 'inlineMath');
    assert.ok(mathNodeAlpha, 'InlineMath node found in table cell');
    assert.strictEqual(mathNodeAlpha.source, String.raw`|\alpha|^2`);

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

    const { conversation: domainPsi } = await sourceConversation(convPsi as any);
    const msgPsi = domainPsi.detail.messages[0];
    const tableBlockPsi = msgPsi.content.find((b: any) => b.type === 'table');
    assert.ok(tableBlockPsi?.type === 'table');
    assert.ok(tableBlockPsi, 'Table block exists for Case C-psi');

    assert.ok(tableBlockPsi.headerRows);
    assert.strictEqual(tableBlockPsi.headerRows[0].cells.length, 3);
    for (let r = 0; r < tableBlockPsi.rows.length; r++) {
        assert.strictEqual(tableBlockPsi.rows[r].cells.length, 3, `Row ${r} must have 3 cells`);
    }

    // GM-TEX-003 retains double norm bars, distinct from the absolute bars above.
    const cellPsi = tableBlockPsi.rows[0].cells[2];
    const mathNodePsi = cellPsi.children.find((c: any) => c.type === 'inlineMath' && c.source.includes('\\|\\psi'));
    assert.ok(mathNodePsi?.type === 'inlineMath');
    assert.ok(mathNodePsi, 'InlineMath node found in table cell for psi');
    assert.ok(mathNodePsi.source.includes(String.raw`\|\psi\rangle`), 'Math source retains double bars and the ket closing delimiter');
});

test('Real Tier 2 probe data: full documents validate cleanly against Domain closure', async () => {
    const aStack = loadProbeFixture('a-stack-structured.json');
    const bStack = loadProbeFixture('b-stack-structured.json');

    assert.strictEqual(aStack.children.length, 50);
    const convA = {
        id: 'c_probe_a',
        title: 'Case A Multiline Display',
        messages: [{ id: 'm1', role: 'model', content: 'raw', structuredContent: aStack }],
    };
    const resA = await sourceConversation(convA as any);
    assert.doesNotThrow(() => assertDomainClosure((resA.conversation).detail));

    assert.strictEqual(bStack.children.length, 49);
    const convB = {
        id: 'c_probe_b',
        title: 'Case B Display After Text',
        messages: [{ id: 'm1', role: 'model', content: 'raw', structuredContent: bStack }],
    };
    const resB = await sourceConversation(convB as any);
    assert.doesNotThrow(() => assertDomainClosure((resB.conversation).detail));
});

test('Real wire decode: sanitized hNvQHb field 12 fixtures match runtime probe fixtures', () => {
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

    const textNode = decodedPsi.children[0] as any;
    assert.strictEqual(textNode.text, psiRuntime.children[0].text);

    const decodedTable = decodedPsi.children[1] as any;
    const runtimeTable = psiRuntime.children[1] as any;
    assert.strictEqual(decodedTable.rows.length, runtimeTable.rows.length, 'Row count matches (5 rows)');
    for (let r = 0; r < decodedTable.rows.length; r++) {
        assert.strictEqual(decodedTable.rows[r].cells.length, 3, `Row ${r} has 3 cells`);
    }

    const decodedMathCell = decodedTable.rows[1].cells[2];
    const mathChild = decodedMathCell.children.find((c: any) => c.text && c.text.includes('\\Vert{}\\psi'));
    assert.ok(mathChild, 'Found math text child in row 1 cell 2');
    const mathAnnot = mathChild.annotations?.find((a: any) => a.type === 4);
    assert.ok(mathAnnot, 'Inline math annotation exists in decoded wire cell');
    assert.strictEqual(mathAnnot.type, 4);

    const bWire = loadProbeFixture('wire-turn-3-12-b-stack.json');
    const bRuntime = loadProbeFixture('b-stack-structured.json');

    const decodedB = decodeGeminiStructuredPayload(bWire);
    assert.ok(decodedB, 'Decoded b-stack wire document');
    assert.strictEqual(decodedB.children.length, bRuntime.children.length, 'Root node count matches (49)');

    const decodedMath = decodedB.children.filter((c: any) => c.nodeType === 12);
    const runtimeMath = bRuntime.children.filter((c: any) => c.nodeType === 12);
    assert.strictEqual(decodedMath.length, 13, 'Contains 13 display math blocks');
    assert.strictEqual(runtimeMath.length, 13, 'Runtime contains 13 display math blocks');
    for (let i = 0; i < decodedMath.length; i++) {
        assert.strictEqual((decodedMath[i] as any).FTa, (runtimeMath[i] as any).FTa, `Display math ${i} matches`);
    }
});

test('Nested unknown node in list/table/blockquote fails closed to Markdown parser', async () => {
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

    const resList = await sourceConversation(listConv as any);
    assert.strictEqual(
        firstText(resList.conversation.detail.messages[0].content[0]),
        'Raw list markdown fallback',
        'List with unknown child must fail closed to markdown without silent item dropping'
    );

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

    const resTable = await sourceConversation(tableConv as any);
    assert.strictEqual(
        firstText(resTable.conversation.detail.messages[0].content[0]),
        'Raw table markdown fallback',
        'Table with unknown cell child must fail closed to markdown'
    );

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

    const resBq = await sourceConversation(bqConv as any);
    assert.strictEqual(
        firstText(resBq.conversation.detail.messages[0].content[0]),
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

    const res = await sourceConversation(conv as any);
    const msg = res.conversation.detail.messages[0];
    assert.strictEqual(
        firstText(msg.content[0]),
        'Raw markdown fallback for unknown annotation',
        'Unknown annotation must trigger Markdown fallback instead of guessing as bold'
    );
});

test('Multi-candidate turn attaches structuredContent only to proven candidate 0', async () => {
    const wirePsi = loadProbeFixture('wire-turn-3-12-psi-table.json');

    const multiCandTurn = [
        'r_multicand_turn',
        [1700000000, 0],
        [['What is a qubit?']],
        [
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

    const decodedTurn = decodeTurn(multiCandTurn);
    assert.ok(decodedTurn);

    const struct0 = inspectStructuredContent({
        candidate: multiCandTurn[3][0][0],
        turnDocument: wirePsi,
        candidateIndex: 0
    });
    assert.strictEqual(struct0.status, 'decoded', 'Candidate 0 receives structured content from turn[3][12]');
    if (struct0.status !== 'decoded') throw new Error('Primary candidate structured decode failed');
    assert.strictEqual(struct0.document.children.length, 3);

    const struct1 = inspectStructuredContent({
        candidate: multiCandTurn[3][0][1],
        turnDocument: wirePsi,
        candidateIndex: 1
    });
    assert.strictEqual(struct1.status, 'candidate_unmatched', 'Candidate 1+ must NOT receive turn[3][12] without proven evidence');

    const conv = {
        id: 'c_multicand',
        title: 'Multi-Candidate Normalization',
        messages: [
            {
                id: 'm_cand0',
                role: 'model',
                content: 'Draft 0 raw text',
                structuredContent: struct0.document,
            },
            {
                id: 'm_cand1',
                role: 'model',
                content: 'Draft 1 raw text: **bold from markdown**',
            },
        ],
    };

    const res = await sourceConversation(conv as any);
    const msg0 = res.conversation.detail.messages[0];
    const msg1 = res.conversation.detail.messages[1];

    const tableBlock0 = msg0.content.find((b: any) => b.type === 'table');
    assert.ok(tableBlock0?.type === 'table');
    assert.ok(tableBlock0, 'Candidate 0 has table block from structured path');

    assert.strictEqual(msg1.content.length, 1);
    assert.strictEqual(msg1.content[0].type, 'paragraph');
    assert.ok(msg1.content[0]?.type === 'paragraph');
    const strong1 = msg1.content[0].children.find((c: any) => c.type === 'strong');
    assert.ok(strong1?.type === 'strong');
    assert.ok(strong1, 'Candidate 1 used markdown parser for bold');
    assert.strictEqual(inlineText(strong1.children[0]), 'bold from markdown');
});

test('Wire JSPB decoding in Gemini parser layer', () => {
    const wireMathNode = new Array(35).fill(null);
    wireMathNode[34] = ['\\sum_{i=1}^n i = \\frac{n(n+1)}{2}'];

    const wireTextNode = [
        null,
        [null, 0, 'The formula is \\alpha + \\beta', [[15, 30, [null, null, []]]]],
    ];

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

    // The Turn decoder exposes only typed facts; the structured decoder reads its own wire evidence.
    const mockCandidate = ['rc_ans', [null, ['Answer text']]];
    const mockTurn = [
        'r_123',
        [1700000000, 0],
        [['User question']],
        [[mockCandidate], null, null, null, null, null, null, null, null, null, null, null, wirePayload],
    ];
    const decodedTurn = decodeTurn(mockTurn);
    assert.ok(decodedTurn);
    const extracted = inspectStructuredContent({
        candidate: mockCandidate,
        turnDocument: wirePayload,
        candidateIndex: decodedTurn.candidate.index
    });
    assert.strictEqual(extracted.status, 'decoded', 'Extracted structured document from the decoded Turn evidence');
    if (extracted.status !== 'decoded') throw new Error('Expected decoded structured turn');
    assert.strictEqual(extracted.document.children.length, 3);
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

    const { conversation: domain } = await sourceConversation(conv as any);
    const msg = domain.detail.messages[0];
    assert.strictEqual(msg.content.length, 2);
    assert.strictEqual(msg.content[0].type, 'heading');
    assert.ok(msg.content[0]?.type === 'heading');
    assert.strictEqual(msg.content[1].type, 'paragraph');
    assert.ok(msg.content[1]?.type === 'paragraph');

    const strong = msg.content[1].children.find((c: any) => c.type === 'strong');
    assert.ok(strong?.type === 'strong');
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

    const { conversation: domain } = await sourceConversation(conv as any);
    const msg = domain.detail.messages[0];
    assert.strictEqual(msg.content.length, 1);
    assert.strictEqual(msg.content[0].type, 'paragraph');
    assert.ok(msg.content[0]?.type === 'paragraph');
    assert.strictEqual(firstText(msg.content[0]), 'Fallback to markdown text when structured has unknown nodeType.');
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

    const { conversation: domain } = await sourceConversation(conv as any);
    const msg = domain.detail.messages[0];
    assert.strictEqual(msg.content.length, 1);
    assert.strictEqual(firstText(msg.content[0]), 'Fallback text on crossing overlap.');
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

    const { conversation: domain } = await sourceConversation(conv as any);
    const msg = domain.detail.messages[0];
    assert.strictEqual(msg.content.length, 1);
    assert.strictEqual(firstText(msg.content[0]), 'Non-empty raw markdown should not be lost if structured is empty.');
});

test('structured source AST retains headings, math, code and lists', async () => {
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

    const { conversation: domain } = await sourceConversation(conv as any);
    assert.deepEqual(domain.detail.messages[0].content.map((block: any) => block.type), ['heading', 'paragraph', 'math', 'code', 'list']);
    assertDomainClosure(domain.detail);
});

test('PR #705 regression: nodeType 0 with attachmentType 36 (search image) preserved via existing asset pipeline without duplication', async () => {
    const bWire = loadProbeFixture('wire-turn-3-12-b-stack.json');
    const bRuntime = loadProbeFixture('b-stack-structured.json');

    const wireImages = extractImages(bWire);
    assert.strictEqual(wireImages.length, 1, 'Wire fixture yields 1 image attachment');
    assert.strictEqual(wireImages[0].title, '贝尔测试实验示意图');
    assert.strictEqual(wireImages[0].width, 700);
    assert.strictEqual(wireImages[0].height, 280);
    assert.ok(wireImages[0].sourceUrl.startsWith('https://encrypted-tbn0.gstatic.com'), 'Uses whitelisted Google media host');

    const runtimeImages = extractImages(bRuntime);
    assert.strictEqual(runtimeImages.length, 1, 'Runtime fixture yields 1 image attachment');
    assert.strictEqual(runtimeImages[0].title, '贝尔测试实验示意图');
    assert.strictEqual(runtimeImages[0].width, 700);
    assert.strictEqual(runtimeImages[0].height, 280);
    assert.strictEqual(runtimeImages[0].sourceUrl, wireImages[0].sourceUrl, 'Source URLs match between wire and runtime');

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

    const { conversation: domain, diagnostics } = await sourceConversation(conv as any);
    const errorDiags = diagnostics.filter((d: any) => d.severity === 'error');
    assert.strictEqual(errorDiags.length, 0, 'No error diagnostics during normalization');

    const msg = domain.detail.messages[0];
    const imageBlocks = domain.detail.messages[0].attachmentIds ?? [];
    assert.strictEqual(imageBlocks.length, 1, 'Exactly 1 image block placed in Domain message');
    assert.equal(domain.detail.assets[0].name, '贝尔测试实验示意图');

    assert.strictEqual(domain.detail.assets.length, 1, 'Exactly 1 asset in bundle');
    const asset = domain.detail.assets[0];
    assert.strictEqual(asset.kind, 'image');
    assert.strictEqual(asset.name, '贝尔测试实验示意图');
    assert.equal(Object.hasOwn(asset, 'dimensions'), false);
    assert.strictEqual(asset.id, imageBlocks[0], 'Block assetId links to bundle asset ID');

    assert.doesNotThrow(() => assertDomainClosure((domain).detail));
});

test('PR #705 candidate wire fixture: candidate response parser preserves search image in both structured and fallback modes', async () => {
    const cand = loadProbeFixture('wire-case-b-cand.json');
    const bWire = loadProbeFixture('wire-turn-3-12-b-stack.json');

    const candImages = extractImages(cand);
    assert.strictEqual(candImages.length, 1, 'extractImages(cand) extracts 1 image');
    assert.strictEqual(candImages[0].width, 700);
    assert.strictEqual(candImages[0].height, 280);
    assert.ok(candImages[0].sourceUrl.startsWith('https://encrypted-tbn0.gstatic.com'));

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

    const resStructured = await sourceConversation(convStructured as any);
    const msgStructured = resStructured.conversation.detail.messages[0];
    const imgBlocksStructured = resStructured.conversation.detail.messages[0].attachmentIds ?? [];
    assert.strictEqual(imgBlocksStructured.length, 1, 'Structured path has exactly 1 image block');
    assert.strictEqual(resStructured.conversation.detail.assets.length, 1, 'Structured path has exactly 1 asset');

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

    const resFallback = await sourceConversation(convFallback as any);
    const msgFallback = resFallback.conversation.detail.messages[0];
    const imgBlocksFallback = resFallback.conversation.detail.messages[0].attachmentIds ?? [];
    assert.strictEqual(imgBlocksFallback.length, 1, 'Fallback path has exactly 1 image block');
    assert.strictEqual(resFallback.conversation.detail.assets.length, 1, 'Fallback path has exactly 1 asset');
});

test('UI-only nodeType 0 (e.g. attachmentType 22/26 follow-up chips) continue to be skipped without creating unknown blocks or assets', async () => {
    const psiRuntime = loadProbeFixture('psi-table-stack-structured.json');

    const imgs = extractImages(psiRuntime);
    assert.strictEqual(imgs.length, 0, 'UI chips do not extract as images');

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

    const { conversation: domain, diagnostics } = await sourceConversation(conv as any);
    const msg = domain.detail.messages[0];
    const imageBlocks = domain.detail.messages[0].attachmentIds ?? [];
    assert.strictEqual(imageBlocks.length, 0, 'UI chips create 0 image blocks');
    assert.strictEqual(domain.detail.assets.length, 0, 'UI chips create 0 assets');

    assert.strictEqual(msg.content.length, 2);
    assert.strictEqual(msg.content[0].type, 'paragraph');
    assert.ok(msg.content[0]?.type === 'paragraph');
    assert.strictEqual(msg.content[1].type, 'table');
    assert.ok(msg.content[1]?.type === 'table');
});

