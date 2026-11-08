import { useIndexStorage } from './helpers/indexStorage.js';
useIndexStorage();
import type { DomainAsset } from '../src/l2/conversationDetail.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { importTakeout } from '../src/l1/imports/takeout/importTakeout.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { getDetail } from '../src/l3a/storageService.js';
import { prepareExportResources } from '../src/application/export/prepareExportResources.js';
import { buildExportFiles } from '../src/l4/packaging/index.js';

test('asset_dedup - ZIP import preserves exact image bytes and per-turn Domain ownership', async () => {
    const slot = '10000000-0000-4000-8000-000000000001';
    const id = 'chat_multi_img_123';
    const g = globalThis;
    const resources = createSourceResourceContext();
    const key = { accountId: slot, conversationId: id };
    const originalJSZip = Object.getOwnPropertyDescriptor(g, 'JSZip');
    const JSZip = require('../lib/jszip.min.js');
    Object.defineProperty(g, 'JSZip', { value: JSZip, configurable: true, writable: true });

    try {
        const zip = new JSZip();
        const images = [
            { filename: 'image-adb659a48f83024b.png', bytes: [10, 20, 30] },
            { filename: 'image-088981d4885e6166.png', bytes: [40, 50, 60] },
            { filename: 'image-b70178f36ab8ed17.png', bytes: [70, 80, 90] },
        ];
        const html = `<html><body>${images.map((image, i) => `
            <div class="outer-cell">
              <a href="https://gemini.google.com/app/${id}">Chat Multi</a>
              <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted Question ${i + 1}<br>
                Attached 1 file.<br>
                - <a href="${image.filename}">image.png</a><br>
                <p>Response ${i + 1}</p></div>
            </div>`).join('')}</body></html>`;
        zip.file('Takeout/Gemini/MyActivity.html', html);
        for (const image of images) zip.file(`Takeout/Gemini/${image.filename}`, new Uint8Array(image.bytes));
        zip.file('Takeout/Gemini/unreferenced.png', new Uint8Array([97, 98, 99]));

        const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
        const imported = await importTakeout(zipBuffer as unknown as File, slot, undefined, resources);
        assert.equal(imported.imported, 1);
        const detail = await getDetail(key);
        assert.ok(detail, 'real ZIP import must persist the admitted Domain Detail');
        assert.equal(detail.assets.length, 3, 'unreferenced files must not become Domain assets');
        const userMessages = detail.messages.filter(message => message.role === 'user');
        assert.equal(userMessages.length, images.length);
        const owned = new Set<string>();
        for (let i = 0; i < images.length; i++) {
            const ids = userMessages[i].attachmentIds || [];
            assert.strictEqual(ids.length, 1, `turn ${i + 1} must own one source image`);
            assert.strictEqual(owned.has(ids[0]), false, 'distinct source images must not share an asset ID');
            owned.add(ids[0]);
            const asset: DomainAsset | undefined = detail.assets.find(candidate => candidate.id === ids[0]);
            assert.ok(asset);
            assert.deepEqual((await resources.acquire(key, asset)).bytes, new Uint8Array(images[i].bytes),
                'each turn must resolve its exact archive bytes, not a similarly named image');
        }
        for (const sourceUri of ['image.png', 'unreferenced.png']) {
            await assert.rejects(resources.acquire(key, { id: '', kind: 'image', sourceUri }), /No supported source locator/,
                'generic or unused archive names must not select a sibling resource');
        }
    } finally {
        resources.release();
        if (originalJSZip) Object.defineProperty(g, 'JSZip', originalJSZip);
        else Reflect.deleteProperty(g, 'JSZip');
    }
});

test('asset_dedup - resource preparation and Packaging preserve sliced buffer bounds', async () => {
    const slab = new Uint8Array([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    const prepared = await prepareExportResources([{ id: 'sliced', kind: 'image', mediaType: 'image/png' }],
        new Set(['sliced']), async () => ({ bytes: new Uint8Array(slab.buffer, 3, 4) }));
    const files = buildExportFiles('markdown', {
        fileName: 'chat.md', resources: { sliced: 'assets/sliced.png' }, externalResourceIds: new Set(['sliced']),
    }, 'conversation', prepared);
    const resource = files.find(file => file.fileName === 'assets/sliced.png');
    assert.ok(resource?.content instanceof Uint8Array);
    assert.equal(resource.content.byteLength, 4);
    assert.deepEqual(Array.from(resource.content), [30, 40, 50, 60]);
});
