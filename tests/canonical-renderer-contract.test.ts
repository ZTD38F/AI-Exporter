/**
 * tests/canonical-renderer-contract.test.ts
 *
 * Item 3: cross-renderer contract gate (CanonicalHtmlRenderer x Typst payload).
 * Unlike tests/canonical-contract.test.ts (F2a schema/validation layer), this
 * gate asserts the two RENDER paths agree: for each of the 12 most common
 * canonical features, the main text must appear in BOTH outputs, key asset
 * placements must exist on BOTH sides, and nothing may be silently dropped
 * (no error diagnostics, no drop-indicating warning codes).
 *
 * Item 15: asset block placement gate (same file). Both render paths must
 * route asset blocks faithfully so future renderers cannot drop them.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execSync } = require('node:child_process');

const { renderCanonicalHtml } = require('../src/core/export/canonical/renderCanonicalHtml.js');
const { toTypstPayload } = require('../src/core/export/typst/payload.js');

const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- builders

const txt = (text: string) => ({ type: 'text', text });
const para = (text: string) => ({ type: 'paragraph', children: [txt(text)] });

function bundle(blocks: any[], extra: any = {}, messageExtra: any = {}) {
    return {
        schemaVersion: 1,
        conversation: {
            key: { providerId: 'gemini', accountId: 'test-account', conversationId: 'c1' },
            title: 'Contract',
            createdAt: '2026-09-26T10:00:00Z',
            messages: [{ id: 'm1', role: 'assistant', blocks, ...messageExtra }],
        },
        assets: [],
        citations: [],
        ...extra,
    };
}

const imgAsset = (id: string, name: string) => ({
    id, kind: 'image', name, mimeType: 'image/png', sizeBytes: 1024, status: 'available',
});
const fileAsset = (id: string, name: string) => ({
    id, kind: 'file', name, mimeType: 'application/pdf', sizeBytes: 2048, status: 'available',
});

const HTML_OPTS = { assetUrl: (a: any) => `https://img.test/${a.id}` };
const TYPST_OPTS = { assetPath: (a: any) => `assets/${a.id}.png` };

function renderBoth(blocks: any[], extra: any = {}, messageExtra: any = {}) {
    const b = bundle(blocks, extra, messageExtra);
    const { html, diagnostics: htmlDiags } = renderCanonicalHtml(b, HTML_OPTS);
    const { payload, diagnostics: typstDiags } = toTypstPayload(b, TYPST_OPTS);
    return { html: html as string, htmlDiags: htmlDiags as any[], payload: payload as any, typstDiags: typstDiags as any[] };
}

const typstText = (payload: any): string => JSON.stringify(payload);

const DROP_CODE_PATTERN = /DROP|MISSING|UNRESOLVED|TRUNCATED/i;

function assertNoSilentDrop(htmlDiags: any[], typstDiags: any[], feature: string) {
    for (const d of htmlDiags) {
        assert.notStrictEqual(d.severity, 'error', `${feature}: html error diagnostic: ${JSON.stringify(d)}`);
        assert.ok(!DROP_CODE_PATTERN.test(d.code ?? ''), `${feature}: html drop-indicating warning ${d.code}: ${JSON.stringify(d)}`);
    }
    for (const d of typstDiags) {
        assert.notStrictEqual(d.severity, 'error', `${feature}: typst error diagnostic: ${JSON.stringify(d)}`);
        assert.ok(!DROP_CODE_PATTERN.test(d.code ?? ''), `${feature}: typst drop-indicating warning ${d.code}: ${JSON.stringify(d)}`);
    }
}

// ---------------------------------------------------------------- fixtures

test('contract: paragraph text survives in HTML and Typst', () => {
    const s = 'SENTINEL_PARA_A1B2';
    const { html, htmlDiags, payload, typstDiags } = renderBoth([para(s)]);
    assert.ok(html.includes(s), 'html keeps paragraph text');
    assert.ok(typstText(payload).includes(s), 'typst keeps paragraph text');
    assertNoSilentDrop(htmlDiags, typstDiags, 'paragraph');
});

test('contract: heading text and level survive in HTML and Typst', () => {
    const s = 'SENTINEL_HEADING_C3D4';
    const blocks = [{ type: 'heading', level: 2, children: [txt(s)] }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(blocks);
    assert.ok(html.includes('<h2'), 'html keeps h2');
    assert.ok(html.includes(s), 'html keeps heading text');
    assert.ok(typstText(payload).includes('"type":"heading"'), 'typst has heading node');
    assert.ok(typstText(payload).includes(s), 'typst keeps heading text');
    assertNoSilentDrop(htmlDiags, typstDiags, 'heading');
});

test('contract: strong and emphasis survive in HTML and Typst', () => {
    const s1 = 'SENTINEL_STRONG_E5F6';
    const s2 = 'SENTINEL_EM_G7H8';
    const blocks = [{
        type: 'paragraph',
        children: [
            { type: 'strong', children: [txt(s1)] },
            txt(' and '),
            { type: 'emphasis', children: [txt(s2)] },
        ],
    }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(blocks);
    assert.ok(html.includes(`<strong>${s1}</strong>`), 'html uses strong');
    assert.ok(html.includes(`<em>${s2}</em>`), 'html uses em');
    const jt = typstText(payload);
    assert.ok(jt.includes(s1) && jt.includes(s2), 'typst keeps both runs');
    assertNoSilentDrop(htmlDiags, typstDiags, 'strong/emphasis');
});

test('contract: code block content survives in HTML and Typst', () => {
    const s = 'SENTINEL_CODE_I9J0';
    const blocks = [{ type: 'code', code: `print("${s}")`, language: 'python' }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(blocks);
    assert.ok(html.includes(s), 'html keeps code text');
    const jt = typstText(payload);
    assert.ok(jt.includes('"type":"code"'), 'typst has code node');
    assert.ok(jt.includes(s), 'typst keeps code text');
    assertNoSilentDrop(htmlDiags, typstDiags, 'code');
});

test('contract: list items survive in HTML and Typst', () => {
    const s1 = 'SENTINEL_LIST_K1L2';
    const s2 = 'SENTINEL_LIST_M3N4';
    const blocks = [{
        type: 'list', ordered: false,
        items: [{ blocks: [para(s1)] }, { blocks: [para(s2)] }],
    }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(blocks);
    assert.ok(html.includes('<ul'), 'html uses ul');
    assert.ok(html.includes(s1) && html.includes(s2), 'html keeps both items');
    const jt = typstText(payload);
    assert.ok(jt.includes('"type":"list"'), 'typst has list node');
    assert.ok(jt.includes(s1) && jt.includes(s2), 'typst keeps both items');
    assertNoSilentDrop(htmlDiags, typstDiags, 'list');
});

test('contract: table cells survive in HTML and Typst', () => {
    const s = 'SENTINEL_CELL_O5P6';
    const blocks = [{
        type: 'table',
        headerRows: [{ cells: [{ children: [txt('Head SENTINEL_CELL_HDR')] }] }],
        rows: [{ cells: [{ children: [txt(s)] }] }],
    }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(blocks);
    assert.ok(html.includes('<table'), 'html uses table');
    assert.ok(html.includes(s), 'html keeps cell text');
    const jt = typstText(payload);
    assert.ok(jt.includes('"type":"table"'), 'typst has table node');
    assert.ok(jt.includes(s), 'typst keeps cell text');
    assertNoSilentDrop(htmlDiags, typstDiags, 'table');
});

test('contract: image block placement exists on both renderers', () => {
    const s = 'SENTINEL_IMG_Q1W2';
    const blocks = [{ type: 'image', assetId: 'imgA', alt: s }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(
        blocks,
        { assets: [imgAsset('imgA', 'imgA.png')] },
    );
    assert.ok(html.includes('src="https://img.test/imgA"'), 'html renders image block');
    const msgBlocks = payload.messages[0].blocks ?? [];
    assert.ok(
        msgBlocks.some((b: any) => b.type === 'image' && b.asset === 'assets/imgA.png'),
        `typst blocks place the image, got: ${JSON.stringify(msgBlocks)}`,
    );
    assertNoSilentDrop(htmlDiags, typstDiags, 'image block');
});

test('contract: file block placement exists on both renderers', () => {
    const s = 'SENTINEL_FILE_Q7R8.pdf';
    const blocks = [{ type: 'file', assetId: 'fileB', label: s }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(
        blocks,
        { assets: [fileAsset('fileB', s)] },
    );
    assert.ok(html.includes(s), 'html renders file card');
    const msgBlocks = payload.messages[0].blocks ?? [];
    assert.ok(
        msgBlocks.some((b: any) => b.type === 'file' && b.name === s),
        `typst blocks place the file, got: ${JSON.stringify(msgBlocks)}`,
    );
    assertNoSilentDrop(htmlDiags, typstDiags, 'file block');
});

test('contract: citation label and message sources survive in HTML and Typst', () => {
    const s = 'SENTINEL_CITE_T5Y6';
    const blocks = [
        { type: 'paragraph', children: [txt(s), { type: 'citationRef', citationId: 'cite1' }] },
    ];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(
        blocks,
        {
            citations: [{ id: 'cite1', kind: 'web', url: 'https://example.com/article' }],
        },
        { citationIds: ['cite1'] },
    );
    assert.ok(html.includes('gem-citation-ref'), 'html renders citation ref');
    assert.ok(html.includes('[1]'), 'html shows citation number');
    assert.ok(html.includes('gem-citation-group'), 'html keeps sources section');
    const jt = typstText(payload);
    assert.ok(jt.includes(s), 'typst keeps paragraph text');
    assert.ok(jt.includes('[1]'), 'typst keeps citation label');
    assertNoSilentDrop(htmlDiags, typstDiags, 'citation');
});

test('contract: thought inner text survives in HTML and Typst', () => {
    const s = 'SENTINEL_THOUGHT_S9T0';
    const blocks = [{ type: 'thought', disclosure: 'providerExposed', kind: 'reasoning', blocks: [para(s)] }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(blocks);
    assert.ok(html.includes(s), 'html keeps thought text');
    const jt = typstText(payload);
    assert.ok(jt.includes(s), 'typst keeps thought text');
    assertNoSilentDrop(htmlDiags, typstDiags, 'thought');
});

test('contract: unknown block fallback is visible on both renderers', () => {
    const s = 'SENTINEL_UNKNOWN_F1B2';
    const blocks = [{
        type: 'unknown', sourceType: 'SENTINEL_UNKNOWN_SRC',
        text: s,
    }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(blocks);
    assert.ok(html.includes(s), 'html shows unknown fallback text');
    assert.ok(html.includes('SENTINEL_UNKNOWN_SRC'), 'html labels the unknown source type');
    const jt = typstText(payload);
    assert.ok(jt.includes(s), 'typst shows unknown fallback text');
    assert.ok(jt.includes('SENTINEL_UNKNOWN_SRC'), 'typst keeps the unknown source type');
    assertNoSilentDrop(htmlDiags, typstDiags, 'unknown fallback');
});


test('shared collectReferencedAssetIds sees inline images everywhere', () => {
    const blocks: any = [
        {
            type: 'paragraph',
            children: [
                { type: 'text', text: 'before ' },
                { type: 'image', assetId: 'img-para', alt: 'para' },
                { type: 'text', text: ' after' },
            ],
        },
        {
            type: 'heading',
            level: 2,
            children: [{ type: 'image', assetId: 'img-heading', alt: 'h' }],
        },
        {
            type: 'table',
            headerRows: [],
            rows: [
                { cells: [{ children: [{ type: 'image', assetId: 'img-cell', alt: 'c' }] }] },
            ],
        },
        { type: 'image', assetId: 'img-block', alt: 'b' },
    ];
    const ids = require('../src/core/export/canonical/index.js').collectReferencedAssetIds(blocks);
    assert.deepStrictEqual(
        [...ids].sort(),
        ['img-block', 'img-cell', 'img-heading', 'img-para'],
    );
});

test('inline image assets enter the HTML companion resource plan', async () => {
    const bundle: any = {
        schemaVersion: 1,
        conversation: {
            key: { providerId: 'gemini', conversationId: 'inline_asset_001' },
            messages: [
                {
                    id: 'm-1',
                    role: 'model',
                    blocks: [
                        {
                            type: 'paragraph',
                            children: [
                                { type: 'text', text: 'diagram: ' },
                                { type: 'image', assetId: 'img-1', alt: 'architecture' },
                            ],
                        },
                    ],
                },
            ],
        },
        assets: [
            { id: 'img-1', kind: 'image', mimeType: 'image/png', status: 'available', storageRef: 'assets/img-1.png' },
        ],
        citations: [],
    };
    const context: any = {
        bundle,
        locale: 'en',
        signal: new AbortController().signal,
        reportProgress() {},
        assets: {
            resolve: async (assetId: string) => {
                const asset = bundle.assets.find((a: any) => a.id === assetId);
                if (!asset) return null;
                return { asset, renderUrl: `assets/${assetId}.png` };
            },
        },
    };
    const renderer = new (require('../src/core/export/canonical/index.js').CanonicalHtmlRenderer)({});
    const artifact = await renderer.render(context);
    assert.ok(
        artifact.companionResourceIds.includes('img-1'),
        'inline image asset must be in companionResourceIds',
    );
    assert.ok(
        artifact.companionPlan.resourceIds.includes('img-1'),
        'inline image asset must be in the companion plan',
    );
    assert.ok(artifact.content.includes('<img'), 'html references the image');
    assert.ok(
        artifact.content.includes('assets/img-1.png'),
        'html uses the resolved asset url',
    );
});


test('HTML renders all messages in authoritative source order', () => {
    const { renderCanonicalHtml } = require('../src/core/export/canonical/index.js');
    const bundle = { schemaVersion: 1, conversation: {
        key: { providerId: 'gemini', accountId: 'a', conversationId: 'order' },
        messages: ['second', 'first'].map((id) => ({ id, role: 'user', blocks: [{ type: 'paragraph', children: [{ type: 'text', text: id }] }] })),
    }, assets: [], citations: [] };
    const { html } = renderCanonicalHtml(bundle);
    assert.ok(html.indexOf('second') < html.indexOf('first'));
});
