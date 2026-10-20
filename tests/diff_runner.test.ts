/**
 * tests/diff_runner.test.ts
 *
 * Tier 1 unit test for Parser Differential Runner (Section 8.4, 22 & Remediation 1.1).
 * Verifies:
 * 1. Semantic AST fingerprint extraction.
 * 2. Unresolved diffs default to 'D_CANNOT_DETERMINE' (Old parser is NOT an oracle).
 * 3. Never auto-classifies differences as 'B_OLD_PARSER_GEMINI_DIALECT' (0 manual override).
 * 4. Math conversion comparison correctly identifies candidate improvements (candidateConversionGain)
 *    and defaults unknown regressions to 'D_CANNOT_DETERMINE'.
 * 5. Default-Semantic Principle: Unknown/future semantic fields produce a diff by default.
 * 6. Minimal canonicalization: Coalescing adjacent inline text nodes and ignoring ephemeral metadata.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const {
    extractAstFingerprint,
    compareMarkdownAst,
    compareMathConversion,
} = require('../scripts/parser_migration/diff_runner.ts');

test('Differential Runner: extracts semantic AST fingerprint', () => {
    const fakeBundle = {
        conversation: {
            messages: [
                {
                    blocks: [
                        { type: 'paragraph', children: [{ type: 'text', text: 'Hello' }] },
                        { type: 'heading', level: 1, text: 'Title' },
                        { type: 'code', code: 'console.log(1)' },
                    ],
                },
            ],
        },
    };

    const fp = extractAstFingerprint(fakeBundle);
    assert.strictEqual(fp.blockCount, 3);
    assert.deepStrictEqual(fp.blockTypes, ['paragraph', 'heading', 'code']);
    assert.strictEqual(fp.totalTextLength, 24);
});

test('Differential Runner: Markdown AST comparison identifies identical structures', () => {
    const bundle = {
        conversation: {
            messages: [{ blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'Sample' }] }] }],
        },
    };

    const result = compareMarkdownAst('Sample', bundle, bundle);
    assert.strictEqual(result.hasDiff, false);
    assert.strictEqual(result.domain, 'markdown');
});

test('Differential Runner: Structural diffs default to D_CANNOT_DETERMINE (No automatic B bias)', () => {
    const bundleBase = {
        conversation: {
            messages: [{ blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'Sample' }] }] }],
        },
    };
    const bundleWithUnknown = {
        conversation: {
            messages: [{ blocks: [{ type: 'unknown', text: 'Sample' }] }],
        },
    };

    // Any diff MUST default to D_CANNOT_DETERMINE: Old parser is NOT an oracle
    const diff = compareMarkdownAst('Sample', bundleBase, bundleWithUnknown);
    assert.strictEqual(diff.hasDiff, true);
    assert.strictEqual(diff.category, 'D_CANNOT_DETERMINE');
    assert.ok(diff.rationale?.includes('Old parser is not an oracle'));
});

test('Differential Runner: Math comparison defaults all diffs to D_CANNOT_DETERMINE with conversion gain flag', () => {
    // Both identical
    const same = compareMathConversion('x^2', { typst: 'x^2' }, { typst: 'x^2' });
    assert.strictEqual(same.hasDiff, false);

    // Candidate converts where baseline failed -> defaults to D_CANNOT_DETERMINE, records candidateConversionGain=true
    const gain = compareMathConversion(
        '\\arg(z)',
        { diagnostic: { code: 'FAILED' } },
        { typst: 'op("arg", limits: #false)(z)' }
    );
    assert.strictEqual(gain.hasDiff, true);
    assert.strictEqual(gain.category, 'D_CANNOT_DETERMINE');
    assert.strictEqual(gain.candidateConversionGain, true);
    assert.ok(gain.rationale?.includes('Candidate converted LaTeX expression'));

    // Candidate failed where baseline succeeded -> Defaults to D_CANNOT_DETERMINE
    const diverge = compareMathConversion(
        '\\frac{1}{2}',
        { typst: 'frac(1, 2)' },
        { diagnostic: { code: 'FAILED' } }
    );
    assert.strictEqual(diverge.hasDiff, true);
    assert.strictEqual(diverge.category, 'D_CANNOT_DETERMINE');
    assert.strictEqual(diverge.candidateConversionGain, false);
});

test('Differential Runner: Ignores ephemeral IDs when content is identical', () => {
    const bundleA = {
        conversation: {
            messages: [{
                blocks: [{
                    id: 'b-random-uuid-1',
                    type: 'paragraph',
                    children: [{
                        type: 'strong',
                        children: [{ type: 'text', text: 'Important' }],
                    }],
                }],
            }],
        },
    };

    const bundleB = {
        conversation: {
            messages: [{
                blocks: [{
                    id: 'b-completely-different-uuid-2',
                    type: 'paragraph',
                    children: [{
                        type: 'strong',
                        children: [{ type: 'text', text: 'Important' }],
                    }],
                }],
            }],
        },
    };

    const result = compareMarkdownAst('**Important**', bundleA, bundleB);
    assert.strictEqual(result.hasDiff, false, 'Ephemeral metadata differences must not trigger a semantic diff');
});

test('Differential Runner: Recursively catches lost formatting (strong -> text)', () => {
    const bundleWithBold = {
        conversation: {
            messages: [{
                blocks: [{
                    type: 'paragraph',
                    children: [{
                        type: 'strong',
                        children: [{ type: 'text', text: 'Important' }],
                    }],
                }],
            }],
        },
    };

    const bundleWithPlainText = {
        conversation: {
            messages: [{
                blocks: [{
                    type: 'paragraph',
                    children: [{
                        type: 'text',
                        text: 'Important',
                    }],
                }],
            }],
        },
    };

    const result = compareMarkdownAst('**Important**', bundleWithBold, bundleWithPlainText);
    assert.strictEqual(result.hasDiff, true, 'Dropping strong to plain text must be detected as a diff');
    assert.strictEqual(result.category, 'D_CANNOT_DETERMINE');
    assert.strictEqual(result.rationaleKind, 'FORMATTING_LOST');
    assert.ok(result.rationale?.includes('formatting \'strong\' was lost to plain text'));
});

test('Differential Runner: Recursively catches link href corruption', () => {
    const bundleLinkA = {
        conversation: {
            messages: [{
                blocks: [{
                    type: 'paragraph',
                    children: [{
                        type: 'link',
                        href: 'https://correct.org',
                        children: [{ type: 'text', text: 'Link' }],
                    }],
                }],
            }],
        },
    };

    const bundleLinkB = {
        conversation: {
            messages: [{
                blocks: [{
                    type: 'paragraph',
                    children: [{
                        type: 'link',
                        href: 'https://corrupted.org',
                        children: [{ type: 'text', text: 'Link' }],
                    }],
                }],
            }],
        },
    };

    const result = compareMarkdownAst('[Link](https://correct.org)', bundleLinkA, bundleLinkB);
    assert.strictEqual(result.hasDiff, true);
    assert.strictEqual(result.category, 'D_CANNOT_DETERMINE');
    assert.strictEqual(result.rationaleKind, 'LINK_CORRUPTED');
    assert.ok(result.rationale?.includes('https://correct.org'));
});

test('Differential Runner: Recursively catches table structure and cell alterations', () => {
    const bundleTableA = {
        conversation: {
            messages: [{
                blocks: [{
                    type: 'table',
                    columns: [{ align: 'left' }, { align: 'right' }],
                    headerRows: [{
                        cells: [
                            { children: [{ type: 'text', text: 'H1' }] },
                            { children: [{ type: 'text', text: 'H2' }] },
                        ],
                    }],
                    rows: [{
                        cells: [
                            { children: [{ type: 'text', text: 'Cell1' }] },
                            { children: [{ type: 'text', text: 'Cell2' }] },
                        ],
                    }],
                }],
            }],
        },
    };

    const bundleTableB = {
        conversation: {
            messages: [{
                blocks: [{
                    type: 'table',
                    columns: [{ align: 'left' }, { align: 'center' }], // alignment differs
                    headerRows: [{
                        cells: [
                            { children: [{ type: 'text', text: 'H1' }] },
                            { children: [{ type: 'text', text: 'H2' }] },
                        ],
                    }],
                    rows: [{
                        cells: [
                            { children: [{ type: 'text', text: 'Cell1' }] },
                            { children: [{ type: 'text', text: 'Cell2' }] },
                        ],
                    }],
                }],
            }],
        },
    };

    const result = compareMarkdownAst('| H1 | H2 |', bundleTableA, bundleTableB);
    assert.strictEqual(result.hasDiff, true);
    assert.strictEqual(result.category, 'D_CANNOT_DETERMINE');
    assert.strictEqual(result.rationaleKind, 'TABLE_DIVERGENCE');
});

test('Differential Runner: Unknown / future semantic fields produce diff by default without special-casing', () => {
    // 1. Candidate introduces an unmentioned custom semantic attribute on a block
    const baseBundle = {
        conversation: {
            messages: [{
                blocks: [{
                    type: 'paragraph',
                    children: [{ type: 'text', text: 'Hello' }],
                }],
            }],
        },
    };
    const candBundleWithExtraField = {
        conversation: {
            messages: [{
                blocks: [{
                    type: 'paragraph',
                    customSemanticAnnotation: 'v2-extra-meta', // not in any hardcoded allowlist!
                    children: [{ type: 'text', text: 'Hello' }],
                }],
            }],
        },
    };

    const diff1 = compareMarkdownAst('Hello', baseBundle, candBundleWithExtraField);
    assert.strictEqual(diff1.hasDiff, true, 'Unknown block field must default to semantic and trigger diff');
    assert.strictEqual(diff1.category, 'D_CANNOT_DETERMINE');
    assert.ok(diff1.rationale?.includes('customSemanticAnnotation'));

    // 2. Candidate modifies a cell-level property (e.g. rowSpan)
    const baseTable = {
        conversation: {
            messages: [{
                blocks: [{
                    type: 'table',
                    rows: [{
                        cells: [{ rowSpan: 1, children: [{ type: 'text', text: 'cell' }] }],
                    }],
                }],
            }],
        },
    };
    const candTableSpan = {
        conversation: {
            messages: [{
                blocks: [{
                    type: 'table',
                    rows: [{
                        cells: [{ rowSpan: 2, children: [{ type: 'text', text: 'cell' }] }],
                    }],
                }],
            }],
        },
    };

    const diff2 = compareMarkdownAst('table', baseTable, candTableSpan);
    assert.strictEqual(diff2.hasDiff, true, 'rowSpan difference must be detected automatically');
    assert.ok(diff2.rationale?.includes('rowSpan'));
});

test('Differential Runner: Minimal canonicalization coalesces adjacent inline text nodes', () => {
    const chunkedTextBundle = {
        conversation: {
            messages: [{
                blocks: [{
                    type: 'paragraph',
                    children: [
                        { type: 'text', text: 'Hello ' },
                        { type: 'text', text: 'World' },
                    ],
                }],
            }],
        },
    };

    const singleTextBundle = {
        conversation: {
            messages: [{
                blocks: [{
                    type: 'paragraph',
                    children: [
                        { type: 'text', text: 'Hello World' },
                    ],
                }],
            }],
        },
    };

    // When text is identical after coalescing, it is considered equivalent
    const resIdentical = compareMarkdownAst('Hello World', chunkedTextBundle, singleTextBundle);
    assert.strictEqual(resIdentical.hasDiff, false, 'Coalesced identical text must not trigger false diff');

    // When text actually differs, it must trigger diff
    const differentTextBundle = {
        conversation: {
            messages: [{
                blocks: [{
                    type: 'paragraph',
                    children: [
                        { type: 'text', text: 'Hello Earth' },
                    ],
                }],
            }],
        },
    };
    const resDiff = compareMarkdownAst('Hello World', chunkedTextBundle, differentTextBundle);
    assert.strictEqual(resDiff.hasDiff, true);
    assert.strictEqual(resDiff.rationaleKind, 'CONTENT_CHANGED');
});


test('Differential Runner: only IDs are ephemeral', () => {
    const a = { conversation: { messages: [{ blocks: [{ id: 'a', type: 'paragraph', children: [] }] }] } };
    for (const key of ['sourceRef', 'extensions']) {
        const b = JSON.parse(JSON.stringify(a));
        b.conversation.messages[0].blocks[0][key] = { unexpected: true };
        assert.strictEqual(compareMarkdownAst('', a, b).hasDiff, true);
    }
});
