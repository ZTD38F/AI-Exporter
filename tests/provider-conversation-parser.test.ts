import { fixtureAccountFor } from './helpers/domainFixture.js';
import { useIndexStorage } from './helpers/indexStorage.js';
useIndexStorage();
/** Provider parsing, Domain closure and composed attachment-placement regressions. */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { parseFixture } = require('./helpers/documentFixture.js');
const { composeDomainDocument } = require('../src/l3b/compose/composeDomainDocument.js');
const { assertDomainClosure } = require('../src/l2/closure.js');
const { textOfBlock, textOfInline } = require('./helpers/contentText.js');
const { renderDocumentMarkdown } = require('../src/l4/format/markdown/renderMarkdown.js');

const fixtureDir = path.join(__dirname, 'fixtures', 'provider');
const sample = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'conversation-sample.json'), 'utf8'));
const turnsSample = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'conversation-turns.json'), 'utf8'));

function textOf(node: any) {
    return (node.children || []).map((c: any) => c.text || '').join('');
}

test('markdown body keeps block order and structure', async () => {
    const { domain, document, resources, diagnostics } = await parseFixture(sample);
    const user = domain.detail.messages.find((m: any) => m.id === 'm-u1');
    assert.ok(user, 'user message m-u1 present');
    const kinds = user.content.map((b: any) => b.type);
    assert.deepStrictEqual(kinds, [
        'heading', 'paragraph', 'list', 'list', 'quote', 'thematicBreak', 'paragraph',
    ]);

    // Heading.
    assert.strictEqual(user.content[0].level, 1);
    assert.strictEqual(textOf(user.content[0]), 'Shopping list');

    // Inline emphasis in the paragraph.
    const inlineKinds = user.content[1].children.map((c: any) => c.type);
    assert.ok(inlineKinds.includes('strong'), 'bold survives');
    assert.ok(inlineKinds.includes('emphasis'), 'italic survives');
    assert.ok(inlineKinds.includes('strikethrough'), 'strikethrough survives');
    const strong = user.content[1].children.find((c: any) => c.type === 'strong');
    assert.strictEqual(textOf(strong), 'milk');

    // Unordered list with a nested list under the first item.
    const ul = user.content[2];
    assert.strictEqual(ul.ordered, false);
    assert.strictEqual(ul.items.length, 2);
    assert.strictEqual(ul.items[0].blocks.length, 2);
    assert.strictEqual(ul.items[0].blocks[1].type, 'list');
    assert.deepStrictEqual(
        ul.items[0].blocks[1].items.map((it: any) => textOf(it.blocks[0])),
        ['fuji', 'gala'],
    );

    // Ordered list.
    const ol = user.content[3];
    assert.strictEqual(ol.ordered, true);
    assert.strictEqual(ol.start, 1);
    assert.strictEqual(ol.items.length, 2);

    // Quote + thematic break.
    assert.strictEqual(user.content[4].type, 'quote');
    assert.strictEqual(textOf(user.content[4].blocks[0]), 'remember the receipt');
    assert.strictEqual(user.content[5].type, 'thematicBreak');

    // Inline markdown image is a first-class ImageInline: it references an
    // asset by id and is never demoted to unsupported text.
    const imgPara = user.content[6];
    assert.strictEqual(imgPara.type, 'paragraph');
    const img = imgPara.children.find((c: any) => c.type === 'image');
    assert.ok(img, 'inline image is a first-class image inline node');
    assert.strictEqual(img.alt, 'alt text');
    assert.ok(img.assetId, 'inline image references an asset');
    const imgAsset = domain.detail.assets.find((a: any) => a.id === img.assetId);
    assert.ok(imgAsset, 'inline image asset is in the Domain asset registry');
    assert.strictEqual(imgAsset.kind, 'image');
    assert.equal(resources[imgAsset.id], undefined);
    assert.strictEqual(imgAsset.sourceUri, 'https://example.com/inline.png');
    assert.strictEqual(textOfInline(img), 'alt text', 'alt text survives as readable fallback');
    assert.ok(!diagnostics.some((d: any) => d.code === 'INLINE_IMAGE_DOWNGRADE'), 'no downgrade diagnostic');
    assert.ok(!diagnostics.some((d: any) => d.severity === 'error'), 'no error diagnostics');
});

test('reasoning is parsed before Domain and composed as a disclosure', async () => {
    const { domain, document, resources, sourceVersion } = await parseFixture(sample);
    const model = domain.detail.messages.find((m: any) => m.id === 'm-a1');
    const thought = document.messages[domain.detail.messages.indexOf(model)].blocks[0];
    assert.strictEqual(thought.type, 'disclosure');
    assert.strictEqual(thought.kind, 'reasoning');
    assert.ok(textOf(thought.blocks[0]).includes('The user wants a plan'), 'thought text preserved');
    assert.ok(!('initiallyCollapsed' in thought), 'no rendering state leaks into Domain');
});

