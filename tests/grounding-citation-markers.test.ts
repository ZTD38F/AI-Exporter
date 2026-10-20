export {};
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    extractGroundingCitationMarkers,
} = require('../src/core/api/parser/extractors.js');
const {
    parseDetail,
} = require('../src/core/api/parser/parseDetail.js');
const {
    normalizeGeminiConversation,
} = require('../src/core/export/canonical/gemini/normalizeConversation.js');
const {
    renderCanonicalMarkdown,
} = require('../src/core/export/canonical/renderCanonicalMarkdown.js');
const {
    renderCanonicalHtml,
} = require('../src/core/export/canonical/renderCanonicalHtml.js');
const {
    toTypstPayload,
} = require('../src/core/export/typst/payload.js');

test('extractGroundingCitationMarkers extracts declared markers from JSPB candidate metadata', () => {
    // Standard JSPB structure: cand[12] contains grounding array with field 44
    const cand = [
        // cand[0] = body
        [
            null,
            [['Response text with [cite: 1]']],
            null, null, null, null, null, null, null, null, null, null,
            // index 12: grounding metadata array
            [
                {
                    '8': [],
                    '44': [
                        [['[cite: 1]', 0], [[null, [[null, 0, 'test_config.json']]]]],
                        [['[cite:2]', 1], [[null, [[null, 1, 'image.jpg']]]]],
                        [['not-a-citation', 2], []],
                    ],
                },
            ],
        ],
    ];

    const markers = extractGroundingCitationMarkers(cand);
    assert.deepStrictEqual(markers.sort(), ['[cite: 1]', '[cite:2]'].sort());

    // Null and empty safety
    assert.deepStrictEqual(extractGroundingCitationMarkers(null), []);
    assert.deepStrictEqual(extractGroundingCitationMarkers([]), []);
    assert.deepStrictEqual(extractGroundingCitationMarkers([['no metadata']]), []);
});

test('metadata-confirmed [cite: 1] transforms to citationRef with label [1]', async () => {
    const rawConv = {
        id: 'c-test-1',
        title: 'Citation Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Loaded `test_config.json`[cite: 1]: configuration loaded.',
                groundingCitationMarkers: ['[cite: 1]'],
            },
        ],
    };

    const { bundle, diagnostics } = await normalizeGeminiConversation(rawConv);
    assert.strictEqual(diagnostics.filter((d: any) => d.severity === 'error').length, 0);

    const msg = bundle.conversation.messages[0];
    const para = msg.blocks[0];
    assert.strictEqual(para.type, 'paragraph');

    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 1);
    assert.strictEqual(citeRefs[0].label, '[1]');

    // Citation entity is registered and referenced
    const citId = citeRefs[0].citationId;
    assert.ok(msg.citationIds?.includes(citId));
    const citEntity = bundle.citations.find((c: any) => c.id === citId);
    assert.ok(citEntity);
    assert.strictEqual(citEntity.kind, 'attachment');
});

