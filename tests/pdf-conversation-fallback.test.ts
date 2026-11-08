/**
 * V2 PDF/Export source fallback contract.
 *
 * Source selection is L2 Detail admission; Export fetches via L1 and then
 * rereads the committed Domain. PDF consumes the same L3b AST as other
 * reading formats, with no private Takeout/cache resolver or PDF item stage.
 * Only the external Provider and browser download/PDF compiler host are faked.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureAccount } from './helpers/domainFixture.js';
import { v2ExportHost } from './helpers/v2ExportHost.js';
import { ingestDetail, ingestIndexes } from '../src/l2/ingestion.js';
import { readConversation } from '../src/l2/readConversation.js';
import type { ConversationDetail } from '../src/l2/conversationDetail.js';
import { getExportRecord } from '../src/l3a/storageService.js';
import { runExport } from '../src/application/export/runExport.js';
import type { ExportRequest } from '../src/application/export/types.js';
import { updateSettings } from '../src/application/settings/index.js';
import { ProviderRegistry } from '../src/l1/client/providerRegistry.js';
import type { AIProvider } from '../src/l1/client/aiProvider.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
import { compileDocumentPdf } from '../src/l4/format/pdf/compileDocumentPdf.js';
import type { IPdfCompiler } from '../src/l4/format/pdf/pdfCompiler.js';
import { buildMinimalValidPdf } from './helpers/stubPdfCompiler.js';

const account = fixtureAccount('custom');
const sourceTime = 1_700_000_000_000;
const key = (conversationId: string) => ({ accountId: account.id, conversationId });
const request = (id: string, changes: Partial<ExportRequest> = {}): ExportRequest => ({
    keys: [key(id)], format: 'markdown', delivery: 'browserDownload',
    includeAssets: false, skipUnchanged: false, ...changes,
});
const paragraph = (text: string) => ({
    type: 'paragraph' as const, children: [{ type: 'text' as const, text }],
});
function detail(text: string | null, savedAt: number, quality: 'complete' | 'partial' | 'unknown' = 'complete'):
    Omit<ConversationDetail, 'key'> {
    return { savedAt, quality: { status: quality }, assets: [],
        messages: text === null ? [] : [{ role: 'assistant', content: [paragraph(text)] }] };
}
async function seed(id: string, text: string | null, opts: {
    savedAt?: number; updatedAt?: number; quality?: 'complete' | 'partial' | 'unknown';
    title?: string; titleSource?: 'provider' | 'derived' | 'user';
} = {}) {
    const savedAt = opts.savedAt ?? sourceTime;
    return ingestDetail(account.id, id, detail(text, savedAt, opts.quality ?? 'complete'), {
        title: opts.title ?? 'PDF ' + id, titleSource: opts.titleSource ?? 'provider',
        updatedAt: opts.updatedAt ?? savedAt,
    });
}
async function host(t: TestContext) {
    const browser = v2ExportHost(t);
    await updateSettings({ language: 'en' });
    return browser;
}
/** L1 test seam: the Provider must commit through L2, returning no Domain DTO. */
function provider(t: TestContext, fetchDetail: AIProvider['fetchConversationDetail']) {
    const prior = ProviderRegistry.get(account.providerId);
    const fake: AIProvider = {
        id: account.providerId, name: 'PDF source fallback fixture', hostPatterns: [],
        matchesUrl: () => false, checkReadiness: async () => ({ ready: true }),
        listConversations: async () => 'source_end',
        fetchConversationDetail: fetchDetail,
        acquireResource: async () => { throw new Error('Unexpected resource request'); },
    };
    ProviderRegistry.register(fake);
    t.after(() => {
        ProviderRegistry.unregister(account.providerId);
        if (prior) ProviderRegistry.register(prior);
    });
}
async function pdfProjection(id: string) {
    const conversation = await readConversation(key(id));
    assert.ok(conversation, 'L2 must have a committed Detail to compose PDF');
    const document = composeDomainDocument(conversation, account);
    return { conversation, document, typst: renderDocumentTypst(document, {}) };
}