test('citations have message-local Domain identities referenced by content nodes', async () => {
    const { domain, document, resources, sourceVersion } = await parseFixture(sample);
    // Duplicate URL collapses to one message-local citation.
    assert.strictEqual(domain.detail.messages.find((m: any) => m.id === 'm-a1').citations.length, 2);
    assert.deepStrictEqual(
        domain.detail.messages.find((m: any) => m.id === 'm-a1').citations.map((c: any) => c.url).sort(),
        ['https://example.com/docs-page', 'https://example.com/plan'],
    );
    assert.deepStrictEqual(
        domain.detail.messages.find((m: any) => m.id === 'm-a1').citations.map((c: any) => c.title).sort(),
        ['Docs reference', 'Plan source'],
    );

    const model = domain.detail.messages.find((m: any) => m.id === 'm-a1');
    assert.deepStrictEqual(
        model.citations.map((c: any) => c.id).sort(),
        domain.detail.messages.find((m: any) => m.id === 'm-a1').citations.map((c: any) => c.id).sort(),
    );
    assert.ok(!model.content.some((b: any) => b.type === 'citationGroup'), 'no citationGroup in blocks');

    // [1]/[2] markers map to citationRef inlines pointing at the right ids.
    const para = model.content[0];
    const refs = para.children.filter((c: any) => c.type === 'citationRef');
    assert.strictEqual(refs.length, 2);
    const byId: Map<string, any> = new Map(domain.detail.messages.find((m: any) => m.id === 'm-a1').citations.map((c: any) => [c.id, c.url]));
    assert.strictEqual(byId.get(refs[0].citationId), 'https://example.com/plan');
    assert.strictEqual(byId.get(refs[1].citationId), 'https://example.com/docs-page');
    assert.strictEqual(refs[0].label, '[1]');
    assert.strictEqual(refs[1].label, '[2]');

    // Inline math and link survive in the same paragraph.
    const math = para.children.find((c: any) => c.type === 'inlineMath');
    assert.ok(math && math.source === 'E=mc^2');
    const link = model.content.find((b: any) => b.type === 'paragraph' && b.children.some((c: any) => c.type === 'link'));
    assert.ok(link.children.find((c: any) => c.type === 'link' && c.href === 'https://example.com/docs'));

    // Code fence, table, display math.
    const code = model.content.find((b: any) => b.type === 'code');
    assert.strictEqual(code.language, 'python');
    assert.ok(code.code.includes('print("hello")'));
    const table = model.content.find((b: any) => b.type === 'table');
    assert.deepStrictEqual(table.columns.map((c: any) => c.align), ['left', 'right']);
    assert.deepStrictEqual(table.headerRows[0].cells.map((c: any) => textOf(c)), ['item', 'qty']);
    assert.deepStrictEqual(table.rows[0].cells.map((c: any) => textOf(c)), ['milk', '2']);
    const mathBlock = model.content.find((b: any) => b.type === 'math');
    assert.strictEqual(mathBlock.source, '\\frac{a}{b}');
});

test('attachments deduplicate semantic assets and prepare separate resource bindings', async () => {
    const { domain, document, resources, diagnostics } = await parseFixture(sample);
    // receipt.png appears in both attachments[] and images[] -> one asset.
    // Plus the inline markdown image in m-u1 -> one source-URI asset.
    assert.strictEqual(domain.detail.assets.length, 4);
    const byName: Map<string, any> = new Map(domain.detail.assets.map((a: any) => [a.name, a]));
    const receipt = byName.get('receipt.png');
    assert.strictEqual(receipt.kind, 'image');
    assert.equal(resources[receipt.id], 'assets/receipt.png');
    assert.strictEqual(receipt.mediaType, 'image/png');

    const plan = byName.get('plan.pdf');
    assert.strictEqual(plan.kind, 'file');
    assert.equal(resources[plan.id], undefined);
    assert.strictEqual(plan.sourceUri, 'https://example.com/files/plan.pdf');

    const corrupt = byName.get('corrupt.bin');
    assert.equal(resources[corrupt.id], undefined);
    assert.equal(corrupt.source, undefined);

    // Placement blocks reference the assets; message keeps the association index.
    // The inline markdown image asset joins the association too.
    const user = domain.detail.messages.find((m: any) => m.id === 'm-u1');
    const inlineImg = byName.get('alt text');
    assert.ok(inlineImg, 'inline image asset present');
    assert.ok(user.attachmentIds.includes(receipt.id));
    const imgBlock = document.messages[domain.detail.messages.indexOf(user)].blocks.find((b: any) => b.type === 'image');
    assert.equal(imgBlock.resourceId, receipt.id);
    const model = domain.detail.messages.find((m: any) => m.id === 'm-a1');
    const fileBlocks = document.messages[domain.detail.messages.indexOf(model)].blocks.filter((b: any) => b.type === 'file');
    assert.strictEqual(fileBlocks.length, 2);
});

