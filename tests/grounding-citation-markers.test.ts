export {};
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    extractGroundingCitationMarkers,
} = require('../src/l1/parsers/gemini/rpc/extractors.js');
const {
    decodeGeminiDetail,
} = require('../src/l1/parsers/gemini/rpc/detailDecoder.js');
const { sourceConversation } = require('./helpers/l1SourceFixture.js');

test('extractGroundingCitationMarkers extracts declared markers from JSPB candidate metadata', () => {
    const cand = [
        [
            null,
            [['Response text with [cite: 1]']],
            null, null, null, null, null, null, null, null, null, null,
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

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    assert.strictEqual(diagnostics.filter((d: any) => d.severity === 'error').length, 0);

    const msg = domain.detail.messages[0];
    const para = msg.content[0];
    assert.strictEqual(para.type, 'paragraph');

    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 1);
    assert.strictEqual(citeRefs[0].label, '[1]');

    const citId = citeRefs[0].citationId;
    assert.ok(msg.citations?.some((citation: any) => citation.id === citId));
    const citEntity = domain.detail.messages[0].citations.find((c: any) => c.id === citId);
    assert.ok(citEntity);
    assert.equal(citEntity.url, undefined);
    assert.equal(citEntity.id, citId);
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

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    const msg = domain.detail.messages[0];
    const para = msg.content[0];
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

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    const msg = domain.detail.messages[0];
    const para = msg.content[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 2);
    assert.strictEqual(citeRefs[0].label, '[1]');
    assert.strictEqual(citeRefs[1].label, '[1]');
    assert.strictEqual(citeRefs[0].citationId, citeRefs[1].citationId);
});

test('ordinary user handwritten [cite: 1] is preserved as plain text', async () => {
    const rawConv = {
        id: 'c-test-4',
        title: 'User Text Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: '10000000-0000-4000-8000-000000000002',
                role: 'user',
                content: 'Can you explain what [cite: 1] means in academic papers?',
            },
        ],
    };

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    const msg = domain.detail.messages[0];
    const para = msg.content[0];
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
            },
        ],
    };

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    const msg = domain.detail.messages[0];
    const para = msg.content[0];
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

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    const msg = domain.detail.messages[0];
    const para = msg.content[0];
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

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    const msg = domain.detail.messages[0];

    const p1 = msg.content[0];
    const inlineCode = p1.children.find((c: any) => c.type === 'inlineCode');
    assert.ok(inlineCode);
    assert.strictEqual(inlineCode.code, '[cite: 1]');

    const codeBlock = msg.content[1];
    assert.strictEqual(codeBlock.type, 'code');
    assert.ok(codeBlock.code.includes('[cite: 1]'));

    const p3 = msg.content[2];
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

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    const msg = domain.detail.messages[0];
    const para = msg.content[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 2);
    assert.strictEqual(citeRefs[0].label, '[1]');
    assert.strictEqual(citeRefs[1].label, '[2]');

    const cit1 = domain.detail.messages[0].citations.find((c: any) => c.id === citeRefs[0].citationId);
    const cit2 = domain.detail.messages[0].citations.find((c: any) => c.id === citeRefs[1].citationId);
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

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    const msg = domain.detail.messages[0];
    const para = msg.content[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 2);

    const webCit = domain.detail.messages[0].citations.find((c: any) => c.id === citeRefs[0].citationId);
    assert.strictEqual(webCit?.url, 'https://example.com/web');
    assert.ok(webCit);

    const groundCit = domain.detail.messages[0].citations.find((c: any) => c.id === citeRefs[1].citationId);
    assert.strictEqual(groundCit?.url, undefined);
    assert.ok(groundCit);
    assert.notEqual(groundCit.id, webCit.id);
    assert.strictEqual(citeRefs[1].label, '[1]');
});

test('source AST replaces metadata-confirmed cite tokens with citation references', async () => {
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

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);

    const body = JSON.stringify(domain.detail.messages.map((message: any) => message.content));
    assert.ok(!body.includes('cite:'));
    assert.ok(body.includes('citationRef'));
    assert.ok(body.includes('[1]'));
});

