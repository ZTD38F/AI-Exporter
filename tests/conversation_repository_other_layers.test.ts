// Cross-module v2 scenarios for L2 metadata admission, real L3a persistence,
// Application export records, and L3b/L4 output. No legacy Repository/batch-worker API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { fixtureAccount, fixtureKey } from './helpers/domainFixture.js';
import { readStoredConversation } from './helpers/readStoredConversation.js';
import { ingestDetail, ingestIndexes } from '../src/l2/ingestion.js';
import { getIndex, getDetail, getExportRecord, putExportRecord, deleteStoredConversation } from '../src/l3a/storageService.js';
import { shouldSkipExport } from '../src/application/export/runExport.js';
import { clearLocalExportRecords } from '../src/application/localCleanup.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { serializeDomainJson } from '../src/l4/format/json/serializeDomainJson.js';
import type { ExportRequest } from '../src/application/export/types.js';

const account = fixtureAccount('gemini');
const key = fixtureKey('chat');
const request: ExportRequest = {
    keys: [key], format: 'markdown', delivery: 'browserDownload',
    includeAssets: false, skipUnchanged: true,
};
const body = (answer: string, savedAt: number) => ({
    savedAt, quality: { status: 'complete' as const }, assets: [],
    messages: [
        { role: 'user' as const, content: [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text: 'Question' }] }] },
        { role: 'assistant' as const, content: [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text: answer }] }] },
    ],
});

test('current v2 Index authority wins over a stale selection without rewriting the stored Detail', async () => {
    const env = indexStorage();
    try {
        const incoming = body('Original answer', 100);
        await ingestDetail(key.accountId, key.conversationId, incoming, {
            title: 'Old title', titleSource: 'derived', createdAt: 70, updatedAt: 100,
        });
        await ingestIndexes(key.accountId, [{ conversationId: key.conversationId, fields: {
            title: 'Renamed title', titleSource: 'provider', createdAt: 50, updatedAt: 200,
        } }]);
        await ingestIndexes(key.accountId, [{ conversationId: key.conversationId, fields: {
            title: 'Stale selection title', titleSource: 'derived', updatedAt: 150,
        } }]);
        const restored = await readStoredConversation(key);
        assert.ok(restored);
        assert.equal(restored.index.title, 'Renamed title');
        assert.equal(restored.index.createdAt, 50);
        assert.equal(restored.index.updatedAt, 200);
        assert.equal(restored.detail.savedAt, 100);
        assert.ok(renderDocumentMarkdown(composeDomainDocument(restored, account), {}).includes('Original answer'));
        assert.equal(incoming.messages[1].content[0].children[0].text, 'Original answer', 'caller input remains intact');
    } finally {
        env.restore();
    }
});

test('a rename during export survives a v2 ExportRecord write; old chatTime cannot suppress newer content', async () => {
    const env = indexStorage();
    try {
        await ingestDetail(key.accountId, key.conversationId, body('Existing body', 100), {
            title: 'Original title', titleSource: 'derived', updatedAt: 100,
        });
        const prepared = await readStoredConversation(key);
        assert.ok(prepared);
        await ingestIndexes(key.accountId, [{ conversationId: key.conversationId, fields: {
            title: 'Rename during export', titleSource: 'user', updatedAt: 200,
        } }]);
        await putExportRecord(key, { exportedAt: 300, chatTime: 100, status: 'ok', format: 'markdown' });
        const current = await readStoredConversation(key);
        assert.equal(current?.index.title, 'Rename during export');
        assert.equal(current?.index.updatedAt, 200);
        assert.equal(prepared.index.title, 'Original title');
        assert.equal((await getExportRecord(key))?.chatTime, 100);
        assert.equal(shouldSkipExport(await getExportRecord(key), current?.index.updatedAt, request), false);
        await clearLocalExportRecords(key.accountId);
        assert.equal(await getExportRecord(key), null);
        assert.equal((await readStoredConversation(key))?.index.title, 'Rename during export');
    } finally {
        env.restore();
    }
});

test('fresh v2 admission commits Index and Detail before L3b/L4 can render them', async () => {
    const env = indexStorage();
    try {
        await ingestDetail(key.accountId, key.conversationId, body('Just acquired', 120), {
            title: 'Fresh title', titleSource: 'provider', createdAt: 20, updatedAt: 120,
        });
        assert.equal((await getIndex(key))?.createdAt, 20);
        assert.equal((await getDetail(key))?.savedAt, 120);
        assert.equal(await getExportRecord(key), null);
        const restored = await readStoredConversation(key);
        assert.ok(restored);
        const markdown = renderDocumentMarkdown(composeDomainDocument(restored, account), {});
        const json = JSON.parse(serializeDomainJson(restored, account, {}));
        assert.ok(markdown.includes('Just acquired'));
        assert.equal(json.conversation.index.title, 'Fresh title');
        assert.equal(json.conversation.detail.messages[1].content[0].children[0].text, 'Just acquired');
        assert.equal(json.conversation.detail.savedAt, 120);
    } finally {
        env.restore();
    }
});

test('a cached v2 view cannot republish old metadata or resurrect a deleted Index', async () => {
    const env = indexStorage();
    try {
        await ingestDetail(key.accountId, key.conversationId, body('Old body', 100), {
            title: 'Old title', titleSource: 'derived', updatedAt: 100,
        });
        const cached = await readStoredConversation(key);
        assert.ok(cached);
        await ingestDetail(key.accountId, key.conversationId, body('New body', 200), {
            title: 'New title', titleSource: 'provider', updatedAt: 200,
        });
        const writes = env.writes();
        const current = await readStoredConversation(key);
        assert.equal(current?.index.title, 'New title');
        assert.equal(current?.detail.savedAt, 200);
        assert.match(JSON.stringify(current?.detail.messages), /New body/);
        assert.match(JSON.stringify(cached.detail.messages), /Old body/);
        assert.equal(env.writes(), writes, 'read-only projections never write stale snapshots');
        await deleteStoredConversation(key);
        assert.equal(await readStoredConversation(key), null);
        assert.equal(await getIndex(key), null);
        assert.equal(await getDetail(key), null);
    } finally {
        env.restore();
    }
});