test('unknown role and non-string content are preserved, never dropped', async () => {
    const { domain, document, resources, diagnostics } = await parseFixture(sample);
    const weird = domain.detail.messages.find((m: any) => m.id === 'm-x1');
    assert.ok(weird, 'message with unknown role is kept');
    assert.strictEqual(weird.role, 'unknown');
    assert.equal(Object.hasOwn(weird, 'provenance'), false);
    assert.ok(diagnostics.some((d: any) => d.code === 'UNKNOWN_ROLE'), 'unknown role is diagnosed');

    const ub = weird.content[0];
    assert.strictEqual(ub.type, 'unknown');
    assert.strictEqual(ub.sourceType, 'message-content');
    assert.strictEqual(ub.text, '{"not": "a string"}');
    assert.deepStrictEqual(Object.keys(ub).sort(), ['sourceType', 'text', 'type']);
    assert.ok(textOfBlock(ub).length > 0, 'unknown block has a readable fallback');
    assert.ok(diagnostics.some((d: any) => d.code === 'UNKNOWN_MESSAGE_CONTENT'));
});

test('non-string content becomes bounded, deterministic visible text at normalization', async () => {
    const { domain, document, resources, diagnostics } = await parseFixture({ id: 'bounded', messages: [
        { id: 'm1', role: 'assistant', content: { z: 1, a: 2 } },
        { id: 'm2', role: 'assistant', content: { a: { b: { c: { d: { e: 1 } } } } } },
        { id: 'm3', role: 'assistant', content: { s: 'x'.repeat(5000) } },
    ] });
    const blocks = domain.detail.messages.map((m: any) => m.content[0]);
    assert.strictEqual(blocks[0].text, '{"a": 2, "z": 1}');
    assert.ok(blocks[1].text.includes('{…}'));
    assert.ok(blocks[2].text.endsWith('…'));
    assert.ok(blocks[2].text.length <= 2001);
    assert.ok(diagnostics.some((d: any) => d.code === 'UNKNOWN_MESSAGE_CONTENT'));
});

test('title authority: rpc candidate wins over takeout/sniff', async () => {
    const { domain, document, resources, sourceVersion } = await parseFixture(sample);
    const title = domain.index.title;
    assert.strictEqual(title, 'RPC Authoritative Title');
    const low = await parseFixture({ id: 'x', title: 'Derived topic', titleSource: 'derived', messages: [] });
    assert.strictEqual(low.domain.index.title, 'Derived topic');
});

test('conversation identity and authored timestamp facts are preserved', async () => {
    const { domain, document, resources, sourceVersion } = await parseFixture(sample);
    const conv = domain.index;
    assert.strictEqual(fixtureAccountFor(domain).providerId, 'gemini');
    assert.strictEqual(conv.key.conversationId, 'f2b_sample_001');
    assert.strictEqual(conv.createdAt, sample.createdAt);
    assert.strictEqual(sourceVersion, sample.updatedAt);
    assert.strictEqual(conv.updatedAt, sample.updatedAt);
    assert.strictEqual(conv.url, undefined);
});

test('turns shape flattens to user/assistant messages', async () => {
    const { domain, document, resources } = await parseFixture(turnsSample);
    assert.strictEqual(domain.detail.messages.length, 4);
    assert.deepStrictEqual(
        domain.detail.messages.map((m: any) => m.role),
        ['user', 'assistant', 'user', 'assistant'],
    );
    const t1Model = domain.detail.messages[1];
    assert.ok(textOf(t1Model.reasoning[0]).includes('greeting detected'));
    assert.strictEqual(textOf(t1Model.content[0]), 'I am a test assistant.');
    const t2Model = domain.detail.messages[3];
    const code = t2Model.content.find((b: any) => b.type === 'code');
    assert.strictEqual(code.language, 'js');
    const gen = domain.detail.assets.find((a: any) => a.name === 'generated.png');
    assert.ok(gen, 'generated attachment mapped');
    assert.equal(resources[gen.id], undefined);
    assert.ok(gen.sourceUri);
});

