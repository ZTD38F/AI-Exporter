/**
 * V2 metadata-only Options/PDF regression.
 *
 * Options now supplies only ConversationKey[] to runExport. L1 admits a fetched
 * Detail through L2; Export re-reads the trusted Index + Detail. No PdfExporter,
 * fetchChatDetail DTO, duplicate StorageService, or old PDF stage exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestIndexes, ingestDetail, ingestDeletedConversation } from '../src/l2/ingestion.js';
import { readConversation } from '../src/l2/readConversation.js';
import { getIndex, getDetail, getExportRecord } from '../src/l3a/storageService.js';
import { runExport } from '../src/application/export/runExport.js';
import { updateSettings } from '../src/application/settings/index.js';
import type { ExportRequest } from '../src/application/export/types.js';
import type { ConversationKey } from '../src/l2/conversationKey.js';
import { ProviderRegistry } from '../src/l1/client/providerRegistry.js';
import type { AIProvider } from '../src/l1/client/aiProvider.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { compileDocumentPdf } from '../src/l4/format/pdf/compileDocumentPdf.js';
import type { IPdfCompiler } from '../src/l4/format/pdf/pdfCompiler.js';
import { extractPdfText } from './helpers/pdfTextExtract.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { useIndexStorage } from './helpers/indexStorage.js';

useIndexStorage();

const account = fixtureAccount('custom');
const VERSION = 1_700_000_000_000;
const MARKER = 'REGRESSION-MARKER-9f2c71';

function key(conversationId: string): ConversationKey {
    return { accountId: account.id, conversationId };
}
function request(conversationId: string): ExportRequest {
    return { keys: [key(conversationId)], format: 'markdown', delivery: 'browserDownload',
        includeAssets: false, skipUnchanged: false };
}
function detail(body: string, savedAt = VERSION) {
    return {
        savedAt,
        quality: { status: 'complete' as const },
        assets: [],
        messages: [{ role: 'assistant' as const, content: [
            { type: 'paragraph' as const, children: [{ type: 'text' as const, text: body }] },
        ] }],
    };
}
async function admitMetadata(conversationId: string, title: string, updatedAt = VERSION): Promise<void> {
    await ingestIndexes(account.id, [{ conversationId,
        fields: { title, titleSource: 'user', updatedAt } }]);
}
async function exportMarkdown(conversationId: string) {
    // The indexStorage fake navigator only implements Web Locks, not navigator.language.
    await updateSettings({ language: 'en' });
    return runExport(request(conversationId));
}
function mockProvider(fetchConversationDetail: AIProvider['fetchConversationDetail']): () => void {
    const previous = ProviderRegistry.get('custom');
    const provider: AIProvider = {
        id: 'custom', name: 'Options metadata test provider', hostPatterns: [],
        matchesUrl: () => false,
        checkReadiness: async () => ({ ready: true }),
        listConversations: async () => 'source_end',
        fetchConversationDetail,
        acquireResource: async () => { throw new Error('No assets needed'); },
    };
    ProviderRegistry.register(provider);
    return () => {
        ProviderRegistry.unregister('custom');
        if (previous) ProviderRegistry.register(previous);
    };
}
function captureDownloads() {
    const blobs: Blob[] = [];
    const fileNames: string[] = [];
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const oldMouseEvent = Object.getOwnPropertyDescriptor(globalThis, 'MouseEvent');
    Object.defineProperty(globalThis, 'MouseEvent', { configurable: true, value: Event });
    const oldCreate = URL.createObjectURL;
    const oldRevoke = URL.revokeObjectURL;
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            body: { appendChild() {} },
            createElement(tag: string) {
                assert.equal(tag, 'a');
                return {
                    href: '', download: '',
                    dispatchEvent() { fileNames.push(this.download); return true; },
                    remove() {},
                };
            },
        },
    });
    URL.createObjectURL = ((blob: Blob) => {
        blobs.push(blob);
        return 'blob:pdf-metadata-' + blobs.length;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    return {
        blobs, fileNames,
        restore() {
            URL.createObjectURL = oldCreate;
            URL.revokeObjectURL = oldRevoke;
            if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
            else Reflect.deleteProperty(globalThis, 'document');
            if (oldMouseEvent) Object.defineProperty(globalThis, 'MouseEvent', oldMouseEvent);
            else Reflect.deleteProperty(globalThis, 'MouseEvent');
        },
    };
}

/** Keep the PDF check at the v2 L4 IPdfCompiler seam, not a removed PdfExporter. */
function textOf(value: unknown): string {
    if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(' ');
    if (!value || typeof value !== 'object') return '';
    const node = value as Record<string, unknown>;
    return [
        typeof node.text === 'string' ? node.text : '',
        textOf(node.children), textOf(node.blocks), textOf(node.items),
    ].filter(Boolean).join(' ');
}
function escapePdfText(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
function textPdf(title: string, body: string): Uint8Array {
    const enc = new TextEncoder();
    const stream = [
        'BT /F1 24 Tf 72 720 Td',
        '(' + escapePdfText(title) + ') Tj',
        '0 -36 Td /F1 12 Tf',
        '(' + escapePdfText(body.slice(0, 400)) + ') Tj',
        'ET',
    ].join('\n');
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        '<< /Length ' + enc.encode(stream).length + ' >>\nstream\n' + stream + '\nendstream',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let content = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (const [index, object] of objects.entries()) {
        offsets.push(enc.encode(content).length);
        content += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
    }
    const xrefAt = enc.encode(content).length;
    content += 'xref\n0 6\n0000000000 65535 f \n';
    for (const off of offsets) content += String(off).padStart(10, '0') + ' 00000 n \n';
    return enc.encode(content + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n');
}

test('Options list metadata alone refreshes L2 Detail before exporting the full body', async () => {
    const id = 'options-metadata';
    await admitMetadata(id, 'Canonical list title');
    assert.equal(await getDetail(key(id)), null, 'list metadata must not masquerade as a Detail');
    let fetches = 0;
    const restoreProvider = mockProvider(async (accountId, conversationId) => {
        fetches++;
        assert.deepEqual({ accountId, conversationId }, key(id));
        await ingestDetail(accountId, conversationId, detail('Complete conversation body ' + MARKER),
            { title: 'Lower authority candidate', titleSource: 'derived', updatedAt: VERSION });
    });
    const downloads = captureDownloads();
    try {
        const result = await exportMarkdown(id);
        assert.deepEqual({ exported: result.exported, partial: result.partial, failed: result.failed },
            { exported: 1, partial: 0, failed: [] });
        assert.equal(fetches, 1, 'only L1 fetches; the response is never treated as a Detail DTO');
        assert.equal(downloads.blobs.length, 1);
        assert.equal(downloads.fileNames.length, 1);
        const output = await downloads.blobs[0].text();
        assert.match(output, /Canonical list title/);
        assert.match(output, /REGRESSION-MARKER-9f2c71/);
        assert.doesNotMatch(output, /Lower authority candidate/);
        assert.equal((await readConversation(key(id)))?.detail.messages.length, 1);
        const record = await getExportRecord(key(id));
        assert.ok(record);
        assert.equal(record.status, 'ok');
        assert.equal(record.chatTime, VERSION);
        assert.ok(!('title' in record), 'v2 ExportRecord stores no duplicate title');
    } finally {
        downloads.restore();
        restoreProvider();
    }
});

test('a key-only selection without an Index may still be resolved by L1 and exported', async () => {
    const id = 'key-only';
    assert.equal(await getIndex(key(id)), null);
    let calls = 0;
    const restoreProvider = mockProvider(async (accountId, conversationId) => {
        calls++;
        await ingestDetail(accountId, conversationId, detail('Key-only full body ' + MARKER),
            { title: 'Resolved by provider', titleSource: 'provider', updatedAt: VERSION });
    });
    const downloads = captureDownloads();
    try {
        const result = await exportMarkdown(id);
        assert.equal(result.exported, 1);
        assert.equal(result.failed.length, 0);
        assert.equal(calls, 1);
        assert.equal((await getIndex(key(id)))?.title, 'Resolved by provider');
        assert.match(await downloads.blobs[0].text(), /Key-only full body REGRESSION-MARKER-9f2c71/);
    } finally {
        downloads.restore();
        restoreProvider();
    }
});

test('metadata-only Index cannot produce an empty export if the provider returns without admitting Detail', async () => {
    const id = 'no-detail-commit';
    await admitMetadata(id, 'Index only');
    let fetches = 0;
    const restoreProvider = mockProvider(async () => { fetches++; });
    const downloads = captureDownloads();
    try {
        const result = await exportMarkdown(id);
        assert.equal(fetches, 1);
        assert.deepEqual(result.failed, [key(id)]);
        assert.equal(result.exported, 0);
        assert.equal(downloads.blobs.length, 0);
        assert.equal(await getDetail(key(id)), null);
        assert.equal(await getExportRecord(key(id)), null);
    } finally {
        downloads.restore();
        restoreProvider();
    }
});

test('offline metadata-only resolution fails closed without writing an ExportRecord', async () => {
    const id = 'unavailable-detail';
    await admitMetadata(id, 'Not fetched');
    const restoreProvider = mockProvider(async () => { throw new Error('network unavailable'); });
    const downloads = captureDownloads();
    try {
        const result = await exportMarkdown(id);
        assert.deepEqual(result.failed, [key(id)]);
        assert.equal(result.exported, 0);
        assert.equal(downloads.blobs.length, 0);
        assert.equal(await getExportRecord(key(id)), null);
    } finally {
        downloads.restore();
        restoreProvider();
    }
});

test('a newer authoritative Index title survives stale local Detail fallback; version stays on Detail', async () => {
    const id = 'title-and-version';
    await ingestDetail(account.id, id, detail('Retained older body ' + MARKER),
        { title: 'Old body title', titleSource: 'derived', updatedAt: VERSION });
    await admitMetadata(id, 'Current Index Title', VERSION + 1000);
    const restoreProvider = mockProvider(async () => { throw new Error('temporarily offline'); });
    const downloads = captureDownloads();
    try {
        const result = await exportMarkdown(id);
        assert.equal(result.exported, 1, 'recoverable fetch failure may use already-admitted Detail');
        assert.equal(result.partial, 1, 'body is older than current Index version');
        assert.deepEqual(result.failed, []);
        const output = await downloads.blobs[0].text();
        assert.match(output, /Current Index Title/);
        assert.match(output, /Retained older body REGRESSION-MARKER-9f2c71/);
        assert.doesNotMatch(output, /Old body title/);
        const record = await getExportRecord(key(id));
        assert.ok(record);
        assert.equal(record.status, 'partial');
        assert.equal(record.chatTime, VERSION, 'must not substitute Index.updatedAt for the saved body version');
        assert.equal((await readConversation(key(id)))?.index.title, 'Current Index Title');

        await ingestDeletedConversation(account.id, id);
        assert.equal(await readConversation(key(id)), null);
        assert.equal(await getExportRecord(key(id)), null);
        const second = await exportMarkdown(id);
        assert.equal(second.exported, 0);
        assert.deepEqual(second.failed, [key(id)]);
        assert.equal(downloads.blobs.length, 1, 'deleted Detail cannot be exported through stale selection metadata');
    } finally {
        downloads.restore();
        restoreProvider();
    }
});

test('v2 L2 Index metadata and nonempty Detail reach PDF Format as the same document', async () => {
    const id = 'pdf-boundary';
    await ingestDetail(account.id, id, detail('PDF authored body ' + MARKER),
        { title: 'Old snapshot heading', titleSource: 'derived', updatedAt: VERSION });
    await admitMetadata(id, 'Authoritative PDF Title', VERSION + 1000);
    const conversation = await readConversation(key(id));
    assert.ok(conversation);
    const document = composeDomainDocument(conversation, account);
    assert.equal(document.title, 'Authoritative PDF Title');
    assert.equal(document.messages.length, 1);
    let compiled = 0;
    const compiler: IPdfCompiler = {
        name: 'metadata-content-pdf-check',
        async compile(payload) {
            compiled++;
            assert.equal(payload.document.title, 'Authoritative PDF Title');
            assert.equal(payload.document.messages.length, 1);
            const body = textOf(payload.document.messages);
            assert.match(body, /PDF authored body REGRESSION-MARKER-9f2c71/);
            return { pdfBytes: textPdf(payload.document.title, body), diagnostics: [] };
        },
    };
    const pdf = await compileDocumentPdf(document, {}, new Map(), compiler,
        { signal: new AbortController().signal, reportProgress() {} }, { locale: 'en' });
    assert.equal(compiled, 1);
    const extracted = extractPdfText(pdf.pdfBytes);
    assert.equal(extracted.pageCount, 1);
    assert.match(extracted.text, /Authoritative PDF Title/);
    assert.match(extracted.text, /PDF authored body REGRESSION-MARKER-9f2c71/);
    assert.doesNotMatch(extracted.text, /0 messages|Old snapshot heading/);
});
