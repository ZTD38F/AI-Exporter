/**
 * V2 native Live Save media coverage: L2 asset IDs -> L3b AST -> Application
 * acquisition -> L4 relative paths/FsWriter -> one committed ExportRecord.
 * Legacy coordinator injection, DOM reparse and mock AssetPipeline are retired.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLiveSave } from '../src/runtime/background/liveSaveHandler.js';
import { readConversation } from '../src/l2/readConversation.js';
import { getExportRecord } from '../src/l3a/storageService.js';
import { FsWriter } from '../src/l4/delivery/writers/fsWriter.js';
import { liveKey, seedLiveDetail, v2LiveSaveHost } from './helpers/v2LiveSaveHost.js';

const paragraph = (text: string) => ({ type: 'paragraph' as const, children: [{ type: 'text' as const, text }] });
const entries = (files: Map<string, string | Uint8Array>) => [...files.entries()];
function mainMarkdown(files: Map<string, string | Uint8Array>): string {
    const item = entries(files).find(([name]) => name.endsWith('.md') && !name.startsWith('files/'));
    assert.ok(item);
    assert.equal(typeof item[1], 'string');
    return item[1] as string;
}

test('v2 Live Save preserves user-upload and generated Imagen bytes as distinct resources with Markdown relative links', async t => {
    const host = v2LiveSaveHost(t);
    const id = '1122334455667788';
    const userUrl = 'https://lh3.googleusercontent.com/user-photo-123';
    const modelUrl = 'https://lh3.googleusercontent.com/generated-photo-456';
    const upload = Uint8Array.of(1, 2, 3, 4, 5);
    const generated = Uint8Array.of(6, 7, 8, 9, 10, 11);
    const assets = [
        { id: 'uploaded', kind: 'image' as const, name: 'cute-cat.jpg', sourceUri: userUrl, mediaType: 'image/jpeg' },
        { id: 'imagen', kind: 'image' as const, name: 'cyberpunk-cat.png', sourceUri: modelUrl,
            mediaType: 'image/png', generation: { prompt: 'Make this cat cyberpunk', imageOrdinal: 0, imageCount: 1 } },
    ];
    await seedLiveDetail(id, assets, { title: 'Multimodal Cat & Cyberpunk Art', messages: [
        { role: 'user', content: [paragraph('Enhance this cat photo'),
            { type: 'image', assetId: 'uploaded', alt: 'Cat upload' }] },
        { role: 'assistant', content: [paragraph('Here is the generated cat'),
            { type: 'image', assetId: 'imagen', alt: 'Generated cyberpunk cat' }] },
    ] });
    const before = await readConversation(liveKey(id));
    host.source(userUrl, upload, 'image/jpeg');
    host.source(modelUrl, generated, 'image/png');

    const result = await runLiveSave(liveKey(id));
    assert.equal(result?.exported, 1);
    assert.equal(result?.partial, 0);
    assert.deepEqual(result?.failed, []);
    assert.deepEqual(host.requests, [userUrl, modelUrl]);
    const imageFiles = entries(host.files).filter(([name]) => name.startsWith('assets/'));
    assert.equal(imageFiles.length, 2);
    const savedUser = imageFiles.find(([name]) => name.endsWith('cute-cat.jpg'));
    const savedModel = imageFiles.find(([name]) => name.endsWith('cyberpunk-cat.png'));
    assert.ok(savedUser && savedModel);
    assert.deepEqual(savedUser[1], upload);
    assert.deepEqual(savedModel[1], generated);
    assert.notEqual(savedUser[0], savedModel[0]);
    const markdown = mainMarkdown(host.files);
    assert.ok(markdown.includes(savedUser[0]));
    assert.ok(markdown.includes(savedModel[0]));
    assert.doesNotMatch(markdown, /https:\/\/lh3\.googleusercontent\.com/);
    assert.match(markdown, /Enhance this cat photo/);
    assert.match(markdown, /Here is the generated cat/);
    assert.equal((await getExportRecord(liveKey(id)))?.status, 'ok');
    assert.deepEqual(await readConversation(liveKey(id)), before, 'task resource binding cannot mutate persisted Domain facts');
});

test('v2 Live Save renders failed image visibly as unavailable without a dangling sidecar or remote image embedding', async t => {
    const host = v2LiveSaveHost(t), id = 'failing-images';
    const good = 'https://example.test/good.png', bad = 'https://example.test/broken.png';
    await seedLiveDetail(id, [
        { id: 'good', kind: 'image', name: 'good.png', sourceUri: good, mediaType: 'image/png' },
        { id: 'broken', kind: 'image', name: 'broken.png', sourceUri: bad, mediaType: 'image/png' },
    ]);
    const bytes = Uint8Array.of(91, 92, 93);
    host.source(good, bytes);
    host.source(bad, null);
    const result = await runLiveSave(liveKey(id));
    assert.equal(result?.exported, 1);
    assert.equal(result?.partial, 1);
    assert.equal((await getExportRecord(liveKey(id)))?.status, 'partial');
    assert.deepEqual(host.requests, [good, bad]);
    const imageFiles = entries(host.files).filter(([name]) => name.startsWith('assets/'));
    assert.equal(imageFiles.length, 1);
    assert.deepEqual(imageFiles[0][1], bytes);
    const markdown = mainMarkdown(host.files);
    assert.ok(markdown.includes(imageFiles[0][0]));
    assert.match(markdown, /\[Open source\]\(https:\/\/example\.test\/broken\.png\)/);
    assert.doesNotMatch(markdown, /!\[[^\]]*\]\(https:/);
    assert.doesNotMatch(markdown, /\]\(assets\/[^)]*broken\.png\)/,
        'failed media may have a visible placeholder but never a missing relative file link');
    assert.match(markdown, /broken\.png|Image unavailable/i);
});

test('L3b reference dedup means one source fetch and sidecar despite multiple image occurrences', async t => {
    const host = v2LiveSaveHost(t), id = 'repeated-image', url = 'https://example.test/same.png';
    await seedLiveDetail(id, [{ id: 'same', kind: 'image', name: 'same.png', sourceUri: url, mediaType: 'image/png' }], {
        messages: [
            { role: 'user', content: [paragraph('Please explain this diagram')] },
            { role: 'assistant', content: [paragraph('Repeated illustration'),
                { type: 'image', assetId: 'same' }, { type: 'image', assetId: 'same' }] },
        ],
    });
    host.source(url, Uint8Array.of(1, 3, 3, 7));
    const result = await runLiveSave(liveKey(id));
    assert.equal(result?.partial, 0);
    assert.equal(result?.exported, 1);
    assert.deepEqual(host.requests, [url]);
    const [asset] = entries(host.files).filter(([name]) => name.startsWith('assets/'));
    assert.ok(asset);
    assert.equal(entries(host.files).filter(([name]) => name.startsWith('assets/')).length, 1);
    assert.equal(mainMarkdown(host.files).split(asset[0]).length - 1, 2);
});

test('L4 FsWriter serializes concurrent writes targeting the same physical path', async () => {
    const order: string[] = [];
    let unblock!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { unblock = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    let current = '', createCount = 0;
    const directory = {
        async queryPermission() { return 'granted'; },
        async getFileHandle(name: string) {
            assert.equal(name, 'same-file.md');
            const ordinal = ++createCount;
            return { async createWritable() { return {
                async write(content: string) {
                    order.push('start:' + content);
                    if (ordinal === 1) { started(); await waiting; }
                    current = content;
                    order.push('end:' + content);
                },
                async close() { order.push('close:' + ordinal); },
            }; } };
        },
    } as unknown as FileSystemDirectoryHandle;
    const writer = new FsWriter(directory);
    await writer.init();
    const first = writer.writeFile('same-file.md', 'first');
    await entered;
    const second = writer.writeFile('same-file.md', 'second');
    unblock();
    assert.deepEqual(await Promise.all([first, second]), ['same-file.md', 'same-file.md']);
    assert.deepEqual(order, ['start:first', 'end:first', 'close:1', 'start:second', 'end:second', 'close:2']);
    assert.equal(current, 'second');
});