test('parsed Domain is closed, JSON portable and does not mutate raw fixtures', async () => {
    for (const raw of [sample, turnsSample]) {
        const before = JSON.stringify(raw);
        const { domain, document, diagnostics } = await parseFixture(raw);
        assertDomainClosure((domain).detail);
        const roundTrip = JSON.parse(JSON.stringify(domain));
        assertDomainClosure((roundTrip).detail);
        assert.deepEqual(composeDomainDocument(roundTrip, fixtureAccountFor(roundTrip), { sourceVersion: require('./helpers/nativeFixture.js').historicalFixture(raw).sourceVersion }), document);
        assert.equal(JSON.stringify(raw), before);
        assert.ok(!diagnostics.some((d: any) => d.severity === 'error'));
    }
});

function inlineImagesOf(message: any) {
    const out = [];
    for (const b of message.content || []) {
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
                { url: 'https://example.com/foo/image.png', localName: 'assets/foo/image.png', name: 'image.png', type: 'image', mimeType: 'image/png' },
                { url: 'https://example.com/bar/image.png', localName: 'assets/bar/image.png', name: 'image.png', type: 'image', mimeType: 'image/png' },
            ],
        }],
    };
    const { domain, document, resources, diagnostics } = await parseFixture(input);
    const m1 = domain.detail.messages.find((m: any) => m.id === 'm1');
    const inlineImgs = inlineImagesOf(m1);
    assert.strictEqual(inlineImgs.length, 1, 'one inline image parsed');
    const attachmentIds = new Set(m1.attachmentIds);
    assert.strictEqual(attachmentIds.size, 2, 'both attachments become assets');
    assert.ok(!attachmentIds.has(inlineImgs[0].assetId),
        'inline image must NOT bind to either attachment when the basename is ambiguous');
    assert.equal(domain.detail.assets.length, 3);
    assertDomainClosure((domain).detail);
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
                { url: 'https://example.com/foo/image.png', localName: 'assets/foo/image.png', name: 'image.png', type: 'image', mimeType: 'image/png' },
            ],
        }],
    };
    const { domain, document, resources, diagnostics } = await parseFixture(input);
    const m1 = domain.detail.messages.find((m: any) => m.id === 'm1');
    const inlineImgs = inlineImagesOf(m1);
    assert.strictEqual(inlineImgs.length, 1);
    assert.strictEqual(inlineImgs[0].assetId, m1.attachmentIds[0], 'unique basename binds to the attachment asset');
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
                { url: 'https://example.com/foo/image.png', localName: 'assets/foo/image.png', name: 'image.png', type: 'image', mimeType: 'image/png' },
                { url: 'https://example.com/bar/image.png', localName: 'assets/bar/image.png', name: 'image.png', type: 'image', mimeType: 'image/png' },
            ],
        }],
    };
    const { domain, document, resources, diagnostics } = await parseFixture(input);
    const m1 = domain.detail.messages.find((m: any) => m.id === 'm1');
    const inlineImgs = inlineImagesOf(m1);
    assert.strictEqual(inlineImgs.length, 1);
    assert.strictEqual(inlineImgs[0].assetId, m1.attachmentIds[1], 'exact full ref binds deterministically to the right asset');
    assert.ok(!diagnostics.some((d: any) => d.code === 'AMBIGUOUS_INLINE_IMAGE_ASSET'), 'no ambiguity diagnostic');
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
    walkBlocks(message.content);
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

test('inline markdown image reusing an attachment asset preserves inline and explicit attachment placements', async () => {
    const input = attachmentConv('see ![pic](assets/shot.png)', [pngAttachment('assets/shot.png', 'shot.png')]);
    const { domain, document, resources } = await parseFixture(input);
    const m1 = domain.detail.messages.find((m: any) => m.id === 'm1');
    assert.strictEqual(domain.detail.assets.length, 1);
    const inlines = deepInlineImagesOf(m1);
    assert.strictEqual(inlines.length, 1);
    assert.strictEqual(inlines[0].assetId, m1.attachmentIds[0]);
    assert.strictEqual(blockImagesOf(document.messages[domain.detail.messages.indexOf(m1)]).length, 1);
});

test('linked inline image reusing an attachment asset preserves inline and explicit attachment placements', async () => {
    const input = attachmentConv('[![pic](assets/shot.png)](https://example.com/full)', [pngAttachment('assets/shot.png', 'shot.png')]);
    const { domain, document, resources } = await parseFixture(input);
    const m1 = domain.detail.messages.find((m: any) => m.id === 'm1');
    assert.strictEqual(domain.detail.assets.length, 1);
    const inlines = deepInlineImagesOf(m1);
    assert.strictEqual(inlines.length, 1);
    assert.strictEqual(inlines[0].assetId, m1.attachmentIds[0]);
    assert.strictEqual(blockImagesOf(document.messages[domain.detail.messages.indexOf(m1)]).length, 1);
});

