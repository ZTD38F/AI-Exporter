// tests/b1_writer_unified.test.ts - Phase B (B1): 导出统一出口验收
//
// 覆盖：
//  1. 10 张 PNG 经 AssetPipeline -> ZipWriter 落盘：totalBytes 含附件、compression=STORE
//  2. 200MB 上限：1MB x 300 附件触发 throw
//  3. takeout fallback 统一走 writer.writeFile
//  4. sessionRecovery.writeIndexAndMeta / writeDiagnostics 统一收口到 writer（含无 writer 时 fail-closed）

const test = require('node:test');
const assert = require('node:assert');

const { AssetPipeline } = require('../src/core/engine/assetPipeline.js');
const { ZipWriter } = require('../src/core/engine/writers/zipWriter.js');
const { writeIndexAndMeta, writeDiagnostics } = require('../src/core/engine/export/sessionRecovery.js');
const { __setModuleOverride } = require('../src/core/utils/moduleOverrides.js');

// 记录每次 folder.file(path, content, opts) 的文件级 opts，用于断言压缩决策
const capturedFileOpts: Record<string, any> = {};
function clearCaptured() {
    for (const k of Object.keys(capturedFileOpts)) delete capturedFileOpts[k];
}

__setModuleOverride('JSZip', class MockJSZip {
    files: Record<string, any> = {};
    folder(_name: string) {
        return {
            file: (path: string, content: any, opts: any) => {
                this.files[path] = content;
                capturedFileOpts[path] = opts || {};
            }
        };
    }
    async generateAsync(_opts?: any) {
        return new Blob(['mock-zip']);
    }
});

test('B1 - 10 张 PNG 经 writer 落盘：totalBytes 含附件且 compression=STORE', async () => {
    clearCaptured();
    const writer = new ZipWriter('test_export');
    const pngBytes = new Uint8Array(64 * 1024); // 每张 64KB
    const pipeline = new AssetPipeline({
        writer,
        fetchAssetDelegate: async () => ({ success: true, dataBuffer: pngBytes.buffer.slice(0) })
    });

    for (let i = 0; i < 10; i++) {
        const res = await pipeline.processAsset(
            { url: `https://example.com/img${i}.png`, localName: `assets/img${i}.png` },
            { id: 'c1', title: 'chat' },
            { isImage: true }
        );
        assert.strictEqual(res.saved, true, `img${i}.png should be saved, got failReason=${res.failReason}`);
    }

    assert.strictEqual(
        writer.getTotalBytes(),
        10 * 64 * 1024,
        `totalBytes must include all 10 attachments, got ${writer.getTotalBytes()}`
    );

    const pngEntries = Object.entries(capturedFileOpts).filter(([p]) => p.endsWith('.png'));
    assert.strictEqual(pngEntries.length, 10, `expected 10 png files, got ${pngEntries.length}`);
    for (const [p, opts] of pngEntries) {
        assert.strictEqual(opts.compression, 'STORE', `${p} must use STORE (precompressed), got ${opts.compression}`);
    }
});

test('B1 - 200MB 上限：1MB x 300 附件触发 throw', async () => {
    const writer = new ZipWriter('test_export');
    assert.strictEqual(writer.MAX_SAFE_ZIP_BYTES, 200 * 1024 * 1024, 'MAX_SAFE_ZIP_BYTES must stay 200MB');

    const oneMB = new Uint8Array(1024 * 1024);
    let thrown: any = null;
    let written = 0;
    try {
        for (let i = 0; i < 300; i++) {
            writer.writeFile(`assets/big_${i}.bin`, oneMB);
            written++;
        }
    } catch (e) {
        thrown = e;
    }

    assert.ok(thrown, 'must throw after exceeding the 200MB limit');
    assert.match(String((thrown as Error)?.message ?? thrown), /200MB/, 'error must mention the 200MB limit');
    // 200 x 1MB == 200MB（未超），第 201 次写才超限抛错
    assert.strictEqual(written, 200, `expected exactly 200 successful writes before the limit trips, got ${written}`);
});

test('B1 - takeout fallback 统一走 writer.writeFile', async () => {
    const written: Array<[string, any]> = [];
    const writer = {
        writeFile: async (p: string, c: any) => { written.push([p, c]); return p; }
    };
    const pipeline = new AssetPipeline({
        writer: writer as any,
        fetchAssetDelegate: async () => ({ success: false, error: 'network down' }),
        takeoutEngine: {
            getTakeoutFallbackMedia: async () => new Uint8Array([9, 9, 9])
        }
    });

    const res = await pipeline.processAsset(
        { url: 'https://example.com/f.bin', localName: 'f.bin' },
        { id: 'c9', title: 'chat' },
        { maxRetries: 0 }
    );

    assert.strictEqual(res.saved, true, `takeout fallback should save, got failReason=${res.failReason}`);
    assert.strictEqual(res.recoveredFromTakeout, true);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0][0], 'f.bin', 'takeout fallback must go through writer.writeFile');
});

test('B1 - writeIndexAndMeta 统一走 writer.writeFile', async () => {
    const written: Array<[string, any]> = [];
    const writer = {
        writeFile: async (p: string, c: any) => { written.push([p, c]); return p; }
    };
    await writeIndexAndMeta(
        [{ title: 't', exportFile: 'a.md', messageCount: 2, attachmentCount: 1, url: 'https://gemini.google.com/app/x' }],
        1, 1, 1,
        writer as any
    );
    const names = written.map(([p]) => p);
    assert.deepStrictEqual(names, ['00_INDEX.md', 'meta.json']);
    assert.ok(String(written[0][1]).includes('Gemini'), 'index content must be written');
    const metaJson = JSON.parse(String(written[1][1]));
    assert.strictEqual(metaJson.total, 1);
});

test('B1 - writeDiagnostics 统一走 writer.writeFile', async () => {
    const written: Array<[string, any]> = [];
    const writer = {
        writeFile: async (p: string, c: any) => { written.push([p, c]); return p; }
    };
    const logs: string[] = [];
    await writeDiagnostics(
        true,
        { failedChats: [{ id: 'c1' }], failedAttachments: [] },
        'LOG',
        writer as any,
        (m: string) => logs.push(m)
    );
    const names = written.map(([p]) => p);
    assert.deepStrictEqual(names, ['_export_dev.log', '_export_errors.json', '_export_session_dev.json']);
});

test('B1 - writeIndexAndMeta / writeDiagnostics 无 writer 时 fail-closed 抛错', async () => {
    const metas = [{ title: 't', exportFile: 'a.md', messageCount: 1, attachmentCount: 0, url: 'u' }];
    await assert.rejects(
        () => writeIndexAndMeta(metas, 1, 0, 0, null as any),
        /IExportWriter is required/
    );
    await assert.rejects(
        () => writeDiagnostics(false, {}, 'LOG', null as any),
        /IExportWriter is required/
    );
});
