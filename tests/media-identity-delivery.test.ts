/**
 * V2 integration regression: real L1 Gemini RPC / Takeout source facts, L2
 * snapshot selection, task-owned source bytes, Application resource preparation,
 * L3b composition and L4 packaging/delivery. An export never resurrects the
 * removed AssetPipeline or a persistent, cross-source Takeout media cache.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mediaSources, mediaChatId, mediaPrompt, mediaBytes } from './helpers/mediaSourceFixture.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { v2ExportHost } from './helpers/v2ExportHost.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { readConversation } from '../src/l2/readConversation.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { readTakeoutBytes } from '../src/l1/imports/takeout/readArchive.js';
import type { GeminiTakeoutParseResult } from '../src/l1/parsers/gemini/takeout/parseConversation.js';
import { prepareExportResources } from '../src/application/export/prepareExportResources.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { serializeDomainJson } from '../src/l4/format/json/serializeDomainJson.js';
import { planExportPaths, buildExportFiles, packageExportFiles } from '../src/l4/packaging/index.js';
import { startBrowserDownload } from '../src/l4/delivery/index.js';
import { __setZipConstructor, __getZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';

const account = fixtureAccount('gemini');
const key = { accountId: account.id, conversationId: mediaChatId };
const JSZip = require('../lib/jszip.min.js');

function useZip(t: TestContext): void {
    const previous = __getZipConstructor();
    __setZipConstructor(JSZip);
    t.after(() => __setZipConstructor(previous));
}

for (const [label, options] of [
    ['single generated image', {}],
    ['missing online generation time', { noTime: true }],
    ['missing online prompt', { noPrompt: true }],
    ['multiple generated images', { multi: true }],
    ['duplicate generation activity', { duplicate: true }],
] as const) {
    test('Takeout ' + label + ': source-bound bytes survive real v2 Markdown ZIP delivery', async t => {
        const host = v2ExportHost(t);
        useZip(t);
        const { online, offline } = mediaSources(options);
        const takeout = offline as GeminiTakeoutParseResult;
        const context = createSourceResourceContext();
        t.after(() => context.release());

        // The online source has different image identities/locators. They must
        // never be used to guess the ownership of the Takeout archive entries.
        const onlineIds = new Set(online.conversation.detail.assets.map(asset => asset.id));
        const admitted = await ingestDetail(key.accountId, key.conversationId,
            offline.conversation.detail, offline.conversation.index);
        assert.equal(admitted.accepted, true);
        context.retainParsed(key, offline);
        for (const [assetId, bound] of Object.entries(takeout.archiveResources)) {
            context.retain(key, assetId, async () => {
                const bytes = await readTakeoutBytes(bound.entry);
                if (!bytes) throw new Error('Empty Takeout entry');
                return { bytes };
            });
        }

        const stored = await readConversation(key);
        assert.ok(stored);
        assert.equal('archiveResources' in stored.detail, false);
        assert.equal('acquisitionHints' in stored.detail, false);
        const document = composeDomainDocument(stored, account);
        const refs = collectDocumentResources(document);
        const prepared = await prepareExportResources(stored.detail.assets, refs.referencedIds,
            (asset, signal) => context.acquire(key, asset, signal));
        const [plan] = planExportPaths([{ conversation: stored, prepared, fileIds: refs.fileIds }], 'markdown');
        const markdown = renderDocumentMarkdown(document, plan.resources);
        const files = buildExportFiles('markdown', plan, markdown, prepared);
        const delivered = await packageExportFiles([files], 'browserDownload');
        assert.equal(delivered.length, 1);
        await startBrowserDownload(delivered[0]);
        assert.equal(host.clicks(), 1);
        assert.match(host.filenames[0], /\.zip$/);

        const zip = await JSZip.loadAsync(await host.blobs[0].arrayBuffer());
        const body = zip.file(plan.fileName);
        assert.ok(body);
        assert.equal(await body.async('string'), markdown);

        const referencedArchive = Object.entries(takeout.archiveResources)
            .filter(([assetId]) => refs.referencedIds.has(assetId));
        assert.ok(referencedArchive.length > 0, 'at least one explicitly owned ZIP image remains referenced');
        for (const [assetId, bound] of referencedArchive) {
            assert.equal(onlineIds.has(assetId), false, 'no cross-source asset identity is guessed');
            assert.equal(prepared.get(assetId)?.ok, true);
            const destination = plan.resources[assetId];
            assert.ok(destination?.startsWith('assets/'));
            const entry = zip.file(destination);
            assert.ok(entry, 'the L4 path must be an actual delivered ZIP member');
            assert.deepEqual(await entry.async('uint8array'), await readTakeoutBytes(bound.entry));
            assert.ok(markdown.includes(destination), 'AST references the delivered path');
        }

        const generated = offline.conversation.detail.assets.find(asset => asset.generation?.prompt === mediaPrompt);
        assert.ok(generated);
        const source = takeout.archiveResources[generated.id];
        assert.ok(source);
        assert.match(source.path, /archive-0\.png$/);
        const matchingMember = zip.file(plan.resources[generated.id]);
        assert.ok(matchingMember);
        assert.deepEqual(await matchingMember.async('uint8array'), mediaBytes);
    });
}

test('a rejected Takeout snapshot cannot replace online Domain bytes or supply export sidecars', async t => {
    const host = v2ExportHost(t);
    useZip(t);
    const { online, offline } = mediaSources();
    const context = createSourceResourceContext();
    t.after(() => context.release());
    const first = await ingestDetail(key.accountId, key.conversationId,
        online.conversation.detail, online.conversation.index);
    assert.equal(first.accepted, true);
    context.retainParsed(key, online);

    // L2 selects complete online Detail instead of the partial Takeout
    // candidate. Only an accepted candidate may update this task's readers.
    const rejected = await ingestDetail(key.accountId, key.conversationId,
        offline.conversation.detail, offline.conversation.index);
    assert.equal(rejected.accepted, false);
    const stored = await readConversation(key);
    assert.ok(stored);
    const asset = stored.detail.assets[0];
    assert.ok(asset);
    assert.equal(asset.id, online.conversation.detail.assets[0].id);
    assert.equal(offline.conversation.detail.assets.some(item => item.id === asset.id), false);

    const onlineBytes = Uint8Array.of(12, 34, 56);
    const previousFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        urls.push(url);
        assert.equal(url, asset.sourceUri);
        return new Response(new Uint8Array(onlineBytes) as BodyInit,
            { status: 200, headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    t.after(() => { globalThis.fetch = previousFetch; });

    const prepared = await prepareExportResources(stored.detail.assets, new Set([asset.id]),
        (candidate, signal) => context.acquire(key, candidate, signal));
    assert.equal(prepared.get(asset.id)?.ok, true);
    const [plan] = planExportPaths([{ conversation: stored, prepared, fileIds: new Set<string>() }], 'json');
    const content = serializeDomainJson(stored, account, plan.resources);
    const files = buildExportFiles('json', plan, content, prepared);
    const delivered = await packageExportFiles([files], 'browserDownload');
    await startBrowserDownload(delivered[0]);
    assert.equal(host.clicks(), 1);
    assert.deepEqual(urls, [asset.sourceUri]);
    assert.equal(JSON.parse(content).resources[asset.id], plan.resources[asset.id]);
    const zip = await JSZip.loadAsync(await host.blobs[0].arrayBuffer());
    const bundled = zip.file(plan.resources[asset.id]);
    assert.ok(bundled);
    assert.deepEqual(await bundled.async('uint8array'), onlineBytes);
    assert.notDeepEqual(await bundled.async('uint8array'), mediaBytes);
});