test('space variant [cite:2] declared in metadata transforms to citationRef [2]', async () => {
    const rawConv = {
        id: 'c-test-2',
        title: 'Space Variant Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Referenced attachment[cite:2] without spaces.',
                groundingCitationMarkers: ['[cite:2]'],
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(rawConv);
    const msg = bundle.conversation.messages[0];
    const para = msg.blocks[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 1);
    assert.strictEqual(citeRefs[0].label, '[2]');
});

test('repeated citation marker in the same sentence both convert cleanly', async () => {
    const rawConv = {
        id: 'c-test-3',
        title: 'Repeated Marker Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'The 520 nm radiance is high[cite: 1]. The red signal is attenuated[cite: 1].',
                groundingCitationMarkers: ['[cite: 1]'],
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(rawConv);
    const msg = bundle.conversation.messages[0];
    const para = msg.blocks[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 2);
    assert.strictEqual(citeRefs[0].label, '[1]');
    assert.strictEqual(citeRefs[1].label, '[1]');
    // Both point to the same citation entity
    assert.strictEqual(citeRefs[0].citationId, citeRefs[1].citationId);
});

test('ordinary user handwritten [cite: 1] is preserved as plain text', async () => {
    const rawConv = {
        id: 'c-test-4',
        title: 'User Text Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'u1',
                role: 'user',
                content: 'Can you explain what [cite: 1] means in academic papers?',
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(rawConv);
    const msg = bundle.conversation.messages[0];
    const para = msg.blocks[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 0);

    const fullText = para.children.map((c: any) => c.text || '').join('');
    assert.ok(fullText.includes('[cite: 1]'));
});

test('model text with unconfirmed [cite: 1] (no matching metadata) is preserved as plain text', async () => {
    const rawConv = {
        id: 'c-test-5',
        title: 'Unconfirmed Model Text Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'This model mentioned [cite: 1] and [cite: 2] without grounding metadata.',
                // No groundingCitationMarkers
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(rawConv);
    const msg = bundle.conversation.messages[0];
    const para = msg.blocks[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 0);

    const fullText = para.children.map((c: any) => c.text || '').join('');
    assert.ok(fullText.includes('[cite: 1]'));
    assert.ok(fullText.includes('[cite: 2]'));
});

test('only metadata-confirmed marker converts; non-matching marker in same message remains text', async () => {
    const rawConv = {
        id: 'c-test-5b',
        title: 'Partial Confirmation Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Confirmed[cite: 1] but unconfirmed[cite: 99].',
                groundingCitationMarkers: ['[cite: 1]'], // Only 1 is declared!
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(rawConv);
    const msg = bundle.conversation.messages[0];
    const para = msg.blocks[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 1);
    assert.strictEqual(citeRefs[0].label, '[1]');

    const remainingText = para.children.map((c: any) => c.text || '').join('');
    assert.ok(remainingText.includes('[cite: 99]'));
});

test('marker inside code block and inline code is preserved untouched', async () => {
    const rawConv = {
        id: 'c-test-6',
        title: 'Code Preservation Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Here is inline `[cite: 1]` code.\n\n```python\npattern = r"[cite: 1]"\n```\n\nAnd confirmed text[cite: 1].',
                groundingCitationMarkers: ['[cite: 1]'],
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(rawConv);
    const msg = bundle.conversation.messages[0];

    // Para 1: inline code
    const p1 = msg.blocks[0];
    const inlineCode = p1.children.find((c: any) => c.type === 'inlineCode');
    assert.ok(inlineCode);
    assert.strictEqual(inlineCode.code, '[cite: 1]');

    // Para 2: code block
    const codeBlock = msg.blocks[1];
    assert.strictEqual(codeBlock.type, 'code');
    assert.ok(codeBlock.code.includes('[cite: 1]'));

    // Para 3: confirmed text citation
    const p3 = msg.blocks[2];
    const citeRef = p3.children.find((c: any) => c.type === 'citationRef');
    assert.ok(citeRef);
    assert.strictEqual(citeRef.label, '[1]');
});

test('existing [1] web citations do not regress', async () => {
    const rawConv = {
        id: 'c-test-7',
        title: 'Web Citation Non-Regression Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'According to research[1], climate change is accelerating[2].',
                citations: [
                    { url: 'https://example.com/study1', title: 'Study 1' },
                    { url: 'https://example.com/study2', title: 'Study 2' },
                ],
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(rawConv);
    const msg = bundle.conversation.messages[0];
    const para = msg.blocks[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 2);
    assert.strictEqual(citeRefs[0].label, '[1]');
    assert.strictEqual(citeRefs[1].label, '[2]');

    const cit1 = bundle.citations.find((c: any) => c.id === citeRefs[0].citationId);
    const cit2 = bundle.citations.find((c: any) => c.id === citeRefs[1].citationId);
    assert.strictEqual(cit1?.url, 'https://example.com/study1');
    assert.strictEqual(cit2?.url, 'https://example.com/study2');
});

test('orthogonal coexistence: both web [1] and grounding [cite: 1] in same message resolve correctly', async () => {
    const rawConv = {
        id: 'c-test-8',
        title: 'Dual Citation Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Web source says X[1], and uploaded config confirms Y[cite: 1].',
                citations: [{ url: 'https://example.com/web', title: 'Web Source' }],
                groundingCitationMarkers: ['[cite: 1]'],
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(rawConv);
    const msg = bundle.conversation.messages[0];
    const para = msg.blocks[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 2);

    // [1] maps to web citation
    const webCit = bundle.citations.find((c: any) => c.id === citeRefs[0].citationId);
    assert.strictEqual(webCit?.url, 'https://example.com/web');
    assert.strictEqual(webCit?.kind, 'web');

    // [cite: 1] maps to grounding citation with label [1]
    const groundCit = bundle.citations.find((c: any) => c.id === citeRefs[1].citationId);
    assert.strictEqual(groundCit?.url, undefined);
    assert.strictEqual(groundCit?.kind, 'attachment');
    assert.strictEqual(citeRefs[1].label, '[1]');
});

test('Markdown, HTML, and Typst payload renderers contain 0 metadata-confirmed cite: tokens', async () => {
    const rawConv = {
        id: 'c-test-9',
        title: 'Multi-Renderer Zero-Leak Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Loaded `test_config.json`[cite: 1]: verified status.',
                groundingCitationMarkers: ['[cite: 1]'],
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(rawConv);

    // 1. Markdown
    const md = renderCanonicalMarkdown(bundle);
    assert.ok(!md.includes('cite:'), `Markdown should not leak cite:, got: ${md}`);
    assert.ok(md.includes('[1]'), `Markdown should display citation reference [1], got: ${md}`);

    // 2. HTML
    const htmlResult = renderCanonicalHtml(bundle);
    const html = htmlResult.html;
    assert.ok(!html.includes('cite:'), `HTML should not leak cite:, got: ${html}`);
    assert.ok(html.includes('gem-citation-ref'), `HTML should contain citation-ref class`);
    assert.ok(html.includes('[1]'), `HTML should display [1]`);

    // 3. Typst
    const typstResult = toTypstPayload(bundle, { assetPath: () => '' });
    const typstJson = JSON.stringify(typstResult.payload);
    assert.ok(!typstJson.includes('cite:'), `Typst payload should not leak cite:, got: ${typstJson}`);
    assert.ok(typstJson.includes('[1]'), `Typst payload should contain [1], got: ${typstJson}`);
});

test('end-to-end: wire batchexecute response -> parseDetail -> canonical -> renderers zero leak', async () => {
    // Construct wire JSPB detail structure mimicking Google Gemini server
    const mockDetailInner = [
        [
            // Turn 0: user turn
            [
                ['c_533ac8ca2ecb8bd7', 'r_turn_u0'],
                [1700000000, 0],
                ['Load configuration test_config.json', 0],
                null,
            ],
            // Turn 1: model turn with candidate citing attachment
            [
                ['c_533ac8ca2ecb8bd7', 'r_turn_m1'],
                [1700000005, 0],
                null,
                [
                    // Candidates array
                    [
                        // Candidate 0
                        [
                            'rc_candidate_0',
                            [['Loaded `test_config.json`[cite: 1]:\n\n* **status**: `"ok"`[cite: 1]']],
                            null, null, null, null, null, null, null, null, null, null,
                            // Field 12: grounding metadata with subfield 44
                            [
                                {
                                    '8': [],
                                    '44': [
                                        [
                                            ['[cite: 1]', 0],
                                            [[null, [[null, 0, 'test_config.json', null, [3, null, 'File attachment']]]]],
                                        ],
                                    ],
                                },
                            ],
                        ],
                    ],
                ],
            ],
        ],
        null,
        'c_533ac8ca2ecb8bd7',
    ];

    const rawEnvelope = `)]}'\n\n${JSON.stringify([
        ['wrb.fr', 'hNvQHb', JSON.stringify(mockDetailInner)],
    ])}`;

    // 1. Parser stage
    const parsed = parseDetail(rawEnvelope, '533ac8ca2ecb8bd7');
    assert.strictEqual(parsed.messages.length, 2);

    const modelMsg = parsed.messages.find((m: any) => m.role === 'model');
    assert.ok(modelMsg);
    assert.deepStrictEqual(modelMsg.groundingCitationMarkers, ['[cite: 1]']);

    // 2. Canonical normalization stage
    const convData = {
        id: parsed.id,
        title: parsed.title || 'Config Test',
        timestamp: parsed.timestamp,
        messages: parsed.messages,
    };
    const { bundle, diagnostics } = await normalizeGeminiConversation(convData);
    assert.strictEqual(diagnostics.filter((d: any) => d.severity === 'error').length, 0);

    const canMsg = bundle.conversation.messages.find((m: any) => m.role === 'assistant');
    assert.ok(canMsg);

    // Verify citationRef inlines exist and label is [1]
    const refs = canMsg.blocks.flatMap((b: any) => b.children || []).filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0].label, '[1]');

    // 3. Renderers stage
    const md = renderCanonicalMarkdown(bundle);
    assert.ok(!md.includes('cite:'), `Markdown leaked cite: -> ${md}`);
    assert.ok(md.includes('[1]'), `Markdown should display [1]`);

    const html = renderCanonicalHtml(bundle).html;
    assert.ok(!html.includes('cite:'), `HTML leaked cite: -> ${html}`);
    assert.ok(html.includes('[1]'), `HTML should display [1]`);

    const typst = JSON.stringify(toTypstPayload(bundle, { assetPath: () => '' }).payload);
    assert.ok(!typst.includes('cite:'), `Typst leaked cite: -> ${typst}`);
    assert.ok(typst.includes('[1]'), `Typst should display [1]`);
});

