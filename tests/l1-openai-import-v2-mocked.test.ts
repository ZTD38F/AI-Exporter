import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ports, CHATGPT_ACCOUNT, GEMINI_ACCOUNT } from './helpers/l1V2UnitMocks.js';
import { importOpenAI } from '../src/l1/imports/openai/importOpenAI.js';
import { readOpenAIArchive } from '../src/l1/imports/openai/readArchive.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';

// The bundled third-party library has no declarations; this is its test writer surface.
const JSZip: { new(): { file(path: string, bytes: string | Uint8Array): void;
    generateAsync(options: { type: 'uint8array' }): Promise<Uint8Array> } } = require('../lib/jszip.min.js');
beforeEach(() => { ports.reset(); Reflect.set(globalThis, 'JSZip', JSZip); });
function conversation(id = 'conversation-1') {
    return { id, title: '离线导入 / Offline', create_time: 1700000000, update_time: 1700000002,
        current_node: 'a', mapping: {
            root: { id: 'root', parent: null, children: ['u'] },
            u: { id: 'u', parent: 'root', children: ['a'], message: { id: 'u', author: { role: 'user' }, recipient: 'all',
                create_time: 1700000000, content: { content_type: 'multimodal_text', parts: ['Question', { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file-image' }] },
                metadata: { attachments: [{ id: 'file-note', name: 'note.md', mime_type: 'text/markdown' }] } } },
            a: { id: 'a', parent: 'u', children: [], message: { id: 'a', author: { role: 'assistant' }, recipient: 'all',
                create_time: 1700000002, status: 'finished_successfully', end_turn: true,
                content: { content_type: 'text', parts: ['Answer\n\n```python\nprint(1)\n```'] }, metadata: { model_slug: 'gpt-test' } } },
        } };
}
async function zip(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
    const archive = new JSZip();
    for (const [name, bytes] of Object.entries(files)) archive.file(name, bytes);
    return archive.generateAsync({ type: 'uint8array' });
}
async function fixture(rows: unknown = [conversation()], additional: Record<string, string | Uint8Array> = {}) {
    return zip({ 'conversations.json': JSON.stringify(rows), 'user.json': JSON.stringify({ id: 'user-1' }),
        'library_files.json': JSON.stringify([{ file_id: 'file-image', file_name: 'photo.png', mime_type: 'image/png' }]),
        'file-image.dat': Uint8Array.of(137, 80, 78, 71), 'file-note.dat': '# note', ...additional });
}

test('OpenAI ZIP preserves current branch, source metadata and lazy original attachment bytes', async () => {
    const resources = createSourceResourceContext();
    const progress: number[] = [];
    const result = await importOpenAI(await fixture(), CHATGPT_ACCOUNT.id, p => progress.push(p), resources);
    assert.deepEqual(result, { imported: 1, skipped: 0, missingAssets: 0, status: 'ok' });
    const admitted = ports.details[0];
    assert.equal(admitted.conversationId, 'conversation-1');
    assert.equal(admitted.indexFields?.title, '离线导入 / Offline');
    assert.equal(admitted.indexFields?.updatedAt, 1700000002000);
    assert.deepEqual(admitted.detail.messages.map(m => [m.role, m.timestamp]), [['user', 1700000000000], ['assistant', 1700000002000]]);
    assert.equal(admitted.detail.messages[1].model, 'gpt-test');
    assert.equal(admitted.detail.assets[0].name, 'photo.png');
    const key = { accountId: CHATGPT_ACCOUNT.id, conversationId: admitted.conversationId };
    assert.ok(resources.has(key, admitted.detail.assets[0].id));
    assert.deepEqual((await resources.acquire(key, admitted.detail.assets[0])).bytes, Uint8Array.of(137, 80, 78, 71));
    assert.equal(new TextDecoder().decode((await resources.acquire(key, admitted.detail.assets[1])).bytes), '# note');
    assert.deepEqual(ports.indexes, [], 'offline import never fabricates online list coverage');
    assert.equal('key' in admitted.detail, false);
    assert.equal(progress.at(-1), 100);
    resources.release();
    assert.equal(resources.has(key, admitted.detail.assets[0].id), false);
});

test('empty official export and missing conversation body are distinct; library never fabricates chats', async () => {
    assert.equal((await importOpenAI(await fixture([]), CHATGPT_ACCOUNT.id)).status, 'empty');
    assert.equal(ports.details.length, 0);
    await assert.rejects(importOpenAI(await zip({ 'library_files.json': '[]' }), CHATGPT_ACCOUNT.id), /does not contain conversations/);
});

test('manifest shards are read in order and malformed later shards cause no writes', async () => {
    const manifest = JSON.stringify({ version: 1, logical_files: { 'conversations.json': { files: ['part-0.json', 'part-1.json'], sharded: true } } });
    const data = { 'export_manifest.json': manifest, 'part-0.json': JSON.stringify([conversation('first')]), 'part-1.json': JSON.stringify([conversation('second')]) };
    const result = await importOpenAI(await zip(data), CHATGPT_ACCOUNT.id);
    assert.equal(result.imported, 2);
    assert.deepEqual(ports.details.map(d => d.conversationId), ['first', 'second']);
    ports.reset();
    await assert.rejects(importOpenAI(await zip({ ...data, 'part-1.json': '[{"id":"broken"}]' }), CHATGPT_ACCOUNT.id));
    assert.equal(ports.details.length, 0);
    await assert.rejects(readOpenAIArchive(await zip({ 'export_manifest.json': manifest })), /missing files/);
});

test('provider and user mismatch never write; missing local assets report partial without losing body', async () => {
    await assert.rejects(importOpenAI(await fixture(), GEMINI_ACCOUNT.id), /Select a ChatGPT/);
    await assert.rejects(importOpenAI(await fixture(undefined, { 'user.json': '{"id":"foreign"}' }), CHATGPT_ACCOUNT.id), /different ChatGPT user/);
    assert.equal(ports.details.length, 0);
    const result = await importOpenAI(await zip({ 'conversations.json': JSON.stringify([conversation()]) }), CHATGPT_ACCOUNT.id);
    assert.equal(result.status, 'partial');
    assert.equal(result.missingAssets, 2);
    assert.equal(ports.details[0].detail.messages.length, 2);
});

test('rejected Detail retains no ZIP readers and commit errors propagate', async () => {
    ports.detailDecision = { accepted: false, changed: false };
    const resources = createSourceResourceContext();
    const result = await importOpenAI(await fixture(), CHATGPT_ACCOUNT.id, undefined, resources);
    assert.equal(result.imported, 0);
    assert.equal(result.skipped, 1);
    assert.equal(resources.has({ accountId: CHATGPT_ACCOUNT.id, conversationId: 'conversation-1' }, ports.details[0].detail.assets[0].id), false);
    ports.detailError = new Error('commit failure');
    await assert.rejects(importOpenAI(await fixture(), CHATGPT_ACCOUNT.id), /commit failure/);
});

test('OpenAI archive rejects corrupt ZIP, traversal and oversized JSON before reading content', async () => {
    await assert.rejects(readOpenAIArchive(Uint8Array.of(1, 2, 3)));
    await assert.rejects(readOpenAIArchive(await zip({ '../conversations.json': '[]' })), /Invalid OpenAI ZIP path/);
    Reflect.set(globalThis, 'JSZip', { loadAsync: async () => ({ files: { 'conversations.json': {
        _data: { uncompressedSize: 251 * 1024 * 1024 }, async: async () => { throw new Error('must not inflate'); },
    } } }) });
    const archive = await readOpenAIArchive(Uint8Array.of(1));
    await assert.rejects(archive.json('conversations.json'), /exceeds the supported/);
});

test('Markdown-local images and sandbox downloads bind to original archive files with closed asset references', async () => {
    const row = conversation();
    row.mapping.a.message.content.parts = ['![diagram](file-diagram.png)\n\n[Report](sandbox:/mnt/data/report.pdf)\n\n```text\n[sample](sandbox:/mnt/data/not-a-file)\n```'];
    const result = await importOpenAI(await fixture([row], {
        'file-diagram.png': Uint8Array.of(1, 2, 3),
        'file-report.dat': '%PDF-report',
        'library_files.json': JSON.stringify([
            { file_id: 'file-image', file_name: 'photo.png', mime_type: 'image/png' },
            { file_id: 'file-report', file_name: 'report.pdf', mime_type: 'application/pdf', origination_thread_id: row.id },
        ]),
    }), CHATGPT_ACCOUNT.id);
    assert.equal(result.missingAssets, 0);
    const detail = ports.details[0].detail;
    assert.equal(detail.assets.length, 4);
    assert.equal(detail.messages[1].content.at(-1)?.type, 'file');
    assert.ok(detail.assets.some(asset => asset.name === 'report.pdf'));
    assert.equal(detail.assets.some(asset => asset.sourceUri?.includes('not-a-file')), false, 'fenced code remains literal');
});

test('different archive image paths never collapse after resource-ID sanitization', async () => {
    const row = conversation();
    row.mapping.a.message.content.parts = ['![one](a+b.png) ![two](a_b.png)'];
    await importOpenAI(await fixture([row], { 'a+b.png': 'one', 'a_b.png': 'two' }), CHATGPT_ACCOUNT.id);
    const assets = ports.details[0].detail.assets;
    assert.equal(new Set(assets.map(asset => asset.id)).size, assets.length);
    assert.ok(assets.some(asset => asset.sourceUri === 'a+b.png'));
    assert.ok(assets.some(asset => asset.sourceUri === 'a_b.png'));
});

test('URL decoding applies once to source references, while ambiguous filenames stay unavailable', async () => {
    const row = conversation();
    row.mapping.a.message.content.parts = ['![one](space%20name.png) ![two](literal%2520name.png) ![ambiguous](file-ambiguous)'];
    const result = await importOpenAI(await fixture([row], {
        'space name.png': 'one', 'literal%20name.png': 'two',
        'one/file-ambiguous-image.png': 'a', 'two/file-ambiguous-image.png': 'b',
    }), CHATGPT_ACCOUNT.id);
    assert.equal(result.missingAssets, 1);
    const assets = ports.details[0].detail.assets;
    assert.ok(assets.some(asset => asset.name === 'space name.png'));
    assert.ok(assets.some(asset => asset.name === 'literal%20name.png'));
});
