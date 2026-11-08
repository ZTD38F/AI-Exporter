import { OperationError } from '../src/shared/errors/operationError.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureAccountFor, fixtureKey } from './helpers/domainFixture.js';
import { resourceValue } from './helpers/resources.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import type { DomainAsset } from '../src/l2/conversationDetail.js';
import type { SourceConversationParseResult } from '../src/l1/parsers/parsingResult.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';
import { prepareExportResources } from '../src/application/export/prepareExportResources.js';

const url = 'https://example.test/shared-image';
const firstBytes = new Uint8Array([11, 22, 33]);
const secondBytes = new Uint8Array([44, 55, 66]);

/** V2 identities and durable locators are L2 facts; network hints/bytes are not. */
function conversation() {
    const key = fixtureKey('resource-boundary');
    const assets: DomainAsset[] = [
        { id: 'image-request-one', kind: 'image', name: 'same.png', mediaType: 'image/png',
            sourceUri: url, generation: { providerRequestId: 'request-one', imageOrdinal: 0 } },
        { id: 'image-request-two', kind: 'image', name: 'same.png', mediaType: 'image/png',
            sourceUri: url, generation: { providerRequestId: 'request-two', imageOrdinal: 0 } },
    ];
    return validateParserDomain({
        index: { key, title: 'Boundary', titleSource: 'provider' },
        detail: { key, quality: { status: 'complete' }, assets, messages: [
            { role: 'assistant', content: [{ type: 'image', assetId: assets[0].id }] },
            { role: 'assistant', content: [{ type: 'image', assetId: assets[1].id }] },
        ] },
    });
}

test('same source URL with distinct generation identities is acquired once per v2 Asset ID', async () => {
    const domain = conversation();
    const original = structuredClone(domain);
    const ids = domain.detail.assets.map(asset => asset.id);
    const document = composeDomainDocument(domain, fixtureAccountFor(domain));
    const references = collectDocumentResources(document);
    assert.deepEqual([...references.imageIds], ids);
    assert.deepEqual([...references.referencedIds], ids);

    const calls: string[] = [];
    const prepared = await prepareExportResources(domain.detail.assets, references.referencedIds, async asset => {
        calls.push(asset.id);
        assert.equal(asset.sourceUri, url);
        assert.equal(asset.name, 'same.png', 'the shared export name is not the acquisition key');
        assert.equal(asset.generation?.providerRequestId, asset.id === ids[0] ? 'request-one' : 'request-two');
        return { bytes: asset.id === ids[0] ? firstBytes : secondBytes };
    });

    assert.deepEqual(calls, ids);
    assert.deepEqual(resourceValue(prepared.get(ids[0])).bytes, firstBytes);
    assert.deepEqual(resourceValue(prepared.get(ids[1])).bytes, secondBytes);
    assert.equal(resourceValue(prepared.get(ids[0])).mediaType, 'image/png', 'v2 preparation retains trusted MIME metadata');
    assert.deepEqual(domain, original);
    assert.deepEqual(composeDomainDocument(domain, fixtureAccountFor(domain)), document);
});

test('prepared bytes and acquisition failures stay outside Domain and Document AST', async () => {
    const domain = conversation();
    const json = JSON.stringify(domain);
    const document = composeDomainDocument(domain, fixtureAccountFor(domain));
    const astJson = JSON.stringify(document);
    const ids = collectDocumentResources(document).referencedIds;
    let acquisitions = 0;

    for (const success of [true, false]) {
        const prepared = await prepareExportResources(domain.detail.assets, ids, async asset => {
            acquisitions++;
            if (!success) throw new Error('HTTP 404 for ' + asset.id);
            return { bytes: firstBytes, mediaType: 'image/png' };
        });
        assert.equal(prepared.size, ids.size, 'each referenced image retains its acquisition outcome');
        for (const [id, outcome] of prepared) {
            if (success) {
                assert.deepEqual(resourceValue(outcome).bytes, firstBytes);
            } else {
                assert.equal(outcome.ok, false, 'failure must not become a successful blank image');
                if (!outcome.ok) {
                    assert.equal(outcome.resourceId, id);
                    assert.equal(outcome.code, 'RESOURCE_UNAVAILABLE');
                    assert.match(outcome.reason, /HTTP 404/);
                }
            }
        }
        assert.equal(JSON.stringify(domain), json);
        assert.equal(JSON.stringify(document), astJson);
        assert.equal(JSON.stringify(composeDomainDocument(domain, fixtureAccountFor(domain))), astJson);
        assert.ok(!json.includes('dataBase64') && !json.includes('failureReason'));
        assert.ok(!astJson.includes('dataBase64') && !astJson.includes('RESOURCE_UNAVAILABLE'));
    }

    const none = await prepareExportResources(domain.detail.assets, new Set<string>(), async () => {
        assert.fail('includeAssets=false must not acquire any bytes');
    });
    assert.equal(none.size, 0);
    assert.equal(acquisitions, ids.size * 2);
    const restored = validateParserDomain(JSON.parse(json));
    assert.deepEqual(composeDomainDocument(restored, fixtureAccountFor(restored)), document);
});