test('wire batchexecute decoding and source AST close citation references', async () => {
    const rawEnvelope = geminiDetailGen('G_GROUNDING_CITATION_MARKERS_01');

    const parsed = decodeGeminiDetail(rawEnvelope, '533ac8ca2ecb8bd7');
    assert.strictEqual(parsed.messages.length, 2);

    const modelMsg = parsed.messages.find((m: any) => m.role === 'model');
    assert.ok(modelMsg);
    assert.deepStrictEqual(modelMsg.groundingCitationMarkers, ['[cite: 1]']);

    const convData = {
        id: parsed.id,
        title: parsed.title || 'Config Test',
        timestamp: parsed.timestamp,
        messages: parsed.messages,
    };
    const { conversation: domain, diagnostics } = sourceConversation(convData);
    assert.strictEqual(diagnostics.filter((d: any) => d.severity === 'error').length, 0);

    const canMsg = domain.detail.messages.find((m: any) => m.role === 'assistant');
    assert.ok(canMsg);

    const refs = canMsg.content.flatMap((b: any) => b.children || []).filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(refs.length, 1);
    assert.strictEqual(refs[0].label, '[1]');

    const body = JSON.stringify(domain.detail.messages.map((message: any) => message.content));
    assert.ok(!body.includes('cite:'));
    assert.ok(body.includes('citationRef'));
    assert.ok(body.includes('[1]'));
});

test('extractGroundingCitationMarkers accepts combined [cite:1,2] markers', () => {
    const cand = [
        [
            null,
            [['Response text with [cite:1,2]']],
            null, null, null, null, null, null, null, null, null, null,
            [
                {
                    '8': [],
                    '44': [
                        [['[cite:1,2]', 0], []],
                        [['[cite: 3, 4]', 1], []],
                        [['[cite: x]', 2], []],
                        [['[1,2]', 3], []],
                    ],
                },
            ],
        ],
    ];

    const markers = extractGroundingCitationMarkers(cand);
    assert.deepStrictEqual(markers.sort(), ['[cite:1,2]', '[cite: 3, 4]'].sort());
});

test('metadata-confirmed [cite:1,2] transforms to two citationRefs in order', async () => {
    const rawConv = {
        id: 'c-test-combo-1',
        title: 'Combined Citation Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Both files agree[cite:1,2] on the result.',
                groundingCitationMarkers: ['[cite:1,2]'],
            },
        ],
    };

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    const msg = domain.detail.messages[0];
    const para = msg.content[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 2);
    assert.strictEqual(citeRefs[0].label, '[1]');
    assert.strictEqual(citeRefs[1].label, '[2]');
    assert.notEqual(citeRefs[0].citationId, citeRefs[1].citationId);
    assert.ok(msg.citations?.some((citation: any) => citation.id === citeRefs[0].citationId));
    assert.ok(msg.citations?.some((citation: any) => citation.id === citeRefs[1].citationId));

    const remainingText = para.children.map((c: any) => c.text || '').join('');
    assert.ok(!remainingText.includes('cite:'));
});

test('combined marker with spaces [cite: 1, 2] transforms to two citationRefs', async () => {
    const rawConv = {
        id: 'c-test-combo-2',
        title: 'Combined Citation Space Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Spaced combo[cite: 1, 2] here.',
                groundingCitationMarkers: ['[cite: 1, 2]'],
            },
        ],
    };

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    const para = domain.detail.messages[0].content[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 2);
    assert.strictEqual(citeRefs[0].label, '[1]');
    assert.strictEqual(citeRefs[1].label, '[2]');
});

test('duplicate number inside one combined marker [cite:1,1] collapses to one citationRef', async () => {
    const rawConv = {
        id: 'c-test-combo-3',
        title: 'Combined Citation Duplicate Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Duplicate combo[cite:1,1] here.',
                groundingCitationMarkers: ['[cite:1,1]'],
            },
        ],
    };

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    const para = domain.detail.messages[0].content[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 1);
    assert.strictEqual(citeRefs[0].label, '[1]');
});