test('a complete Takeout Detail survives a later empty partial online candidate; PDF uses the selected L2 body', async t => {
    const browser = await host(t);
    const id = 'takeout-complete';
    await seed(id, 'Recovered Takeout', { savedAt: sourceTime });
    const competing = await ingestDetail(account.id, id,
        detail(null, sourceTime + 100, 'partial'), {
            title: 'Partial online response', titleSource: 'derived', updatedAt: sourceTime,
        });
    assert.deepEqual(competing, { accepted: false, changed: false },
        'message count alone is not a PDF-specific source-selection rule; L2 retains complete content');
    provider(t, async () => assert.fail('fresh committed Detail must not trigger a second source fetch'));

    const { conversation, document, typst } = await pdfProjection(id);
    assert.equal(conversation.detail.savedAt, sourceTime);
    assert.equal(conversation.detail.quality.status, 'complete');
    assert.equal(conversation.index.title, 'PDF ' + id);
    assert.match(JSON.stringify(typst.messages), /Recovered Takeout/);
    assert.equal(typst.messages.length, 1);
    assert.equal('resolvedSource' in conversation.detail, false, 'transient Takeout provenance is not durable Domain');

    let compiles = 0;
    const compiler: IPdfCompiler = {
        name: 'capture-final-pdf-input',
        async compile(payload) {
            compiles++;
            assert.match(JSON.stringify(payload.document.messages), /Recovered Takeout/);
            assert.doesNotMatch(JSON.stringify(payload.document.messages), /Partial online response/);
            assert.equal(payload.assetPaths.size, 0);
            return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
        },
    };
    const pdf = await compileDocumentPdf(document, {}, new Map(), compiler, {
        signal: new AbortController().signal, reportProgress() {},
    });
    assert.equal(compiles, 1);
    assert.equal(new TextDecoder().decode(pdf.pdfBytes.subarray(0, 5)), '%PDF-');

    const result = await runExport(request(id));
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
    assert.equal(browser.clicks(), 1);
    assert.match(await browser.blobs[0].text(), /Recovered Takeout/);
    assert.equal((await getExportRecord(key(id)))?.chatTime, sourceTime);
});

test('new complete online Detail replaces an older partial Takeout snapshot for all reading formats', async t => {
    const browser = await host(t);
    const id = 'online-complete';
    await seed(id, 'Incomplete Takeout body', { quality: 'partial', savedAt: sourceTime });
    const result = await seed(id, 'Authoritative online body', {
        quality: 'complete', savedAt: sourceTime + 100,
    });
    assert.deepEqual(result, { accepted: true, changed: true });
    provider(t, async () => assert.fail('fresh online Detail must be reused without another fetch'));

    const { conversation, typst } = await pdfProjection(id);
    assert.equal(conversation.detail.quality.status, 'complete');
    assert.equal(conversation.detail.savedAt, sourceTime + 100);
    assert.match(JSON.stringify(typst.messages), /Authoritative online body/);
    assert.doesNotMatch(JSON.stringify(typst.messages), /Incomplete Takeout body/);

    const delivered = await runExport(request(id));
    assert.equal(delivered.exported, 1);
    assert.equal(delivered.partial, 0);
    assert.match(await browser.blobs[0].text(), /Authoritative online body/);
    assert.doesNotMatch(await browser.blobs[0].text(), /Incomplete Takeout body/);
    assert.equal((await getExportRecord(key(id)))?.chatTime, sourceTime + 100);
});

