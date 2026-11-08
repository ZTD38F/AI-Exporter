/**
 * Cross-module v2 integration: native L1, L2 admission, L3a persistence,
 * L3b document composition and L4 outputs. Only ZIP input/bytes are external.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { fixtureAccount, fixtureKey } from './helpers/domainFixture.js';
import type { SourceConversationParseResult } from '../src/l1/parsers/parsingResult.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { importTakeout } from '../src/l1/imports/takeout/importTakeout.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { readConversation } from '../src/l2/readConversation.js';
import { getDetail, getIndex } from '../src/l3a/storageService.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
import { serializeDomainJson, JSON_ARCHIVE_VERSION } from '../src/l4/format/json/serializeDomainJson.js';
import { planExportPaths, buildExportFiles, packageExportFiles } from '../src/l4/packaging/index.js';
import { prepareExportResources } from '../src/application/export/prepareExportResources.js';
import type { PreparedResources, ResourceResult, ResourceBytes } from '../src/shared/resources/resourceResult.js';
import { __setZipConstructor, __getZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';

useIndexStorage();
const account = fixtureAccount('gemini');
const key = fixtureKey('native');
const JSZip = require('../lib/jszip.min.js');

function native(): SourceConversationParseResult {
    return {
        conversationId: key.conversationId, sourceVersion: 100,
        conversation: {
            index: { title: 'Source-native title', titleSource: 'provider', updatedAt: 100 },
            detail: {
                savedAt: 100, quality: { status: 'complete' },
                assets: [{ id: 'image', kind: 'image', name: 'photo.png', mediaType: 'image/png',
                    sourceUri: 'https://example.test/photo.png' }],
                messages: [{ id: 'source-message', role: 'assistant', model: 'Authored model',
                    attachmentIds: ['image'], content: [{
                        type: 'table', rows: [{ cells: [{ children: [
                            { type: 'strong', children: [{ type: 'text', text: 'Rich answer' }] },
                            { type: 'image', assetId: 'image' },
                        ] }] }],
                    }],
                }],
            },
        },
        diagnostics: [], acquisitionHints: {},
    };
}
function bind(source: SourceConversationParseResult) {
    const conversationKey = { accountId: account.id, conversationId: source.conversationId };
    return validateParserDomain({
        index: { ...source.conversation.index, key: conversationKey },
        detail: { ...source.conversation.detail, key: conversationKey },
    });
}
const activity = (references: string) =>
    '<div class="outer-cell"><a href="https://gemini.google.com/app/c_native">Chat</a>' +
    '<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">' +
    'Prompted Read ' + references + '<br>2026-09-02T12:00:00Z<br><p>Answer</p></div></div>';
type Entry = { _data: { uncompressedSize: number }; async: (type: string) => Promise<string | Uint8Array> };
function takeoutArchive(html: string, entries: Record<string, Uint8Array> = {}): File {
    const files: Record<string, Entry> = {
        'Takeout/Gemini Apps/MyActivity.html': { _data: { uncompressedSize: html.length }, async: async () => html },
    };
    for (const [name, bytes] of Object.entries(entries)) files[name] = {
        _data: { uncompressedSize: bytes.length }, async: async () => bytes,
    };
    return { file() {}, files } as unknown as File;
}

test('native L1 facts preserve rich content and model through real L2, L3b and three renderers', async () => {
    const source = native(), before = structuredClone(source.conversation);
    const trusted = bind(source);
    await ingestDetail(account.id, source.conversationId, trusted.detail, trusted.index);
    const conversation = await readConversation(key);
    assert.ok(conversation);
    const document = composeDomainDocument(conversation, account);
    const snapshot = structuredClone(document);
    const outputs = [
        renderDocumentHtml(document, {}).html,
        renderDocumentMarkdown(document, {}),
        JSON.stringify(renderDocumentTypst(document, {})),
    ];
    for (const output of outputs) {
        assert.match(output, /Rich answer/);
        assert.match(output, /Authored model/);
    }
    assert.equal(document.messages.length, 1);
    assert.deepEqual([...collectDocumentResources(document).referencedIds], ['image']);
    assert.deepEqual(document, snapshot);
    assert.deepEqual(source.conversation, before);
});

test('L4 JSON serializes trusted native v2 Domain without legacy DTO or mutable source fields', () => {
    const source = native(), before = structuredClone(source);
    const trusted = bind(source);
    const archive = JSON.parse(serializeDomainJson(trusted, account, {}));
    assert.equal(archive.version, JSON_ARCHIVE_VERSION);
    assert.equal(archive.version, 1);
    assert.equal(archive.format, 'gemini-exporter-domain');
    assert.deepEqual(archive.conversation, trusted);
    assert.equal('sourceVersion' in archive, false);
    assert.equal('parsed' in archive, false);
    assert.equal(archive.conversation.detail.messages[0].model, 'Authored model');
    assert.deepEqual(source, before);
    assert.throws(() => validateParserDomain({ ...trusted,
        detail: { ...trusted.detail, quality: { ...trusted.detail.quality, rejectedTurns: 2 } } } as never),
    /Domain contract/);
    assert.throws(() => serializeDomainJson(trusted, fixtureAccount('chatgpt'), {}), /Account\/key mismatch/);
});

test('real v2 Takeout import admits Index/Detail and retains variant filenames as lazy task bytes', async () => {
    const context = createSourceResourceContext();
    const files = {
        'Takeout/Gemini Apps/image-hash': Uint8Array.of(1),
        'Takeout/Gemini Apps/IMG-hash.jpg': Uint8Array.of(2),
        'Takeout/Gemini Apps/script-hash': Uint8Array.of(3),
    };
    const refs = '<a href="image-hash.png">image</a> <a href="IMG-hash.jpeg">photo</a> <a href="script-hash.py">script</a>';
    try {
        const result = await importTakeout(takeoutArchive(activity(refs), files), account.id, undefined, context);
        assert.equal(result.imported, 1);
        assert.equal(result.status, 'partial', 'Takeout is not an online completeness claim');
        const conversation = await readConversation(key);
        assert.ok(conversation);
        assert.ok(await getIndex(key));
        assert.ok(await getDetail(key));
        assert.equal(conversation.detail.assets.length, 3);
        assert.equal(conversation.detail.quality.status, 'partial');
        const assets = conversation.detail.assets;
        const acquired = await Promise.all(assets.map(asset => context.acquire(key, asset)));
        assert.deepEqual(acquired.map(value => [...value.bytes]), [[1], [2], [3]]);
        assert.ok(!JSON.stringify(conversation).includes('dataBase64'));

        const document = composeDomainDocument(conversation, account);
        const prepared: PreparedResources = new Map<string, ResourceResult<ResourceBytes>>(assets.map((asset, i): [string, ResourceResult<ResourceBytes>] =>
            [asset.id, { ok: true, resourceId: asset.id,
                value: { bytes: acquired[i].bytes,
                    mediaType: asset.kind === 'image' ? 'image/png' : 'application/octet-stream' } }]));
        const oldZip = __getZipConstructor();
        __setZipConstructor(JSZip);
        try {
            const [plan] = planExportPaths([{ conversation, prepared,
                fileIds: collectDocumentResources(document).fileIds }], 'markdown');
            const markdown = renderDocumentMarkdown(document, plan.resources);
            const files = buildExportFiles('markdown', plan, markdown, prepared);
            const [packed] = await packageExportFiles([files], 'browserDownload');
            const zip = await JSZip.loadAsync(await (packed.content as Blob).arrayBuffer());
            assert.equal(await zip.file(plan.fileName).async('string'), markdown);
            for (const [i, asset] of assets.entries()) {
                assert.deepEqual(await zip.file(plan.resources[asset.id]).async('uint8array'), acquired[i].bytes);
            }
        } finally { __setZipConstructor(oldZip); }
    } finally { context.release(); }
});

test('a partial Takeout cannot replace a complete v2 Detail or capture its source readers', async () => {
    await ingestDetail(account.id, key.conversationId, {
        savedAt: 9999999999999, quality: { status: 'complete' }, assets: [],
        messages: [{ role: 'assistant', content: [{ type: 'paragraph',
            children: [{ type: 'text', text: 'Keep complete body' }] }] }],
    }, { title: 'Local title', titleSource: 'user', updatedAt: 9999999999999 });
    const context = createSourceResourceContext();
    try {
        const result = await importTakeout(takeoutArchive(activity('<a href="image.png">image</a>'), {
            'Takeout/Gemini Apps/image.png': Uint8Array.of(7),
        }), account.id, undefined, context);
        assert.equal(result.imported, 1);
        const stored = await readConversation(key);
        assert.ok(stored);
        assert.equal(stored.detail.quality.status, 'complete');
        assert.equal(stored.detail.assets.length, 0);
        assert.match(JSON.stringify(stored.detail.messages), /Keep complete body/);
        assert.equal(stored.index.title, 'Local title');
        await assert.rejects(context.acquire(key, { id: 'image', kind: 'image' }), /No supported source locator/);
    } finally { context.release(); }
});

test('ambiguous Takeout ZIP paths never select unrelated resource bytes', async () => {
    const context = createSourceResourceContext();
    try {
        const result = await importTakeout(takeoutArchive(activity('<a href="photo.png">image</a>'), {
            'one/photo.png': Uint8Array.of(1), 'two/photo.png': Uint8Array.of(2),
        }), account.id, undefined, context);
        assert.equal(result.imported, 1);
        assert.equal(result.status, 'partial');
        const stored = await readConversation(key);
        assert.ok(stored);
        const asset = stored.detail.assets[0];
        assert.ok(asset);
        await assert.rejects(context.acquire(key, asset), /No supported source locator/);
    } finally { context.release(); }
});

for (const uri of ['missing.png', 'blob:missing.png', 'file:missing.png', 'custom:missing.png']) {
    test('missing or unsupported Takeout reference ' + uri + ' never fabricates bytes', async () => {
        const context = createSourceResourceContext();
        try {
            const result = await importTakeout(takeoutArchive(activity('<a href="' + uri + '">image</a>')),
                account.id, undefined, context);
            assert.equal(result.imported, 1);
            assert.equal(result.status, 'partial');
            const conversation = await readConversation(key);
            assert.ok(conversation);
            const asset = conversation.detail.assets[0];
            assert.ok(asset);
            await assert.rejects(context.acquire(key, asset), /No supported source locator/);
        } finally { context.release(); }
    });
}

test('Application resources and L4 paths rename output without mutating L1 source identity or bytes', async () => {
    const source = native();
    source.acquisitionHints = { image: { dataBase64: 'AQID' } };
    const trusted = bind(source), before = structuredClone(trusted);
    const context = createSourceResourceContext();
    try {
        context.retainParsed(key, source);
        const prepared = await prepareExportResources(trusted.detail.assets, new Set(['image']),
            (asset, signal) => context.acquire(key, asset, signal));
        const image = prepared.get('image');
        assert.ok(image?.ok);
        assert.deepEqual(image.value.bytes, Uint8Array.of(1, 2, 3));
        const document = composeDomainDocument(trusted, account);
        const [plan] = planExportPaths([{ conversation: trusted, prepared, fileIds: new Set<string>() }], 'markdown');
        const markdown = renderDocumentMarkdown(document, plan.resources);
        assert.match(markdown, /assets\//);
        assert.ok(plan.resources.image.startsWith('assets/'));
        assert.notEqual(plan.resources.image, trusted.detail.assets[0].sourceUri);
        assert.deepEqual(trusted, before);
    } finally { context.release(); }
});
