/**
 * tests/gemini-normalizer.test.ts
 * Tier 1 tests for the F2b Gemini -> canonical normalizer.
 *
 * Covers: markdown body structure + block order, thoughts -> ThoughtBlock,
 * citations -> Citation entities + message.citationIds + [n] markers,
 * attachment/image/document mapping + dedupe, unknown content
 * fallbacks, title authority tiers, attachment availability diagnostics,
 * turns-shape fallback, raw evidence preservation, and the
 * validateBundle self-checks.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const canonical = require('../src/core/export/canonical/index.js');
const {
    normalizeGeminiConversation,
    GeminiNormalizer,
    validateBundle,
    extractBlockText,
    extractInlineText,
} = canonical;

const fixtureDir = path.join(__dirname, 'fixtures', 'canonical');
const sample = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'gemini-normalizer-sample.json'), 'utf8'));
const turnsSample = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'gemini-normalizer-turns.json'), 'utf8'));

function textOf(node: any) {
    return (node.children || []).map((c: any) => c.text || '').join('');
}

test('markdown body keeps block order and structure', async () => {
    const { bundle, diagnostics } = await normalizeGeminiConversation(sample);
    const user = bundle.conversation.messages.find((m: any) => m.id === 'm-u1');
    assert.ok(user, 'user message m-u1 present');
    const kinds = user.blocks.map((b: any) => b.type);
    assert.deepStrictEqual(kinds, [
        'heading', 'paragraph', 'list', 'list', 'quote', 'thematicBreak', 'paragraph', 'image',
    ]);

    // Heading.
    assert.strictEqual(user.blocks[0].level, 1);
    assert.strictEqual(textOf(user.blocks[0]), 'Shopping list');

    // Inline emphasis in the paragraph.
    const inlineKinds = user.blocks[1].children.map((c: any) => c.type);
    assert.ok(inlineKinds.includes('strong'), 'bold survives');
    assert.ok(inlineKinds.includes('emphasis'), 'italic survives');
    assert.ok(inlineKinds.includes('strikethrough'), 'strikethrough survives');
    const strong = user.blocks[1].children.find((c: any) => c.type === 'strong');
    assert.strictEqual(textOf(strong), 'milk');

    // Unordered list with a nested list under the first item.
    const ul = user.blocks[2];
    assert.strictEqual(ul.ordered, false);
    assert.strictEqual(ul.items.length, 2);
    assert.strictEqual(ul.items[0].blocks.length, 2);
    assert.strictEqual(ul.items[0].blocks[1].type, 'list');
    assert.deepStrictEqual(
        ul.items[0].blocks[1].items.map((it: any) => textOf(it.blocks[0])),
        ['fuji', 'gala'],
    );

    // Ordered list.
    const ol = user.blocks[3];
    assert.strictEqual(ol.ordered, true);
    assert.strictEqual(ol.start, 1);
    assert.strictEqual(ol.items.length, 2);

    // Quote + thematic break.
    assert.strictEqual(user.blocks[4].type, 'quote');
    assert.strictEqual(textOf(user.blocks[4].blocks[0]), 'remember the receipt');
    assert.strictEqual(user.blocks[5].type, 'thematicBreak');

    // Inline markdown image is a first-class ImageInline: it references an
    // asset by id and is never demoted to unsupported text.
    const imgPara = user.blocks[6];
    assert.strictEqual(imgPara.type, 'paragraph');
    const img = imgPara.children.find((c: any) => c.type === 'image');
    assert.ok(img, 'inline image is a first-class image inline node');
    assert.strictEqual(img.alt, 'alt text');
    assert.ok(img.assetId, 'inline image references an asset');
    const imgAsset = bundle.assets.find((a: any) => a.id === img.assetId);
    assert.ok(imgAsset, 'inline image asset is in the bundle asset table');
    assert.strictEqual(imgAsset.kind, 'image');
    assert.strictEqual(imgAsset.status, 'remote');
    assert.strictEqual(imgAsset.sourceUrl, 'https://example.com/inline.png');
    assert.strictEqual(extractInlineText(img), 'alt text', 'alt text survives as readable fallback');
    assert.ok(!diagnostics.some((d: any) => d.code === 'INLINE_IMAGE_DOWNGRADE'), 'no downgrade diagnostic');
    assert.ok(!diagnostics.some((d: any) => d.severity === 'error'), 'no error diagnostics');
});

test('thoughts become ThoughtBlock without rendering state', async () => {
    const { bundle } = await normalizeGeminiConversation(sample);
    const model = bundle.conversation.messages.find((m: any) => m.id === 'm-a1');
    const thought = model.blocks[0];
    assert.strictEqual(thought.type, 'thought');
    assert.strictEqual(thought.kind, 'reasoning');
    assert.strictEqual(thought.disclosure, 'providerExposed');
    assert.ok(textOf(thought.blocks[0]).includes('The user wants a plan'), 'thought text preserved');
    assert.ok(!('initiallyCollapsed' in thought), 'no rendering state leaks into canonical');
});

test('citations become Citation entities, message.citationIds, and citationRef inlines', async () => {
    const { bundle } = await normalizeGeminiConversation(sample);
    // Duplicate URL collapses to one Citation entity.
    assert.strictEqual(bundle.citations.length, 2);
    assert.deepStrictEqual(
        bundle.citations.map((c: any) => c.url).sort(),
        ['https://example.com/docs-page', 'https://example.com/plan'],
    );
    assert.deepStrictEqual(
        bundle.citations.map((c: any) => c.title).sort(),
        ['Docs reference', 'Plan source'],
    );

    const model = bundle.conversation.messages.find((m: any) => m.id === 'm-a1');
    assert.deepStrictEqual(
        model.citationIds?.sort(),
        bundle.citations.map((c: any) => c.id).sort(),
    );
    assert.ok(!model.blocks.some((b: any) => b.type === 'citationGroup'), 'no citationGroup in blocks');

    // [1]/[2] markers map to citationRef inlines pointing at the right ids.
    const para = model.blocks[1];
    const refs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(refs.length, 2);
    const byId: Map<string, any> = new Map(bundle.citations.map((c: any) => [c.id, c.url]));
    assert.strictEqual(byId.get(refs[0].citationId), 'https://example.com/plan');
    assert.strictEqual(byId.get(refs[1].citationId), 'https://example.com/docs-page');
    assert.strictEqual(refs[0].label, '[1]');
    assert.strictEqual(refs[1].label, '[2]');

    // Inline math and link survive in the same paragraph.
    const math = para.children.find((c: any) => c.type === 'inlineMath');
    assert.ok(math && math.source === 'E=mc^2');
    const link = model.blocks.find((b: any) => b.type === 'paragraph' && b.children.some((c: any) => c.type === 'link'));
    assert.ok(link.children.find((c: any) => c.type === 'link' && c.href === 'https://example.com/docs'));

    // Code fence, table, display math.
    const code = model.blocks.find((b: any) => b.type === 'code');
    assert.strictEqual(code.language, 'python');
    assert.ok(code.code.includes('print("hello")'));
    const table = model.blocks.find((b: any) => b.type === 'table');
    assert.deepStrictEqual(table.columns.map((c: any) => c.align), ['left', 'right']);
    assert.deepStrictEqual(table.headerRows[0].cells.map((c: any) => textOf(c)), ['item', 'qty']);
    assert.deepStrictEqual(table.rows[0].cells.map((c: any) => textOf(c)), ['milk', '2']);
    const mathBlock = model.blocks.find((b: any) => b.type === 'math');
    assert.strictEqual(mathBlock.source, '\\frac{a}{b}');
});

test('attachments map to assets with availability and dedupe', async () => {
    const { bundle, diagnostics } = await normalizeGeminiConversation(sample);
    // receipt.png appears in both attachments[] and images[] -> one asset.
    // Plus the inline markdown image in m-u1 -> one remote asset.
    assert.strictEqual(bundle.assets.length, 4);
    const byName: Map<string, any> = new Map(bundle.assets.map((a: any) => [a.name, a]));
    const receipt = byName.get('receipt.png');
    assert.strictEqual(receipt.kind, 'image');
    assert.strictEqual(receipt.status, 'available');
    assert.strictEqual(receipt.mimeType, 'image/png');

    const plan = byName.get('plan.pdf');
    assert.strictEqual(plan.kind, 'file');
    assert.strictEqual(plan.status, 'remote');
    assert.strictEqual(plan.sourceUrl, 'https://example.com/files/plan.pdf');

    const corrupt = byName.get('corrupt.bin');
    assert.strictEqual(corrupt.status, 'missing');
    assert.ok(
        diagnostics.some((d: any) => d.code === 'ATTACHMENT_NO_SOURCE' && d.severity === 'warning'),
        'attachment with no usable source raises a warning, not silent loss',
    );

    // Placement blocks reference the assets; message keeps the association index.
    // The inline markdown image asset joins the association too.
    const user = bundle.conversation.messages.find((m: any) => m.id === 'm-u1');
    const inlineImg = byName.get('alt text');
    assert.ok(inlineImg, 'inline image asset present');
    const imgBlock = user.blocks.find((b: any) => b.type === 'image');
    assert.strictEqual(imgBlock.assetId, receipt.id);
    const model = bundle.conversation.messages.find((m: any) => m.id === 'm-a1');
    const fileBlocks = model.blocks.filter((b: any) => b.type === 'file');
    assert.strictEqual(fileBlocks.length, 2);
});

test('unknown role and non-string content are preserved, never dropped', async () => {
    const { bundle, diagnostics } = await normalizeGeminiConversation(sample);
    const weird = bundle.conversation.messages.find((m: any) => m.id === 'm-x1');
    assert.ok(weird, 'message with unknown role is kept');
    assert.strictEqual(weird.role, 'unknown');
    assert.strictEqual(weird.author && weird.author.rawRole, 'weird-role');
    assert.ok(diagnostics.some((d: any) => d.code === 'UNKNOWN_ROLE'), 'unknown role is diagnosed');

    const ub = weird.blocks[0];
    assert.strictEqual(ub.type, 'unknown');
    assert.strictEqual(ub.sourceType, 'message-content');
    assert.strictEqual(ub.text, '{"not": "a string"}');
    assert.deepStrictEqual(Object.keys(ub).sort(), ['id', 'sourceType', 'text', 'type']);
    assert.ok(extractBlockText(ub).length > 0, 'unknown block has a readable fallback');
    assert.ok(diagnostics.some((d: any) => d.code === 'UNKNOWN_MESSAGE_CONTENT'));
});

test('non-string content becomes bounded, deterministic visible text at normalization', async () => {
    const { bundle, diagnostics } = await normalizeGeminiConversation({ id: 'bounded', messages: [
        { id: 'm1', role: 'assistant', content: { z: 1, a: 2 } },
        { id: 'm2', role: 'assistant', content: { a: { b: { c: { d: { e: 1 } } } } } },
        { id: 'm3', role: 'assistant', content: { s: 'x'.repeat(5000) } },
    ] });
    const blocks = bundle.conversation.messages.map((m: any) => m.blocks[0]);
    assert.strictEqual(blocks[0].text, '{"a": 2, "z": 1}');
    assert.ok(blocks[1].text.includes('{…}'));
    assert.ok(blocks[2].text.endsWith('…'));
    assert.ok(blocks[2].text.length <= 2001);
    assert.ok(diagnostics.find((d: any) => d.id === 'unknown-content:m3').details.truncated);
});

test('title authority: rpc candidate wins over takeout/sniff', async () => {
    const { bundle } = await normalizeGeminiConversation(sample);
    const title = bundle.conversation.title;
    assert.strictEqual(title, 'RPC Authoritative Title');
    const low = await normalizeGeminiConversation({ id: 'x', titles: { takeout: 'T' }, messages: [] });
    assert.strictEqual(low.bundle.conversation.title, 'T');
});

test('conversation timestamps and key are preserved', async () => {
    const { bundle } = await normalizeGeminiConversation(sample);
    const conv = bundle.conversation;
    assert.strictEqual(conv.key.providerId, 'gemini');
    assert.strictEqual(conv.key.conversationId, 'c_f2b_sample_001');
    assert.strictEqual(conv.createdAt, '2024-09-22T10:13:20.000Z');
    assert.strictEqual(conv.updatedAt, '2024-09-22T11:13:20.000Z');
    assert.strictEqual(conv.url, 'https://gemini.google.com/share/f2b-sample');
});

test('turns shape flattens to user/assistant messages', async () => {
    const { bundle } = await normalizeGeminiConversation(turnsSample);
    assert.strictEqual(bundle.conversation.messages.length, 4);
    assert.deepStrictEqual(
        bundle.conversation.messages.map((m: any) => m.role),
        ['user', 'assistant', 'user', 'assistant'],
    );
    const t1Model = bundle.conversation.messages[1];
    assert.strictEqual(t1Model.blocks[0].type, 'thought');
    assert.ok(textOf(t1Model.blocks[0].blocks[0]).includes('greeting detected'));
    assert.strictEqual(textOf(t1Model.blocks[1]), 'I am a test assistant.');
    const t2Model = bundle.conversation.messages[3];
    const code = t2Model.blocks.find((b: any) => b.type === 'code');
    assert.strictEqual(code.language, 'js');
    const gen = bundle.assets.find((a: any) => a.name === 'generated.png');
    assert.ok(gen, 'generated attachment mapped');
    assert.strictEqual(gen.status, 'remote');
});

test('raw evidence is persisted independently before deriving the document', async () => {
    const stored: Array<{ kind: string; data: any }> = [];
    const context = {
        providerId: 'gemini',
        accountId: '',
        observedAt: new Date().toISOString(),
        rawEvidence: {
            put: async (kind: any, data: any) => {
                stored.push({ kind, data });
                return 'raw://test/evidence-1';
            },
        },
    };
    const normalizer = new GeminiNormalizer();
    const { bundle } = await normalizer.normalize(sample, context);
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].kind, 'gemini-conversation');
    assert.strictEqual(stored[0].data, sample, 'original payload stored, not the cleaned text');
    assert.strictEqual(bundle.observations, undefined);
});

test('raw evidence write failure is visible exactly once and never fabricates a rawRef', async () => {
    const context = {
        providerId: 'gemini',
        accountId: '',
        observedAt: new Date().toISOString(),
        rawEvidence: {
            put: async () => {
                throw new Error('disk is on fire (test)');
            },
        },
    };
    const normalizer = new GeminiNormalizer();
    const { bundle, diagnostics } = await normalizer.normalize(sample, context);
    // Normalization continues despite the persistence failure.
    assert.ok(bundle.conversation.messages.length > 0, 'bundle still produced');
    const hits = diagnostics.filter((d: any) => d.code === 'RAW_EVIDENCE_WRITE_FAILED');
    assert.strictEqual(hits.length, 1, 'diagnostic reported exactly once in result diagnostics');
    assert.strictEqual(hits[0].severity, 'warning');
    assert.ok(
        String(hits[0].details.error).includes('disk is on fire'),
        'error message safely extracted into details',
    );
    assert.strictEqual(bundle.diagnostics, undefined);
    assert.strictEqual(bundle.observations, undefined);
});

test('bundle passes validateBundle', async () => {
    for (const raw of [sample, turnsSample]) {
        const { bundle, diagnostics } = await normalizeGeminiConversation(raw);
        const issues = validateBundle(bundle);
        const errors = issues.filter((d: any) => d.severity === 'error');
        assert.deepStrictEqual(errors, [], `validateBundle errors for ${raw.id}`);
        assert.ok(
            !diagnostics.some((d: any) => d.severity === 'error'),
            'normalizer self-check clean',
        );
    }
});

function inlineImagesOf(message: any) {
    const out = [];
    for (const b of message.blocks || []) {
        for (const c of b.children || []) {
            if (c.type === 'image') out.push(c);
        }
    }
    return out;
}

test('ambiguous inline image basename never binds arbitrarily', async () => {
    const input = {
        id: 'conv-amb',
        title: 'amb',
        source: 'gemini',
        messages: [{
            id: 'm1',
            role: 'user',
            content: 'two images:\n\n![x](image.png)\n',
            attachments: [
                { localName: 'assets/foo/image.png', name: 'image.png', type: 'image', mimeType: 'image/png' },
                { localName: 'assets/bar/image.png', name: 'image.png', type: 'image', mimeType: 'image/png' },
            ],
        }],
    };
    const { bundle, diagnostics } = await normalizeGeminiConversation(input);
    const m1 = bundle.conversation.messages.find((m: any) => m.id === 'm1');
    const inlineImgs = inlineImagesOf(m1);
    assert.strictEqual(inlineImgs.length, 1, 'one inline image parsed');
    const attachmentIds = new Set(bundle.assets.filter((a: any) => a.id.startsWith('m1-a')).map((a: any) => a.id));
    assert.strictEqual(attachmentIds.size, 2, 'both attachments become assets');
    assert.ok(!attachmentIds.has(inlineImgs[0].assetId),
        'inline image must NOT bind to either attachment when the basename is ambiguous');
    assert.ok(
        diagnostics.some((d: any) => d.code === 'AMBIGUOUS_INLINE_IMAGE_ASSET' && d.severity === 'warning'),
        'ambiguous basename emits AMBIGUOUS_INLINE_IMAGE_ASSET',
    );
    assert.ok(
        !diagnostics.some((d: any) => d.code === 'INLINE_IMAGE_ASSET_MISSING'),
        'ambiguity is reported once, not also as generic missing',
    );
});

test('unique inline image basename still binds to its attachment', async () => {
    const input = {
        id: 'conv-unique',
        title: 'unique',
        source: 'gemini',
        messages: [{
            id: 'm1',
            role: 'user',
            content: 'one image:\n\n![x](image.png)\n',
            attachments: [
                { localName: 'assets/foo/image.png', name: 'image.png', type: 'image', mimeType: 'image/png' },
            ],
        }],
    };
    const { bundle, diagnostics } = await normalizeGeminiConversation(input);
    const m1 = bundle.conversation.messages.find((m: any) => m.id === 'm1');
    const inlineImgs = inlineImagesOf(m1);
    assert.strictEqual(inlineImgs.length, 1);
    assert.strictEqual(inlineImgs[0].assetId, 'm1-a0', 'unique basename binds to the attachment asset');
    assert.ok(!diagnostics.some((d: any) => d.code === 'AMBIGUOUS_INLINE_IMAGE_ASSET'), 'no ambiguity diagnostic');
});

test('exact full ref wins over an ambiguous basename', async () => {
    const input = {
        id: 'conv-exact',
        title: 'exact',
        source: 'gemini',
        messages: [{
            id: 'm1',
            role: 'user',
            content: 'exact ref:\n\n![x](assets/bar/image.png)\n',
            attachments: [
                { localName: 'assets/foo/image.png', name: 'image.png', type: 'image', mimeType: 'image/png' },
                { localName: 'assets/bar/image.png', name: 'image.png', type: 'image', mimeType: 'image/png' },
            ],
        }],
    };
    const { bundle, diagnostics } = await normalizeGeminiConversation(input);
    const m1 = bundle.conversation.messages.find((m: any) => m.id === 'm1');
    const inlineImgs = inlineImagesOf(m1);
    assert.strictEqual(inlineImgs.length, 1);
    assert.strictEqual(inlineImgs[0].assetId, 'm1-a1', 'exact full ref binds deterministically to the right asset');
    assert.ok(!diagnostics.some((d: any) => d.code === 'AMBIGUOUS_INLINE_IMAGE_ASSET'), 'no ambiguity diagnostic');
});
test('block ids are deterministic and scoped per message', async () => {
    const first = await normalizeGeminiConversation(sample);
    const second = await normalizeGeminiConversation(sample);
    const idsOf = (bundle: any) =>
        bundle.conversation.messages.flatMap((m: any) => m.blocks.map((b: any) => `${m.id}:${b.id}`));
    assert.deepStrictEqual(
        idsOf(first.bundle), idsOf(second.bundle),
        'normalizing the same conversation twice yields identical block ids',
    );
    // Per-message scoping: every block id (top-level and nested) is <msgId>-b<N>,
    // so no numbering can leak in from other messages or from earlier
    // normalizations in the same process. (Nested blocks such as list items
    // share the message counter, so top-level ids need not be contiguous.)
    const allBlockIds = (bundle: any): string[] => {
        const out: string[] = [];
        const walk = (blocks: any[]) => {
            for (const b of blocks || []) {
                out.push(b.id);
                walk(b.blocks);
                for (const it of b.items || []) walk(it.blocks);
            }
        };
        for (const m of bundle.conversation.messages) {
            const before = out.length;
            walk(m.blocks);
            for (const id of out.slice(before)) {
                assert.ok(
                    new RegExp(`^${m.id}-b\\d+$`).test(id),
                    `block id ${id} scoped to its message ${m.id}`,
                );
            }
        }
        return out;
    };
    assert.deepStrictEqual(
        allBlockIds(first.bundle), allBlockIds(second.bundle),
        'same conversation normalized twice -> identical block ids at every level',
    );
    allBlockIds(first.bundle);
    assert.ok(
        first.bundle.conversation.messages.filter((m: any) => m.blocks.length > 0).length > 1,
        'fixture has multiple non-empty messages, so cross-message leakage would be visible',
    );
});

function deepInlineImagesOf(message: any) {
    const out: any[] = [];
    const walkInline = (nodes: any[]) => {
        for (const n of nodes || []) {
            if (n.type === 'image') out.push(n);
            walkInline(n.children);
        }
    };
    const walkBlocks = (blocks: any[]) => {
        for (const b of blocks || []) {
            walkInline(b.children);
            walkBlocks(b.blocks);
            for (const it of b.items || []) walkBlocks(it.blocks);
        }
    };
    walkBlocks(message.blocks);
    return out;
}

function blockImagesOf(message: any) {
    return (message.blocks || []).filter((b: any) => b.type === 'image');
}

function attachmentConv(content: string, attachments: any[]) {
    return {
        id: 'conv-inline-dedup',
        title: 'dedup',
        source: 'gemini',
        messages: [{
            id: 'm1',
            role: 'user',
            content,
            attachments,
        }],
    };
}

const pngAttachment = (localName: string, name: string) => ({
    localName,
    name,
    type: 'image',
    mimeType: 'image/png',
});

test('inline markdown image reusing an attachment asset keeps a single visual placement', async () => {
    const input = attachmentConv('see ![pic](assets/shot.png)', [pngAttachment('assets/shot.png', 'shot.png')]);
    const { bundle } = await normalizeGeminiConversation(input);
    const m1 = bundle.conversation.messages.find((m: any) => m.id === 'm1');
    assert.strictEqual(bundle.assets.length, 1);
    const inlines = deepInlineImagesOf(m1);
    assert.strictEqual(inlines.length, 1);
    assert.strictEqual(inlines[0].assetId, 'm1-a0');
    assert.strictEqual(blockImagesOf(m1).length, 0);
});

test('linked inline image reusing an attachment asset keeps a single visual placement', async () => {
    const input = attachmentConv('[![pic](assets/shot.png)](https://example.com/full)', [pngAttachment('assets/shot.png', 'shot.png')]);
    const { bundle } = await normalizeGeminiConversation(input);
    const m1 = bundle.conversation.messages.find((m: any) => m.id === 'm1');
    assert.strictEqual(bundle.assets.length, 1);
    const inlines = deepInlineImagesOf(m1);
    assert.strictEqual(inlines.length, 1);
    assert.strictEqual(inlines[0].assetId, 'm1-a0');
    assert.strictEqual(blockImagesOf(m1).length, 0);
});

test('attachment not referenced inline keeps its trailing image block', async () => {
    const input = attachmentConv('no images here', [pngAttachment('assets/shot.png', 'shot.png')]);
    const { bundle } = await normalizeGeminiConversation(input);
    const m1 = bundle.conversation.messages.find((m: any) => m.id === 'm1');
    assert.strictEqual(bundle.assets.length, 1);
    assert.strictEqual(deepInlineImagesOf(m1).length, 0);
    const blocks = blockImagesOf(m1);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].assetId, 'm1-a0');
});

test('two attachments with only one inlined keep one inline and one trailing block', async () => {
    const input = attachmentConv('see ![a](assets/a.png)', [
        pngAttachment('assets/a.png', 'a.png'),
        pngAttachment('assets/b.png', 'b.png'),
    ]);
    const { bundle } = await normalizeGeminiConversation(input);
    const m1 = bundle.conversation.messages.find((m: any) => m.id === 'm1');
    assert.strictEqual(bundle.assets.length, 2);
    const inlines = deepInlineImagesOf(m1);
    assert.strictEqual(inlines.length, 1);
    assert.strictEqual(inlines[0].assetId, 'm1-a0');
    const blocks = blockImagesOf(m1);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].assetId, 'm1-a1');
});


test('duplicate message IDs remain normalization error diagnostics', async () => {
    const { diagnostics } = await normalizeGeminiConversation({
        id: 'dup', messages: [{ id: 'same', role: 'user', content: 'one' }, { id: 'same', role: 'model', content: 'two' }],
    });
    assert.ok(diagnostics.some((d: any) => d.code === 'MSG_DUP_ID' && d.severity === 'error'));
});

test('title source coercion remains an ingestion concern', async () => {
    const { bundle, diagnostics } = await normalizeGeminiConversation({
        id: 'unknown-source', titles: { rpc: 'Good', 'future-provider-tier': 'Future' }, messages: [],
    });
    assert.strictEqual(bundle.conversation.title, 'Good');
    assert.ok(diagnostics.some((d: any) => d.code === 'TITLE_SOURCE_COERCED'));
    const unknown = await normalizeGeminiConversation({
        id: 'unknown-source-only', title: 'Plain title', titleSource: 'future-provider-tier', messages: [],
    });
    assert.strictEqual(unknown.bundle.conversation.title, 'Plain title');
    assert.ok(unknown.diagnostics.some((d: any) => d.code === 'TITLE_SOURCE_COERCED'));
});

test('conversation URL uses url before href and stays outside extensions', async () => {
    for (const raw of [
        { url: 'https://gemini.google.com/app/url', href: 'https://gemini.google.com/app/href' },
        { href: 'https://gemini.google.com/app/href' },
    ]) {
        const { bundle } = await normalizeGeminiConversation({ id: 'url', messages: [], ...raw });
        assert.strictEqual(bundle.conversation.url, raw.url || raw.href);
        assert.strictEqual(bundle.conversation.extensions, undefined);
    }
});


test('unknown fields are reported as independent diagnostics, never document metadata', async () => {
    const raw = { id: 'unknown-fields', futureConversationField: { secret: 'raw' }, messages: [
        { id: 'm', role: 'user', content: 'visible', futureMessageField: { secret: 'raw' } },
    ] };
    const { bundle, diagnostics } = await normalizeGeminiConversation(raw);
    assert.deepStrictEqual(diagnostics.find((d: any) => d.code === 'UNKNOWN_CONVERSATION_FIELDS').details.fields, ['futureConversationField']);
    const messageDiagnostic = diagnostics.find((d: any) => d.code === 'UNKNOWN_MESSAGE_FIELDS');
    assert.deepStrictEqual(messageDiagnostic.details.fields, ['futureMessageField']);
    assert.strictEqual(messageDiagnostic.sourceRef.locator, 'messages[0]');
    assert.deepStrictEqual(Object.keys(bundle).sort(), ['assets', 'citations', 'conversation', 'schemaVersion']);
    const walk = (v: any): void => {
        if (!v || typeof v !== 'object') return;
        for (const key of ['sourceRef', 'extensions', 'state', 'observations', 'diagnostics', 'observedAt']) {
            assert.ok(!(key in v), `document must omit ${key}`);
        }
        Object.values(v).forEach(walk);
    };
    walk(bundle);
});