test('inline source bytes are reusable in the same task but never persisted in v2 Domain JSON', async () => {
    const domain = conversation();
    const asset = domain.detail.assets[0];
    const key = domain.index.key;
    const { key: _detailKey, ...detail } = domain.detail;
    const inline = Buffer.from(firstBytes).toString('base64');
    const parsed: SourceConversationParseResult = {
        conversationId: key.conversationId,
        conversation: { index: {}, detail },
        acquisitionHints: { [asset.id]: { dataBase64: inline } },
        diagnostics: [],
    };
    const json = JSON.stringify(domain);
    assert.ok(!json.includes(inline));
    assert.ok(!json.includes('dataBase64'));

    const resources = createSourceResourceContext();
    try {
        // This is the L1 side channel retained only after the Detail candidate is accepted.
        resources.retainParsed(key, parsed);
        const prepared = await prepareExportResources(domain.detail.assets, new Set([asset.id]),
            item => resources.acquire(key, item, undefined, async () => {
                assert.fail('same-task inline bytes must not require a remote fetch');
            }));
        assert.deepEqual(resourceValue(prepared.get(asset.id)).bytes, firstBytes);
        assert.equal(JSON.stringify(domain), json);
        assert.deepEqual(composeDomainDocument(validateParserDomain(JSON.parse(json)), fixtureAccountFor(domain)),
            composeDomainDocument(domain, fixtureAccountFor(domain)));
    } finally {
        resources.release();
    }
    await assert.rejects(resources.acquire(key, asset), /Resource context released/);
});

import { ResourceHttpError, attemptResource, resourceIssueKind, resourceFailureText } from '../src/shared/resources/resourceResult.js';
import { acquireSourceResource } from '../src/l1/resources/sourceResources.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentTypstCore } from '../src/l4/format/typst/renderTypstCore.js';

test('actual attachment response status distinguishes unavailable, restricted and retryable resources', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    for (const [status, kind] of [[404, 'expired'], [410, 'expired'], [401, 'restricted'], [403, 'restricted'], [429, 'download'], [500, 'download']] as const) {
        globalThis.fetch = async () => new Response('', {status});
        const failure = await attemptResource('asset', () => acquireSourceResource({id:'asset',kind:'image',sourceUri:'https://example.test/photo'}));
        assert.equal(failure.ok, false);
        if (failure.ok) continue;
        assert.equal(failure.httpStatus, status);
        assert.equal(resourceIssueKind(failure), kind);
        assert.match(resourceFailureText(failure, 'zh'), new RegExp(`HTTP ${status}`));
    }
    for (const error of [new TypeError('Failed to fetch'), new Error('HTTP 404 mentioned in unrelated text')]) {
        const failure = await attemptResource('asset', async () => { throw error; });
        assert.ok(!failure.ok);
        assert.equal(resourceIssueKind(failure), 'unknown', 'never infer expiry or download cause from an error message');
    }
    const abort = new AbortController(); abort.abort();
    await assert.rejects(attemptResource('asset', async () => { throw new ResourceHttpError(404); }, abort.signal), {name:'AbortError'});
});

test('Markdown, HTML and PDF payload preserve the actual missing attachment reason and name', async () => {
    const domain = conversation();
    const document = composeDomainDocument(domain, fixtureAccountFor(domain));
    const prepared = await prepareExportResources(domain.detail.assets, collectDocumentResources(document).referencedIds,
        async () => { throw new ResourceHttpError(404); });
    const resourceFailures = Object.fromEntries([...prepared].filter((entry): entry is [string, import('../src/shared/resources/resourceResult.js').ResourceFailure] => !entry[1].ok));
    const options = {locale:'zh' as const, resourceFailures};
    const markdown = renderDocumentMarkdown(document, {}, options);
    const html = renderDocumentHtml(document, {}, options).html;
    const typst = JSON.stringify(renderDocumentTypstCore(document, {}, options));
    for (const output of [markdown, html, typst]) {
        assert.match(output, /来源附件无法获取/);
        assert.match(output, /HTTP 404/);
        assert.match(output, /same\.png/);
        assert.doesNotMatch(output, /<img[^>]+src="https:\/\/example\.test\/shared-image|!\[[^\]]*\]\(https:\/\/example\.test\/shared-image/);
        assert.match(output, /https:\/\/example\.test\/shared-image/);
    }
});

import { exportSummary } from '../src/ui/shared/exportSummary.js';
test('delivery summary separates unavailable source attachments from retryable failures', () => {
    const base = {exported:2,skipped:0,partial:2,failed:[],aborted:false,expiredConversations:2,otherPartial:0};
    const summary = exportSummary({...base, attachmentIssues:[
        {resourceId:'one',name:'one.png',code:'RESOURCE_SOURCE_EXPIRED',httpStatus:404},
        {resourceId:'two',name:'two.png',code:'RESOURCE_SOURCE_EXPIRED',httpStatus:410},
        {resourceId:'three',name:'three.png',code:'RESOURCE_DOWNLOAD_FAILED',httpStatus:503},
    ]}, true);
    assert.match(summary, /2 conversations contain unavailable source attachments \(2 attachments\)/);
    assert.match(summary, /Attachment download failed: 1; retry later/);
    assert.doesNotMatch(summary, /Conversation export failed:/);
    assert.doesNotMatch(summary, /Other incomplete/);
});

test('ChatGPT attachment API HTTP failures retain status and a useful summary', async () => {
    for (const status of [403, 404, 503]) {
        const result = await attemptResource('upload', async () => {
            throw new OperationError('RESOURCE_LOCATOR_UNAVAILABLE', `File exchange HTTP ${status}`, status);
        });
        assert.equal(result.ok, false);
        if (result.ok) throw new Error('Expected resource failure');
        assert.equal(result.httpStatus, status);
        assert.equal(resourceIssueKind(result), status === 404 ? 'expired' : status === 403 ? 'restricted' : 'download');
        assert.match(resourceFailureText(result, 'zh'), new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(resourceFailureText(result, 'zh'), /未知/);
    }
});