test('attachment not referenced inline keeps its trailing image block', async () => {
    const input = attachmentConv('no images here', [pngAttachment('assets/shot.png', 'shot.png')]);
    const { domain, document, resources } = await parseFixture(input);
    const m1 = domain.detail.messages.find((m: any) => m.id === 'm1');
    assert.strictEqual(domain.detail.assets.length, 1);
    assert.strictEqual(deepInlineImagesOf(m1).length, 0);
    const blocks = blockImagesOf(document.messages[domain.detail.messages.indexOf(m1)]);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].resourceId, m1.attachmentIds[0]);
});

test('two attachments with only one inlined keep one inline and both explicit trailing blocks', async () => {
    const input = attachmentConv('see ![a](assets/a.png)', [
        pngAttachment('assets/a.png', 'a.png'),
        pngAttachment('assets/b.png', 'b.png'),
    ]);
    const { domain, document, resources } = await parseFixture(input);
    const m1 = domain.detail.messages.find((m: any) => m.id === 'm1');
    assert.strictEqual(domain.detail.assets.length, 2);
    const inlines = deepInlineImagesOf(m1);
    assert.strictEqual(inlines.length, 1);
    assert.strictEqual(inlines[0].assetId, m1.attachmentIds[0]);
    const blocks = blockImagesOf(document.messages[domain.detail.messages.indexOf(m1)]);
    assert.strictEqual(blocks.length, 2);
    assert.deepEqual(blocks.map((block: {resourceId: string}) => block.resourceId), m1.attachmentIds);
});


test('composer preserves duplicate source message IDs for every backend', async () => {
    const { domain, document } = await parseFixture({ id: 'dup', messages: [{ id: 'same', role: 'user', content: 'one' }, { id: 'same', role: 'model', content: 'two' }] });
    assert.deepEqual(domain.detail.messages.map((message: { id?: string }) => message.id), ['same', 'same']);
    assert.equal(document.messages.length, 2);
    assert.ok(document.messages.every((message: object) => !('id' in message)));
    assert.match(JSON.stringify(document.messages[0].blocks), /one/);
    assert.match(JSON.stringify(document.messages[1].blocks), /two/);
});
test('title authority and unknown source handling remain ingestion concerns', async () => {
    const { domain } = await parseFixture({ id: 'unknown-source', titles: { rpc: 'Good', 'future-provider-tier': 'Future' }, messages: [] });
    assert.equal(domain.index.title, 'Good');
    const unknown = await parseFixture({ id: 'unknown-source-only', title: 'Plain title', titleSource: 'future-provider-tier', messages: [] });
    assert.equal(unknown.domain.index.title, 'Plain title');
    assert.equal(unknown.domain.index.titleSource, 'derived');
    assert.equal(require('../src/l2/titleAuthority.js').titleAuthorityRank(unknown.domain.index.titleSource), require('../src/l2/titleAuthority.js').titleAuthorityRank('derived'));
});
test('source URL aliases do not enter Domain or get synthesized by Composer', async () => {
    for (const raw of [{ url: 'https://gemini.google.com/app/url', href: 'https://gemini.google.com/app/href' }, { href: 'https://gemini.google.com/app/href' }]) {
        const { domain } = await parseFixture({ id: 'url', messages: [], ...raw });
        assert.equal(domain.index.url, undefined);
        assert.equal(domain.href, undefined);
        assert.ok(!/^url:/m.test(renderDocumentMarkdown(composeDomainDocument(domain, fixtureAccountFor(domain)), {}, { includeFrontMatter: true })));
    }
});
test('unknown raw fields are omitted from Domain and AST without mutating input', async () => {
    const raw = { id: 'unknown-fields', futureConversationField: { secret: 'raw' }, messages: [{ id: 'm', role: 'user', content: 'visible', futureMessageField: { secret: 'raw' } }] };
    const before = JSON.stringify(raw);
    const { domain, document } = await parseFixture(raw);
    assert.equal(JSON.stringify(raw), before);
    for (const value of [domain, document]) {
        const json = JSON.stringify(value);
        for (const key of ['futureConversationField', 'futureMessageField', 'rawRef', 'extensions', 'observations', 'diagnostics', 'observedAt']) assert.ok(!json.includes(`"${key}"`), key);
    }
});
