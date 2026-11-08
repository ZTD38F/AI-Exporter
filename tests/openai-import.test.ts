import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { importOpenAI } from '../src/l1/imports/openai/importOpenAI.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { getDetail, getIndex, getCoverage, getExportRecord } from '../src/l3a/storageService.js';
import { assertDomainClosure } from '../src/l2/closure.js';

useIndexStorage();
test('OpenAI ZIP commits validated Domain into real Storage and reimport preserves key ownership', async () => {
    const JSZip: { new(): { file(path: string, text: string): void;
        generateAsync(options: { type: 'uint8array' }): Promise<Uint8Array> } } = require('../lib/jszip.min.js');
    Reflect.set(globalThis, 'JSZip', JSZip);
    const account = fixtureAccount('chatgpt');
    const key = { accountId: account.id, conversationId: 'openai-real-storage' };
    const zip = new JSZip();
    zip.file('conversations.json', JSON.stringify([{
        id: key.conversationId, title: 'Official export', current_node: 'answer', create_time: 1700000000, update_time: 1700000001,
        mapping: {
            root: { id: 'root', parent: null, children: ['question'] },
            question: { id: 'question', parent: 'root', children: ['answer'], message: { id: 'question', author: { role: 'user' }, recipient: 'all', content: { content_type: 'text', parts: ['Question'] } } },
            answer: { id: 'answer', parent: 'question', children: [], message: { id: 'answer', author: { role: 'assistant' }, recipient: 'all', end_turn: true, status: 'finished_successfully', content: { content_type: 'text', parts: ['Answer\n\n![diagram](file-diagram.png)\n\n[notes](sandbox:/mnt/data/notes.md)'] } } },
        },
    }]));
    zip.file('file-diagram.png', 'image-bytes');
    zip.file('notes.md', '# original notes');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const resources = createSourceResourceContext();
    try {
        for (let i = 0; i < 2; i++) {
            const result = await importOpenAI(bytes, account.id, undefined, resources);
            assert.deepEqual(result, { imported: 1, skipped: 0, missingAssets: 0, status: 'ok' });
        }
        const detail = await getDetail(key);
        assert.ok(detail);
        assertDomainClosure(detail);
        assert.equal(detail.messages.length, 2);
        assert.equal(detail.assets.length, 2);
        assert.equal((await getIndex(key))?.title, 'Official export');
        const note = detail.assets.find(asset => asset.name === 'notes.md');
        assert.ok(note);
        assert.equal(new TextDecoder().decode((await resources.acquire(key, note)).bytes), '# original notes');
        assert.equal(await getCoverage(account.id, 'recent'), null);
        assert.equal(await getExportRecord(key), null);
        assert.equal(JSON.stringify(detail).includes('# original notes'), false, 'attachment bytes never enter stored Domain');
    } finally { resources.release(); }
});