test('an Index-only selection fetches L1 Detail, then rereads its committed content and authoritative title', async t => {
    const browser = await host(t);
    const id = 'metadata-only';
    await ingestIndexes(account.id, [{
        conversationId: id,
        fields: { title: 'Selection metadata', titleSource: 'derived', updatedAt: sourceTime },
    }]);
    assert.equal(await readConversation(key(id)), null, 'Index-only must not be treated as an empty body');
    const calls: string[] = [];
    provider(t, async (accountId, conversationId) => {
        assert.equal(accountId, account.id);
        assert.equal(conversationId, id);
        calls.push(conversationId);
        await ingestDetail(accountId, conversationId,
            detail('Fetched PDF detail payload', sourceTime), {
                title: 'Authoritative Title', titleSource: 'provider', updatedAt: sourceTime,
            });
    });

    const result = await runExport(request(id));
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(calls, [id], 'L1 returns void; Export reads L2 again after admission');
    assert.match(await browser.blobs[0].text(), /Fetched PDF detail payload/);
    assert.match(await browser.blobs[0].text(), /Authoritative Title/);

    const { conversation, document, typst } = await pdfProjection(id);
    assert.equal(conversation.index.title, 'Authoritative Title');
    assert.equal(document.title, 'Authoritative Title');
    assert.match(JSON.stringify(typst.messages), /Fetched PDF detail payload/);
    assert.equal((await getExportRecord(key(id)))?.status, 'ok');
});

test('transient L1 refresh failure retains an older local Detail as partial and never promotes its version', async t => {
    const browser = await host(t);
    const id = 'offline-with-local';
    await seed(id, 'Saved local PDF body', { savedAt: sourceTime });
    await ingestIndexes(account.id, [{
        conversationId: id, fields: { updatedAt: sourceTime + 100 },
    }]);
    let attempts = 0;
    provider(t, async () => { attempts++; throw new Error('HTTP 503: transient'); });

    const original = await readConversation(key(id));
    const first = await runExport(request(id));
    assert.deepEqual({ exported: first.exported, partial: first.partial, failed: first.failed },
        { exported: 1, partial: 1, failed: [] });
    assert.equal(attempts, 1);
    assert.match(await browser.blobs[0].text(), /Saved local PDF body/);
    assert.deepEqual(await readConversation(key(id)), original, 'refresh failure does not rewrite the selected Domain');
    assert.equal((await getExportRecord(key(id)))?.chatTime, sourceTime);
    assert.equal((await getExportRecord(key(id)))?.status, 'partial');

    const { typst } = await pdfProjection(id);
    assert.match(JSON.stringify(typst.messages), /Saved local PDF body/);
    const retry = await runExport(request(id, { skipUnchanged: true }));
    assert.equal(retry.skipped, 0, 'partial fallback cannot be skipped next time');
    assert.equal(retry.partial, 1);
    assert.equal(attempts, 2);
    assert.equal(browser.clicks(), 2);
});

test('missing Detail fails; an explicitly accepted empty Detail is not a fabricated PDF_NO_MESSAGES error', async t => {
    const browser = await host(t);
    const id = 'empty-valid';
    await ingestIndexes(account.id, [{
        conversationId: id, fields: { title: 'Empty but valid', titleSource: 'provider', updatedAt: sourceTime },
    }]);
    let attempts = 0;
    provider(t, async () => { attempts++; /* no Detail was admitted */ });

    const missing = await runExport(request(id));
    assert.equal(missing.exported, 0);
    assert.deepEqual(missing.failed, [key(id)]);
    assert.equal(browser.clicks(), 0);
    assert.equal(await getExportRecord(key(id)), null);

    await ingestDetail(account.id, id, detail(null, sourceTime, 'complete'));
    const { conversation, document, typst } = await pdfProjection(id);
    assert.deepEqual(conversation.detail.messages, []);
    assert.equal(document.messages.length, 0);
    assert.equal(typst.messages.length, 0, 'PDF can render the valid empty-conversation fallback');
    const delivered = await runExport(request(id));
    assert.equal(delivered.exported, 1);
    assert.equal(delivered.partial, 0);
    assert.deepEqual(delivered.failed, []);
    assert.equal(attempts, 1, 'fresh accepted empty Detail does not need another fetch');
    assert.equal(browser.clicks(), 1);
    assert.match(await browser.blobs[0].text(), /Empty but valid/);
    assert.equal((await getExportRecord(key(id)))?.status, 'ok');
});
