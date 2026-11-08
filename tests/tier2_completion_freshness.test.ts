import test from 'node:test';
import assert from 'node:assert/strict';
import { v2LiveSaveHost, seedLiveDetail, liveKey } from './helpers/v2LiveSaveHost.js';
import { runLiveSave } from '../src/runtime/background/liveSaveHandler.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { updateSettings } from '../src/application/settings/index.js';
import { getIndex, getDetail, getExportRecord } from '../src/l3a/storageService.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { runExport, shouldSkipExport } from '../src/application/export/runExport.js';
import type { DomainMessage } from '../src/l2/conversationDetail.js';

const messages = (turns: number): DomainMessage[] => Array.from({ length: turns * 2 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: [{ type: 'paragraph', children: [{ type: 'text', text: `Turn ${Math.floor(i / 2) + 1} ${i % 2 ? 'answer' : 'prompt'}` }] },
        ...(i === 1 ? [{ type: 'image' as const, assetId: 'earlier-image' }] : [])],
}));

test('Tier 2 continued reply with Live Save off refreshes source, badge and all six exported turns including the earlier image', async t => {
    const host = v2LiveSaveHost(t), key = liveKey('continued-live-off');
    const assets = [{ id: 'earlier-image', kind: 'image' as const, name: 'earlier.png', sourceUri: 'https://example.test/earlier.png' }];
    await seedLiveDetail(key.conversationId, assets, { savedAt: 1700000000000, messages: messages(5) });
    host.source(assets[0].sourceUri, Uint8Array.of(1, 2, 3));
    await runLiveSave(key);
    const record = await getExportRecord(key);
    host.files.clear(); host.requests.length = 0;
    await updateSettings({ enabledDisk: false });
    let acquired = 0;
    t.mock.method(GeminiProvider.prototype, 'fetchConversationDetail', async (accountId: string, conversationId: string) => {
        assert.deepEqual({ accountId, conversationId }, key);
        acquired++;
        await ingestDetail(accountId, conversationId, {
            savedAt: 1700000100000, quality: { status: 'complete' }, assets, messages: messages(6),
        }, { updatedAt: 1700000100000 });
    });
    assert.equal(await runLiveSave(key, true), null);
    assert.equal(acquired, 1, 'verified completion must acquire even when disk saving is disabled');
    assert.equal((await getDetail(key))?.messages.length, 12);
    assert.equal((await getIndex(key))?.updatedAt, 1700000100000);
    assert.deepEqual(await getExportRecord(key), record, 'refresh does not falsely mark a file delivered');
    assert.equal(host.files.size, 0); assert.equal(host.requests.length, 0, 'refresh does not download assets');
    const request = { keys: [key], format: 'markdown' as const, delivery: 'folderWriter' as const, includeAssets: true, skipUnchanged: true };
    assert.equal(shouldSkipExport(record, (await getIndex(key))?.updatedAt, request), false);
    assert.equal((await runExport(request)).exported, 1);
    const markdown = [...host.files.values()].find((value): value is string => typeof value === 'string')!;
    for (let turn = 1; turn <= 6; turn++) {
        assert.match(markdown, new RegExp(`Turn ${turn} prompt`));
        assert.match(markdown, new RegExp(`Turn ${turn} answer`));
    }
    const image = [...host.files.keys()].find(path => path.startsWith('assets/'))!;
    assert.ok(image); assert.ok(markdown.indexOf(image) < markdown.indexOf('Turn 2 prompt'), 'image stays in its original reply');
    assert.equal(acquired, 1, 'manual export uses the refreshed complete Domain');
});
