/**
 * V2 Takeout media lookup is an L1 source-resolver/task-reader contract.
 * Archive bytes belong to SourceResourceContext, while L2/L3a retain only
 * identity and source locators. L4 owns output paths, not the Takeout parser.
 * No durable media cache or deleted v1 AssetPipeline is involved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { activityHtml, takeoutArchive } from './helpers/l1SourceFixture.js';
import { createTakeoutResourceResolver } from '../src/l1/parsers/gemini/takeout/archiveResources.js';
import { parseGeminiTakeoutConversation } from '../src/l1/parsers/gemini/takeout/parseConversation.js';
import { importTakeout } from '../src/l1/imports/takeout/importTakeout.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { readConversation } from '../src/l2/readConversation.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';
import { prepareExportResources } from '../src/application/export/prepareExportResources.js';
import { planExportPaths, buildExportFiles } from '../src/l4/packaging/index.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import type { TakeoutSourceFile } from '../src/l1/parsers/gemini/takeout/archiveResources.js';

useIndexStorage();
const account = fixtureAccount('gemini');
const activityPath = 'Takeout/Gemini/MyActivity.html';
const key = (conversationId: string) => ({ accountId: account.id, conversationId });
const path = (name: string) => 'Takeout/Gemini/' + name;
function entry(bytes: Uint8Array): TakeoutSourceFile {
    return { _data: { uncompressedSize: bytes.byteLength },
        async: async (type: string) => type === 'uint8array' ? bytes.slice() : new TextDecoder().decode(bytes) };
}
function imageActivity(id: string, uri: string, generated = false): string {
    const body = '<p>Takeout answer <img src="' + uri + '"></p>';
    return activityHtml(body, id) + (generated ? '1 generated image' : '');
}
function files(entries: Record<string, Uint8Array>) {
    return Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, entry(bytes)]));
}

test('Takeout source resolver prefers the exact archive URI over duplicate basenames', () => {
    const selected = entry(Uint8Array.of(1, 2));
    const other = entry(Uint8Array.of(3, 4));
    const resolve = createTakeoutResourceResolver({
        [path('archive-0.png')]: selected,
        [path('older/archive-0.png')]: other,
    }, activityPath);
    const result = resolve(path('archive-0.png'));
    assert.equal(result.status, 'resolved');
    if (result.status !== 'resolved') return;
    assert.equal(result.method, 'archive-path');
    assert.equal(result.resource.path, path('archive-0.png'));
    assert.strictEqual(result.resource.entry, selected);
});

test('Takeout reference relative to activity HTML takes priority over an unrelated duplicate filename', () => {
    const selected = entry(Uint8Array.of(10)), other = entry(Uint8Array.of(20));
    const resolve = createTakeoutResourceResolver({
        [path('assets/diagram.png')]: selected,
        [path('backup/assets/diagram.png')]: other,
    }, activityPath);
    const result = resolve('assets/diagram.png');
    assert.equal(result.status, 'resolved');
    if (result.status !== 'resolved') return;
    assert.equal(result.method, 'relative-path');
    assert.strictEqual(result.resource.entry, selected);
});

test('unique basename or normalized Takeout wrapper may resolve, but duplicate candidates never pick arbitrary bytes', () => {
    const one = entry(Uint8Array.of(1)), two = entry(Uint8Array.of(2));
    const single = createTakeoutResourceResolver({ [path('images/graph.png')]: one }, activityPath);
    const unique = single('graph.png');
    assert.equal(unique.status, 'resolved');
    if (unique.status === 'resolved') assert.strictEqual(unique.resource.entry, one);
    const wrapped = createTakeoutResourceResolver({ [path('images/graph.png.synced')]: one }, activityPath);
    const normalized = wrapped('graph.png');
    assert.equal(normalized.status, 'resolved');
    if (normalized.status === 'resolved') assert.strictEqual(normalized.resource.entry, one);
    const duplicate = createTakeoutResourceResolver({
        [path('images/graph.png')]: one, [path('other/graph.png')]: two,
    }, activityPath);
    assert.equal(duplicate('graph.png').status, 'ambiguous');
    assert.equal(duplicate('unobserved.png').status, 'missing');
});

test('percent-encoded Takeout reference selects the literal archive filename without renaming its source identity', () => {
    const original = entry(Uint8Array.of(77));
    const resolve = createTakeoutResourceResolver({ [path('image name.png')]: original }, activityPath);
    const match = resolve('image%20name.png');
    assert.equal(match.status, 'resolved');
    if (match.status === 'resolved') {
        assert.strictEqual(match.resource.entry, original);
        assert.equal(match.resource.path, path('image name.png'));
    }
});

test('L1 Takeout -> L2/L3a -> Application resource preparation -> L3b/L4 preserves exact archive bytes', async t => {
    const id = 'takeout-byte-01', raw = Uint8Array.of(137, 80, 78, 71, 10, 21, 32);
    const archivePath = path('archive-0.png');
    const archive = takeoutArchive(imageActivity(id, 'archive-0.png', true), {
        [archivePath]: entry(raw) as { async: (type: string) => Promise<unknown>; _data: { uncompressedSize: number } },
    });
    const resources = createSourceResourceContext();
    t.after(() => resources.release());
    const result = await importTakeout(archive, account.id, undefined, resources);
    assert.equal(result.imported, 1);
    assert.equal(result.status, 'partial', 'Takeout cannot certify complete conversation history');
    const conversation = await readConversation(key(id));
    assert.ok(conversation);
    assert.equal(conversation.detail.quality.status, 'partial');
    const media = conversation.detail.assets.find(item => item.kind === 'image');
    assert.ok(media);
    const retained = await resources.acquire(key(id), media);
    assert.deepEqual(retained.bytes, raw, 'Task resource reader must return original ZIP bytes');

    const document = composeDomainDocument(conversation, account);
    const required = collectDocumentResources(document);
    assert.ok(required.referencedIds.has(media.id));
    const prepared = await prepareExportResources(conversation.detail.assets, required.referencedIds,
        (asset, signal) => resources.acquire(key(id), asset, signal));
    const selected = prepared.get(media.id);
    assert.ok(selected?.ok);
    assert.deepEqual(selected.value.bytes, raw);
    const [plan] = planExportPaths([{ conversation, prepared, fileIds: required.fileIds }], 'markdown');
    const markdown = renderDocumentMarkdown(document, plan.resources);
    const packaged = buildExportFiles('markdown', plan, markdown, prepared);
    const binary = packaged.find(file => file.fileName === plan.resources[media.id]);
    assert.ok(binary);
    assert.deepEqual(binary.content, raw);
    assert.match(binary.fileName, /^assets\//);
    assert.ok(markdown.includes(binary.fileName));
    assert.notEqual(binary.fileName, media.sourceUri, 'L4 destination is not a source identity');
    assert.ok(!JSON.stringify(conversation.detail).includes('dataBase64'));
    assert.ok(!JSON.stringify(conversation.detail).includes('_data'));
    assert.ok(!JSON.stringify(conversation.detail).includes('archiveResources'));
    resources.release();
    await assert.rejects(resources.acquire(key(id), media), /Resource context released/);
});

test('rejected or empty Takeout ZIP bytes remain partial and never produce a fabricated image sidecar', async t => {
    const id = 'takeout-empty-02', uri = 'missing-data.png';
    const archive = takeoutArchive(imageActivity(id, uri), { [path(uri)]: entry(new Uint8Array()) as {
        async: (type: string) => Promise<unknown>; _data: { uncompressedSize: number };
    } });
    const resources = createSourceResourceContext();
    t.after(() => resources.release());
    assert.equal((await importTakeout(archive, account.id, undefined, resources)).imported, 1);
    const conversation = await readConversation(key(id));
    assert.ok(conversation);
    const document = composeDomainDocument(conversation, account);
    const refs = collectDocumentResources(document);
    assert.ok(refs.referencedIds.size > 0);
    const prepared = await prepareExportResources(conversation.detail.assets, refs.referencedIds,
        (asset, signal) => resources.acquire(key(id), asset, signal));
    assert.ok([...prepared.values()].some(value => !value.ok));
    const [plan] = planExportPaths([{ conversation, prepared, fileIds: refs.fileIds }], 'markdown');
    const markdown = renderDocumentMarkdown(document, plan.resources);
    const artifacts = buildExportFiles('markdown', plan, markdown, prepared);
    assert.equal(artifacts.length, 1, 'no unverified ZIP bytes can become a sidecar');
    assert.match(markdown, /Takeout answer/);
    assert.doesNotMatch(markdown, /\]\(assets\/[^)]*missing-data\.png\)/);
});

test('Takeout parser binds explicitly referenced generated media, not a guessed generation sibling', () => {
    const id = 'takeout-generated-03', first = path('first.png'), sibling = path('second.png');
    const html = imageActivity(id, 'first.png', true);
    const parsed = parseGeminiTakeoutConversation({
        htmlText: html, activityPath,
        archiveFiles: files({ [first]: Uint8Array.of(1), [sibling]: Uint8Array.of(2) }),
    }, { providerId: 'gemini', account });
    const selected = parsed.conversation.detail.assets.filter(asset => asset.kind === 'image');
    assert.equal(selected.length, 1);
    assert.equal(Object.keys(parsed.archiveResources).length, 1);
    assert.equal(Object.values(parsed.archiveResources)[0].path, first);
    assert.equal(selected[0].generation?.imageCount, 1);
    assert.equal(selected[0].generation?.imageOrdinal, 0);
});
