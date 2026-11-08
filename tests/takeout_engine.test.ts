import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { useIndexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID, OTHER_ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { activityHtml, takeoutArchive } from './helpers/l1SourceFixture.js';
import { importTakeout } from '../src/l1/imports/takeout/importTakeout.js';
import { stripHtmlTags } from '../src/l1/parsers/gemini/takeout/decodeHtml.js';
import { parseGeminiTakeoutZipArchive } from '../src/l1/imports/takeout/readArchive.js';
import { parseGeminiTakeoutArchive } from '../src/l1/parsers/gemini/takeout/parseConversation.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { listIndexes as getConversations } from '../src/l3a/storageService.js';
import { getDetail } from '../src/l3a/storageService.js';
useIndexStorage();

test('Takeout import exposes only count/status after committing multi-turn facts with case-preserved source identity', async () => {
    const html = activityHtml('<p>First answer</p>', 'CasePreserved_123') + activityHtml('<p>Second answer</p>', 'CasePreserved_123', '2026-09-02T12:01:00Z');
    const progress: number[] = [];
    const result = await importTakeout(takeoutArchive(html), ACCOUNT_UUID, n => progress.push(n));
    assert.deepEqual(Object.keys(result).sort(), ['imported', 'status']); assert.equal(result.imported, 1);
    const stored = await getDetail({ accountId: ACCOUNT_UUID, conversationId: 'CasePreserved_123' });
    assert.ok(stored); assert.equal(stored.messages.length, 4);
    assert.equal((await getConversations(ACCOUNT_UUID))[0].titleSource, 'derived');
    assert.equal(progress.at(-1), 100); assert.ok(progress.every(n => typeof n === 'number'));
});
test('Takeout unreferenced C2PA files do not become conversation resources by timestamp proximity', async () => {
    let reads = 0;
    const resources = createSourceResourceContext();
    try {
        await importTakeout(takeoutArchive(activityHtml(), { 'watermarked.png': { _data: { uncompressedSize: 50 }, async: async () => { reads++; return new TextEncoder().encode('c2pa date="20260902120000Z"'); } } }), ACCOUNT_UUID, undefined, resources);
        const stored = await getDetail({ accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' });
        assert.ok(stored); assert.deepEqual(stored.assets, []); assert.equal(reads, 0);
        await assert.rejects(resources.acquire({ accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' }, { id: 'watermarked.png', kind: 'image' }), /locator/);
    } finally { resources.release(); }
});
test('authentic cleaned Takeout fixture has six keyless conversations and retains unresolved media diagnostics', async () => {
    const JSZip = require('../lib/jszip.min.js');
    const bytes = readFileSync(__dirname + '/fixtures/gemini_takeout_clean.zip');
    const parsed = await parseGeminiTakeoutZipArchive(bytes, { providerId: 'gemini', readArchive: raw => JSZip.loadAsync(raw) });
    assert.equal(parsed.length, 6);
    assert.ok(parsed.some(p => p.conversationId === '1cea7e48cc166b57'));
    const cat = parsed.find(p => p.conversationId === '1bd028d5c5b0c0e2'); assert.ok(cat);
    assert.equal('account' in cat, false); assert.equal('key' in cat.conversation.detail, false);
    assert.ok(cat.diagnostics.some(d => d.code === 'TAKEOUT_GENERATED_MEDIA_UNRESOLVED'));
});
test('Takeout account UUID binds ingestion; independent imports never mix accounts', async () => {
    await importTakeout(takeoutArchive(activityHtml('<p>One</p>', 'first_chat_123')), ACCOUNT_UUID);
    await importTakeout(takeoutArchive(activityHtml('<p>Two</p>', 'second_chat_123')), OTHER_ACCOUNT_UUID);
    assert.deepEqual((await getConversations(ACCOUNT_UUID)).map(i => i.key.conversationId), ['first_chat_123']);
    assert.deepEqual((await getConversations(OTHER_ACCOUNT_UUID)).map(i => i.key.conversationId), ['second_chat_123']);
});
test('Takeout rejects missing, slot-shaped and foreign-provider targets before opening ZIP bytes', async () => {
    for (const accountId of ['', 'u0', '10000000-0000-4000-8000-000000000004']) await assert.rejects(importTakeout({} as File, accountId), /account|Account|Gemini/);
});
test('Takeout rejects unsupported and over-budget archives without producing facts', async () => {
    await assert.rejects(importTakeout(takeoutArchive('<p>Unsupported activity</p>'), ACCOUNT_UUID));
    const archive = takeoutArchive();
    Reflect.get(archive, 'files')['Takeout/Gemini/MyActivity.html']._data.uncompressedSize = 300 * 1024 * 1024;
    await assert.rejects(importTakeout(archive, ACCOUNT_UUID), /size|limit|ZIP|MB|MiB|large|超|大小/i);
    assert.equal((await getConversations(ACCOUNT_UUID)).length, 0);
});
test('Takeout native parsing and HTML cleanup are pure and do not require an archive or Registry', () => {
    const raw = { htmlText: activityHtml() };
    const before = structuredClone(raw);
    const [source] = parseGeminiTakeoutArchive(raw, { providerId: 'gemini' });
    assert.equal(source.conversationId, 'source_chat_123'); assert.deepEqual(raw, before);
    assert.equal(stripHtmlTags('<p>Hello <strong>world</strong></p>'), 'Hello world');
});
