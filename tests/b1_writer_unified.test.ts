// Retained writer behaviors on V2 Packaging and task-owned resource acquisition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ZipWriter } from '../src/l4/packaging/writers/zipWriter.js';
import { buildExportFiles, packageExportFiles } from '../src/l4/packaging/index.js';
import { prepareExportResources } from '../src/application/export/prepareExportResources.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { __setZipConstructor, __getZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';
import type { WriteFileContent, WriteFileOptions } from '../src/l4/delivery/writers/writerInterface.js';

const captured = new Map<string, { content: WriteFileContent; options: WriteFileOptions }>();
class MockJSZip {
    file(path: string, content: WriteFileContent, options: WriteFileOptions) { captured.set(path, { content, options }); }
    async generateAsync() { return new Blob(['mock-zip']); }
}
let previousJSZip: ReturnType<typeof __getZipConstructor>;
test.beforeEach(() => { previousJSZip = __getZipConstructor(); captured.clear(); __setZipConstructor(MockJSZip); });
test.afterEach(() => { __setZipConstructor(previousJSZip); });

test('B1 - 10 PNG resources pass through Packaging and writer with byte accounting and STORE compression', async () => {
    const assets = Array.from({ length: 10 }, (_, i) => ({ id: `image-${i}`, kind: 'image' as const }));
    const required = new Set(assets.map(asset => asset.id));
    const bytes = new Uint8Array(64 * 1024);
    const prepared = await prepareExportResources(assets, required, async () => ({ bytes }));
    const files = buildExportFiles('markdown', { fileName: 'chat.md',
        resources: Object.fromEntries(assets.map((asset, i) => [asset.id, `assets/img${i}.png`])),
        externalResourceIds: required }, 'body', prepared);
    const writer = new ZipWriter();
    writer.MAX_SAFE_ZIP_BYTES = 4 + 10 * bytes.byteLength;
    for (const file of files) writer.writeFile(file.fileName, file.content);
    assert.throws(() => writer.writeFile('assets/overflow.bin', new Uint8Array([0])), /上限/);
    assert.equal(captured.size, 11);
    assert.equal(captured.has('assets/overflow.bin'), false);
    for (const [path, entry] of captured) assert.equal(entry.options.compression, path.endsWith('.png') ? 'STORE' : 'DEFLATE');
});
test('B1 - 200MB limit rejects the 201st one-MB resource before writing it', () => {
    const writer = new ZipWriter(), bytes = new Uint8Array(1024 * 1024);
    assert.equal(writer.MAX_SAFE_ZIP_BYTES, 200 * 1024 * 1024);
    for (let i = 0; i < 200; i++) writer.writeFile(`assets/big_${i}.bin`, bytes);
    assert.throws(() => writer.writeFile('assets/big_200.bin', bytes), /200MB/);
    assert.equal(captured.size, 200);
});
test('B1 - task-owned Takeout bytes flow through the same Packaging writer without a network request', async () => {
    const context = createSourceResourceContext();
    const key = { accountId: '10000000-0000-4000-8000-000000000001', conversationId: 'chat' };
    const asset = { id: 'takeout', kind: 'file' as const };
    try {
        context.retain(key, asset.id, async () => ({ bytes: new Uint8Array([9, 9, 9]) }));
        const prepared = await prepareExportResources([asset], new Set([asset.id]), candidate => context.acquire(key, candidate));
        const files = buildExportFiles('markdown', { fileName: 'chat.md', resources: { takeout: 'files/f.bin' },
            externalResourceIds: new Set([asset.id]) }, 'body', prepared);
        await packageExportFiles([files], 'browserDownload');
        assert.deepEqual(captured.get('files/f.bin')?.content, new Uint8Array([9, 9, 9]));
    } finally { context.release(); }
});
test('B1 - Packaging emits only declared conversation artifacts without retired session metadata', async () => {
    await packageExportFiles([[{ fileName: 'a.md', content: 'A', mimeType: 'text/markdown' }],
        [{ fileName: 'b.md', content: 'B', mimeType: 'text/markdown' }]], 'browserDownload');
    assert.deepEqual([...captured.keys()], ['a.md', 'b.md']);
});
test('B1 - empty Packaging cannot create diagnostics or session recovery artifacts', async () => {
    assert.deepEqual(await packageExportFiles([[]], 'browserDownload'), []);
    assert.equal(captured.size, 0);
});
test('B1 - unavailable bound resources fail closed before writer delivery', () => {
    assert.throws(() => buildExportFiles('markdown', { fileName: 'chat.md', resources: { missing: 'files/missing.bin' },
        externalResourceIds: new Set(['missing']) }, 'body', new Map()), /Bound resource unavailable/);
    assert.equal(captured.size, 0);
});
