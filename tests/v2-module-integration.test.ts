import { restoreDomainDetail } from '../src/l2/runtimeValidation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { sourceDetail, sourceList } from './helpers/l1SourceFixture.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { ingestIndexes, ingestDetail } from '../src/l2/ingestion.js';
import { listIndexes as getConversations } from '../src/l3a/storageService.js';
import { getDetail } from '../src/l3a/storageService.js';
import { getAccount } from '../src/runtime/api/accountRegistry.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
import { serializeDomainJson } from '../src/l4/format/json/serializeDomainJson.js';
import { planExportPaths, buildExportFiles, packageExportFiles } from '../src/l4/packaging/index.js';
import type { PreparedResources } from '../src/shared/resources/resourceResult.js';
import { __setZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';
const JSZip = require('../lib/jszip.min.js');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('L1 → L2 → Composer → Format → Packaging keeps account, resource identities and physical bytes aligned', async () => {
    const env = indexStorage(), context = createSourceResourceContext();
    try {
        const account = fixtureAccount(), id = 'source_chat_123', key = { accountId: account.id, conversationId: id };
        // Real source parser; the source evidence never has an account-bound key.
        const parsed = sourceDetail();
        parsed.conversation.detail.assets = [{ id: 'diagram', kind: 'image', name: 'Diagram.png', mediaType: 'image/png' }];
        parsed.conversation.detail.messages[0].content.push({ type: 'image', assetId: 'diagram' });
        parsed.acquisitionHints = { diagram: { dataBase64: png } };
        parsed.conversation.detail.quality.status = 'complete';
        assert.ok(!('key' in parsed.conversation.index));
        assert.ok(!('key' in parsed.conversation.detail));
        const provider = new GeminiProvider({ getConversationList: async () => sourceList('G_SOURCE_CHAT_01'), getConversationDetail: async () => parsed }, async () => 'u0', context);
        await provider.listConversations({ accountId: account.id, streamId: 'recent', onPageCommitted: async () => {
            assert.ok((await getConversations(account.id)).some(row => row.key.conversationId === id), 'callback observes committed L2 indexes');
            return false;
        } });
        assert.equal(await getDetail(key), null, 'Index discovery cannot invent Detail');
        assert.equal(await provider.fetchConversationDetail(account.id, id), undefined, 'L1 awaits admission and returns void');
        const index = (await getConversations(account.id)).find(row => row.key.conversationId === id)!;
        const detail = await getDetail(key), committedAccount = await getAccount(account.id);
        assert.ok(detail && committedAccount);
        const domain = { index, detail: restoreDomainDetail(detail) }, before = structuredClone(domain);
        const document = composeDomainDocument(domain, committedAccount), astBefore = structuredClone(document);
        assert.deepEqual([...collectDocumentResources(document).referencedIds], ['diagram']);
        const acquired = await provider.acquireResource(key, detail.assets[0]);
        assert.deepEqual(acquired.bytes, Uint8Array.from(atob(png), c => c.charCodeAt(0)));
        const prepared: PreparedResources = new Map([['diagram', { ok: true, resourceId: 'diagram', value: acquired }]]);
        __setZipConstructor(JSZip);
        for (const format of ['markdown', 'html', 'json'] as const) {
            const [plan] = planExportPaths([{ conversation: domain, prepared, fileIds: format === 'json' ? new Set<string>() : collectDocumentResources(document).fileIds }], format);
            const content: string = format === 'markdown' ? renderDocumentMarkdown(document, plan.resources)
                : format === 'html' ? renderDocumentHtml(document, plan.resources).html
                : serializeDomainJson(domain, committedAccount, plan.resources);
            assert.ok(content.includes(plan.resources.diagram));
            const files = buildExportFiles(format, plan, content, prepared);
            const [artifact] = await packageExportFiles([files], 'browserDownload');
            const zip = await JSZip.loadAsync(await (artifact.content as Blob).arrayBuffer());
            assert.equal(await zip.file(plan.fileName).async('string'), content);
            assert.deepEqual(await zip.file(plan.resources.diagram).async('uint8array'), acquired.bytes);
        }
        assert.ok(JSON.stringify(renderDocumentTypst(document, { diagram: 'assets/diagram.png' })).includes('assets/diagram.png'));
        assert.deepEqual(domain, before);
        assert.deepEqual(document, astBefore);
        assert.ok(!JSON.stringify(domain).includes(png), 'acquisition hints never persist in Domain');
        const otherKey = { ...key, accountId: '10000000-0000-4000-8000-000000000002' };
        await ingestIndexes(otherKey.accountId, [{ conversationId: id, fields: { title: 'Other account', titleSource: 'provider' } }]);
        assert.equal(await getDetail(otherKey), null);
        await assert.rejects(provider.acquireResource(otherKey, detail.assets[0]), /No supported source locator/);
        await ingestDetail(account.id, id, { ...parsed.conversation.detail, quality: { status: 'partial' }, messages: [] });
        assert.deepEqual(await getDetail(key), detail, 'incomplete capture cannot replace complete body');
        context.release();
        await assert.rejects(provider.acquireResource(key, detail.assets[0]), /released/);
    } finally { context.release(); env.restore(); }
});
