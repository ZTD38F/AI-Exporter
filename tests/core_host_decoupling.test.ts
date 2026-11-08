/**
 * V2 host-decoupling contract. The removed AssetPipeline, BatchWorker and
 * SessionRecovery are not runtime ports. L1 acquisition, L2 Domain validation,
 * L3a persisted records, L3b composition and L4 packaging must work without
 * importing a Chrome extension host into their core logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { sourceDetail, sourceList, sourceMessage } from './helpers/l1SourceFixture.js';
import type { SourceConversationParseResult } from '../src/l1/parsers/parsingResult.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { GeminiAPIClient } from '../src/l1/client/gemini/geminiClient.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { readConversation } from '../src/l2/readConversation.js';
import { prepareExportResources } from '../src/application/export/prepareExportResources.js';
import { getExportRecord, putExportRecord } from '../src/l3a/storageService.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { planExportPaths, buildExportFiles } from '../src/l4/packaging/index.js';
import { __setZipConstructor, __getZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';

const account = fixtureAccount('gemini');
const key = (conversationId: string) => ({ accountId: account.id, conversationId });

test('L1 injected task resource bytes reach real L3b/L4 output with no chrome.tabs and no persistent byte cache', async () => {
    const id = 'decoupled-media', asset = { id: 'image', kind: 'image' as const,
        mediaType: 'image/png', name: 'diagram.png' };
    const source: SourceConversationParseResult = {
        conversationId: id, sourceVersion: 100,
        conversation: {
            index: { title: 'Decoupled Image', titleSource: 'provider', updatedAt: 100 },
            detail: { savedAt: 100, quality: { status: 'complete' }, assets: [asset],
                messages: [{ role: 'assistant', content: [
                    { type: 'paragraph', children: [{ type: 'text', text: 'Diagram from native capture' }] },
                    { type: 'image', assetId: asset.id },
                ] }],
            },
        },
        diagnostics: [], acquisitionHints: { image: { dataBase64: 'AQIDBA==' } },
    };
    const context = createSourceResourceContext();
    const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    if (originalChrome?.configurable) Reflect.deleteProperty(globalThis, 'chrome');
    try {
        context.retainParsed(key(id), source);
        const bound = validateParserDomain({
            index: { ...source.conversation.index, key: key(id) },
            detail: { ...source.conversation.detail, key: key(id) },
        });
        const domainBefore = structuredClone(bound);
        const prepared = await prepareExportResources(bound.detail.assets, new Set(['image']),
            (item, signal) => context.acquire(key(id), item, signal));
        const acquired = prepared.get('image');
        assert.ok(acquired?.ok);
        assert.deepEqual([...acquired.value.bytes], [1, 2, 3, 4]);
        const document = composeDomainDocument(bound, account);
        const [plan] = planExportPaths([{ conversation: bound, prepared, fileIds: new Set<string>() }], 'markdown');
        const markdown = renderDocumentMarkdown(document, plan.resources);
        const output = buildExportFiles('markdown', plan, markdown, prepared);
        assert.equal(output.length, 2);
        assert.match(markdown, /Diagram from native capture/);
        assert.ok(markdown.includes(plan.resources.image));
        assert.deepEqual(output.find(file => file.fileName === plan.resources.image)?.content, Uint8Array.of(1, 2, 3, 4));
        assert.deepEqual(bound, domainBefore);
        assert.ok(!JSON.stringify(bound).includes('AQIDBA=='), 'temporary inline bytes must not enter Domain');
    } finally {
        context.release();
        if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome);
    }
});

test('L1 GeminiProvider injected client commits through real L2/L3a without any chrome.tabs binding', async () => {
    const host = indexStorage();
    const id = 'decoupled-provider';
    const source = sourceDetail({ id, title: 'Real Provider', messages: [
        sourceMessage('native-response', 'Decoupled provider answer', 'model'),
    ] });
    const calls: string[] = [];
    const provider = new GeminiProvider({
        getConversationList: async () => sourceList('G_SOURCE_EMPTY_01'),
        getConversationDetail: async (conversationId, slot) => {
            calls.push(conversationId + ':' + slot);
            return source;
        },
    }, async () => 'u0');
    try {
        assert.equal(globalThis.chrome.tabs, undefined);
        await provider.fetchConversationDetail(account.id, id);
        assert.deepEqual(calls, [id + ':u0']);
        const conversation = await readConversation(key(id));
        assert.ok(conversation);
        assert.equal(conversation.index.title, 'Real Provider');
        assert.match(renderDocumentMarkdown(composeDomainDocument(conversation, account), {}),
            /Decoupled provider answer/);
    } finally { host.restore(); }
});

test('L1 GeminiAPIClient follows its AbortSignal without window or global cancellation state', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousFlag = Object.getOwnPropertyDescriptor(globalThis, '__gemExporterAborted');
    if (!previousWindow?.configurable) {
        // A preinstalled Node host has no need for global mutation here.
        const controller = new AbortController();
        const client = new GeminiAPIClient({ signal: controller.signal });
        assert.equal(client.isAborted(), false);
        controller.abort();
        assert.equal(client.isAborted(), true);
        return;
    }
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, '__gemExporterAborted');
    try {
        const controller = new AbortController();
        const client = new GeminiAPIClient({ signal: controller.signal });
        assert.equal(client.isAborted(), false);
        controller.abort();
        assert.equal(client.isAborted(), true);
    } finally {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        if (previousFlag) Object.defineProperty(globalThis, '__gemExporterAborted', previousFlag);
    }
});

test('L3a ExportRecord commits using IndexedDB without chrome.storage or v1 SessionRecovery', async () => {
    const host = indexStorage();
    const previous = Object.getOwnPropertyDescriptor(globalThis.chrome, 'storage');
    Reflect.deleteProperty(globalThis.chrome, 'storage');
    try {
        const identity = key('record-without-chrome');
        await putExportRecord(identity, { exportedAt: 222, format: 'markdown', status: 'ok', chatTime: 111 });
        assert.deepEqual(await getExportRecord(identity), {
            exportedAt: 222, format: 'markdown', status: 'ok', chatTime: 111,
        });
    } finally {
        if (previous) Object.defineProperty(globalThis.chrome, 'storage', previous);
        host.restore();
    }
});

test('production module override guard keeps test injection from becoming an export runtime dependency', () => {
    const original = process.env.NODE_ENV;
    try {
        process.env.NODE_ENV = 'production';
        __setZipConstructor(class { file() {} async generateAsync() { return new Blob(); } });
        assert.equal(__getZipConstructor(), undefined);
    } finally {
        if (original === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = original;
    }
});