test('unconfirmed [cite:1,2] (no metadata) is preserved as plain text', async () => {
    const rawConv = {
        id: 'c-test-combo-4',
        title: 'Unconfirmed Combined Citation Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Unconfirmed combo [cite:1,2] stays literal.',
            },
        ],
    };

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    const para = domain.detail.messages[0].content[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 0);
    const fullText = para.children.map((c: any) => c.text || '').join('');
    assert.ok(fullText.includes('[cite:1,2]'));
});

test('only single marker confirmed: combined marker in same message remains text', async () => {
    const rawConv = {
        id: 'c-test-combo-5',
        title: 'Partial Combined Confirmation Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Combo[cite:1,2] but single[cite: 1].',
                groundingCitationMarkers: ['[cite: 1]'],
            },
        ],
    };

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    const para = domain.detail.messages[0].content[0];
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 1);
    assert.strictEqual(citeRefs[0].label, '[1]');
    const remainingText = para.children.map((c: any) => c.text || '').join('');
    assert.ok(remainingText.includes('[cite:1,2]'));
});

test('combined marker inside inline code is preserved while confirmed prose combo converts', async () => {
    const rawConv = {
        id: 'c-test-combo-6',
        title: 'Combined Citation Code Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Code `[cite:1,2]` stays, prose[cite:1,2] converts.',
                groundingCitationMarkers: ['[cite:1,2]'],
            },
        ],
    };

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);
    const para = domain.detail.messages[0].content[0];
    const inlineCode = para.children.find((c: any) => c.type === 'inlineCode');
    assert.ok(inlineCode);
    assert.strictEqual(inlineCode.code, '[cite:1,2]');
    const citeRefs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(citeRefs.length, 2);
});

test('combined [cite:1,2] becomes source citation references without metadata leak', async () => {
    const rawConv = {
        id: 'c-test-combo-7',
        title: 'Combined Citation Renderer Test',
        timestamp: 1700000000000,
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Loaded both files[cite:1,2]: verified.',
                groundingCitationMarkers: ['[cite:1,2]'],
            },
        ],
    };

    const { conversation: domain, diagnostics } = sourceConversation(rawConv);

    const body = JSON.stringify(domain.detail.messages.map((message: any) => message.content));
    assert.ok(!body.includes('cite:'));
    assert.ok(body.includes('citationRef'));
    assert.ok(body.includes('[1]'));
});

test('real Gemini code diagram drops confirmed grounding tokens exactly as the webpage does', () => {
    const fixture = require('./fixtures/gemini_confirmed_code_citations.json');
    const { conversation } = sourceConversation({ id: 'code-citations', title: 'Code citations', messages: [{
        id: 'code-citations-model',
        role: 'model', content: '```text\n' + fixture.code + '```',
        structuredContent: { children: [{ nodeType: 1, code: fixture.code, info: 'text' }] },
        groundingCitationMarkers: fixture.markers,
    }] });
    assert.strictEqual(conversation.detail.messages[0].content[0].code.replace(/\n$/, ''), fixture.visibleCode.replace(/\n$/, ''));
});

test('code citation cleanup preserves quoted literals, unknown markers and inline code', () => {
    const { closeGeminiCodeCitations } = require('../src/l1/parsers/gemini/shared/codeCitations.js');
    const literal = String.raw`pattern = r"[cite: 1]"
other = '[cite: 1]'
escaped = "quote\"[cite: 1]"
multiline = """literal
[cite: 1]
"""
` + 'template = `[cite: 1]`';
    const blocks = [{ type: 'quote', blocks: [{ type: 'list', items: [{ blocks: [
        { type: 'code', code: literal + '\nlabel[cite: 1] and unknown[cite: 99]' },
        { type: 'paragraph', children: [{ type: 'inlineCode', code: '[cite: 1]' }] },
    ] }] }] }];
    closeGeminiCodeCitations(blocks, ['[cite: 1]']);
    assert.strictEqual(blocks[0].blocks[0].items[0].blocks[0].code, literal + '\nlabel and unknown[cite: 99]');
    assert.strictEqual(blocks[0].blocks[0].items[0].blocks[1].children![0].code, '[cite: 1]');
    const unconfirmed = [{ type: 'code', code: 'label[cite: 1]' }];
    closeGeminiCodeCitations(unconfirmed);
    assert.strictEqual(unconfirmed[0].code, 'label[cite: 1]');
});
