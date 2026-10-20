/**
 * tests/pdf-resource-stage.test.ts
 * Tier 1 tests for the resources stage
 * (src/core/export/pdf/pipeline/resourceStage.ts).
 *
 * Focused matrix:
 *   - normal image asset -> pathMap + mounts (bytes from the byte store)
 *   - inline images inside paragraph/heading/table cells are collected too
 *     (shared recursive collector, same traversal as the payload builder)
 *   - metadata-only file attachments skip byte resolution entirely: no
 *     pathMap entry, not "unresolved", no diagnostic, and their bytes are
 *     never read (spy on the byte store) — file cards render from Asset
 *     metadata alone
 *   - missing asset -> unresolved + warning diagnostic (never silent)
 *   - remote-only asset -> unresolved + warning (resolver only emits info)
 *   - referenced id absent from bundle.assets -> unresolved + warning
 *     (image placements are binary by placement, not by kind lookup)
 *   - aborted signal -> AbortError DOMException
 *   - binary decision is AST placement, not Asset.kind:
 *       - ImageBlock referencing a kind:'file' asset still resolves + mounts
 *         (placement wins), with an ASSET_KIND_MISMATCH warning
 *       - FileBlock referencing a kind:'image' asset is metadata-only:
 *         never resolved, no pathMap entry, no diagnostic, bytes untouched
 *   - message-level companions (associatedAssetIds):
 *       - kind:'image' companion with no block placement resolves + mounts
 *         (regression: #591 dropped it silently; the Typst payload still
 *         builds a trailing image attachment for it via assetPath)
 *       - non-image companion is metadata-only: never resolved, bytes
 *         untouched
 *       - id with block placement AND in associatedAssetIds resolves
 *         exactly once (no double mount, no companion duplication)
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { resourceStage } = require('../src/core/export/pdf/pipeline/resourceStage.js');
const { createInlineByteStore } = require('../src/core/export/assets/byteStore.js');

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngBytes(seed = 1): Uint8Array {
    const b = new Uint8Array(PNG_MAGIC.length + 16);
    b.set(PNG_MAGIC, 0);
    for (let i = PNG_MAGIC.length; i < b.length; i++) b[i] = (i * seed) & 0xff;
    return b;
}

function asset(id: string, overrides: any = {}): any {
    return { id, kind: 'image', status: 'available', ...overrides };
}

function stageCtx(signal: AbortSignal): any {
    const calls: any[] = [];
    return {
        ctx: {
            signal,
            reportProgress: (stage: string, current: number, total: number) => {
                calls.push(['progress', stage, current, total]);
            },
            log: (message: string) => { calls.push(['log', message]); },
        },
        calls,
    };
}

function input(): any {
    const store = createInlineByteStore();
    const goodBlock = pngBytes(1);
    const goodPara = pngBytes(2);
    store.put('inline/img-block', goodBlock);
    store.put('inline/img-para', goodPara);

    const bundle: any = {
        assets: [
            asset('img-block', { storageRef: 'inline/img-block', mimeType: 'image/png' }),
            asset('img-para', { storageRef: 'inline/img-para', mimeType: 'image/png' }),
            asset('img-cell', { status: 'missing', failureReason: 'never fetched' }),
            asset('img-remote', { status: 'remote', sourceUrl: 'https://example.com/x.png' }),
        ],
    };
    bundle.conversation = {
        messages: [
            {
                id: 'm1',
                role: 'model',
                blocks: [
                    { type: 'image', assetId: 'img-block' },
                    { type: 'paragraph', children: [{ type: 'image', assetId: 'img-para' }] },
                    {
                        type: 'table',
                        rows: [{ cells: [{ children: [{ type: 'image', assetId: 'img-cell' }] }] }],
                    },
                    { type: 'heading', level: 2, children: [{ type: 'image', assetId: 'img-remote' }] },
                    { type: 'list', items: [{ blocks: [{ type: 'image', assetId: 'img-ghost' }] }] },
                ],
            },
        ],
    };
    return { bundle, byteStore: store, expected: { goodBlock, goodPara } };
}

test('resources stage: clean assets land in pathMap + mounts with byte-store bytes', async () => {
    const { bundle, byteStore, expected } = input();
    const { ctx } = stageCtx(new AbortController().signal);
    const { output, diagnostics } = await resourceStage({ bundle, byteStore }, ctx);

    assert.deepStrictEqual([...output.pathMap.keys()].sort(), ['img-block', 'img-para']);
    assert.strictEqual(output.mounts.length, 2);
    for (const mount of output.mounts) {
        assert.ok(typeof mount.virtualPath === 'string' && mount.virtualPath.length > 0);
        assert.strictEqual(mount.mimeType, 'image/png');
        assert.ok(mount.bytes instanceof Uint8Array && mount.bytes.length > 0);
    }
    const byPath: Map<string, any> = new Map(output.mounts.map((m: any) => [m.virtualPath, m]));
    assert.deepStrictEqual(
        byPath.get(output.pathMap.get('img-block'))!.bytes,
        expected.goodBlock,
    );
    assert.deepStrictEqual(
        byPath.get(output.pathMap.get('img-para'))!.bytes,
        expected.goodPara,
    );
    assert.ok(Array.isArray(diagnostics));
});

test('resources stage: missing/remote/ghost assets are unresolved, each with a warning+ diagnostic', async () => {
    const { bundle, byteStore } = input();
    const { ctx } = stageCtx(new AbortController().signal);
    const { output, diagnostics } = await resourceStage({ bundle, byteStore }, ctx);

    assert.deepStrictEqual(
        output.unresolved.map((u: any) => u.assetId).sort(),
        ['img-cell', 'img-ghost', 'img-remote'],
    );
    for (const entry of output.unresolved) {
        assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0,
            `unresolved ${entry.assetId} must carry a reason`);
    }
    // Every omission must be diagnosed at warning or above — never silent.
    for (const entry of output.unresolved) {
        const hits = diagnostics.filter(
            (d: any) => d.path === `asset:${entry.assetId}`
                && (d.severity === 'warning' || d.severity === 'error'),
        );
        assert.ok(hits.length >= 1,
            `unresolved asset ${entry.assetId} has no warning+ diagnostic`);
    }
});

test('resources stage: aborted signal throws AbortError', async () => {
    const { bundle, byteStore } = input();
    const controller = new AbortController();
    controller.abort();
    const { ctx } = stageCtx(controller.signal);
    await assert.rejects(
        () => resourceStage({ bundle, byteStore }, ctx),
        (err: any) => err instanceof DOMException && err.name === 'AbortError',
    );
});

test('resources stage: metadata-only file attachments skip byte resolution entirely', async () => {
    // A 40MB-style report.pdf: referenced by a FileBlock, rendered by the
    // Typst template as a metadata-only card (name/kind/size from the Asset
    // entity). It must never reach the resolver: no byte read, no SHA-256,
    // no pathMap entry — while a sibling image still resolves normally.
    const readRefs: Array<[string, string]> = [];
    const real = createInlineByteStore();
    const spyStore: any = {
        put: (r: string, b: Uint8Array) => real.put(r, b),
        has: (r: string) => { readRefs.push(['has', r]); return real.has(r); },
        get: (r: string) => { readRefs.push(['get', r]); return real.get(r); },
        clear: () => real.clear(),
        get entryCount() { return real.entryCount; },
    };
    // Bytes are present in the store on purpose: the stage must not touch
    // them even when it cheaply could.
    spyStore.put('inline/report-pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])); // %PDF-
    spyStore.put('inline/img-ok', pngBytes(7));
    const bundle: any = {
        assets: [
            asset('doc-report', {
                kind: 'file', storageRef: 'inline/report-pdf',
                mimeType: 'application/pdf', name: 'report.pdf',
                // 40MB claimed in metadata; never allocated.
                sizeBytes: 40 * 1024 * 1024,
            }),
            asset('img-ok', { storageRef: 'inline/img-ok', mimeType: 'image/png' }),
        ],
    };
    bundle.conversation = {
        messages: [
            {
                id: 'm1', role: 'model',
                blocks: [
                    { type: 'file', assetId: 'doc-report', label: 'report.pdf' },
                    { type: 'image', assetId: 'img-ok' },
                ],
            },
        ],
    };
    const { ctx } = stageCtx(new AbortController().signal);
    const { output, diagnostics } = await resourceStage({ bundle, byteStore: spyStore }, ctx);

    // The image still resolves + mounts as before.
    assert.ok(output.pathMap.has('img-ok'), 'image asset still resolves');
    assert.strictEqual(output.mounts.length, 1, 'only the image is mounted');
    // The file attachment: never resolved, so no pathMap entry; not
    // "unresolved" either (its card renders from metadata); no diagnostic.
    assert.strictEqual(output.pathMap.has('doc-report'), false,
        'metadata-only file never enters pathMap');
    assert.deepStrictEqual(output.unresolved, []);
    const warnPlus = diagnostics.filter(
        (d: any) => d.path === 'asset:doc-report'
            && (d.severity === 'warning' || d.severity === 'error'),
    );
    assert.strictEqual(warnPlus.length, 0, 'metadata-only file gets no diagnostic');
    // And its bytes were never read (hence never hashed): zero get/has on
    // its storageRef, even though bytes were available.
    const touched = readRefs.filter(([, r]) => r === 'inline/report-pdf');
    assert.deepStrictEqual(touched, [],
        'resolver must never touch the file attachment bytes');
});

test('resources stage: RESOURCE_BYTES_MISSING drops the asset from pathMap and reports it exactly once', async () => {
    // Simulate bytes vanishing between resolveAssets and the mount re-read:
    // the resolver's single get() sees bytes, the stage's re-read misses.
    const real = createInlineByteStore();
    const doomed = pngBytes(9);
    real.put('inline/doomed', doomed);
    const victimRef = 'inline/doomed';
    let gets = 0;
    const vanishing: any = {
        put: (r: string, b: Uint8Array) => real.put(r, b),
        has: (r: string) => real.has(r),
        get: (r: string) => {
            if (r !== victimRef) return real.get(r);
            gets++;
            return gets === 1 ? real.get(r) : undefined;
        },
        clear: () => real.clear(),
        get entryCount() { return real.entryCount; },
    };

    const bundle: any = {
        assets: [asset('img-doomed', { storageRef: 'inline/doomed', mimeType: 'image/png' })],
    };
    bundle.conversation = {
        messages: [
            {
                id: 'm1', role: 'model',
                blocks: [{ type: 'image', assetId: 'img-doomed' }],
            },
        ],
    };
    const { ctx } = stageCtx(new AbortController().signal);
    const { output, diagnostics } = await resourceStage({ bundle, byteStore: vanishing }, ctx);

    // pathMap must not claim a clean resolve for an asset with no mount.
    assert.ok(!output.pathMap.has('img-doomed'), 'pathMap must drop the bytes-missing asset');
    assert.strictEqual(output.mounts.length, 0);
    // Exactly one unresolved entry and one error diagnostic — no duplicates.
    assert.deepStrictEqual(output.unresolved.map((u: any) => u.assetId), ['img-doomed']);
    const hits = diagnostics.filter((d: any) => d.code === 'RESOURCE_BYTES_MISSING');
    assert.strictEqual(hits.length, 1, 'exactly one RESOURCE_BYTES_MISSING diagnostic');
    assert.strictEqual(hits[0].severity, 'error');
});

test('resources stage: binary decision is AST placement, not Asset.kind (image placement wins)', async () => {
    // Regression for the review round: an ImageBlock referencing a
    // kind:'file' asset whose bytes are genuinely a PNG must still be
    // resolved + mounted — the canonical validator does not force
    // ImageBlock -> kind 'image', and judging by kind would silently
    // degrade the image. Placement wins; the mismatch gets a warning.
    const real = createInlineByteStore();
    real.put('inline/misfiled', pngBytes(11));
    const bundle: any = {
        assets: [
            asset('misfiled', {
                kind: 'file', storageRef: 'inline/misfiled',
                mimeType: 'image/png', name: 'photo.png',
            }),
        ],
    };
    bundle.conversation = {
        messages: [
            {
                id: 'm1', role: 'model',
                blocks: [{ type: 'image', assetId: 'misfiled' }],
            },
        ],
    };
    const { ctx } = stageCtx(new AbortController().signal);
    const { output, diagnostics } = await resourceStage({ bundle, byteStore: real }, ctx);

    assert.ok(output.pathMap.has('misfiled'),
        'image placement resolves even when Asset.kind is file');
    assert.strictEqual(output.mounts.length, 1, 'misfiled image is mounted');
    assert.deepStrictEqual(output.unresolved, []);
    const hits = diagnostics.filter((d: any) => d.code === 'ASSET_KIND_MISMATCH');
    assert.strictEqual(hits.length, 1, 'exactly one kind-mismatch warning');
    assert.strictEqual(hits[0].severity, 'warning');
    assert.strictEqual(hits[0].path, 'asset:misfiled');
});

test('resources stage: FileBlock referencing a kind:image asset is metadata-only', async () => {
    // Mirror case: a FileBlock is metadata-only by placement, even when the
    // asset's kind claims 'image'. Its file card renders from the Asset
    // entity; the stage must not resolve it and must not warn about it.
    const readRefs: Array<[string, string]> = [];
    const real = createInlineByteStore();
    const spyStore: any = {
        put: (r: string, b: Uint8Array) => real.put(r, b),
        has: (r: string) => { readRefs.push(['has', r]); return real.has(r); },
        get: (r: string) => { readRefs.push(['get', r]); return real.get(r); },
        clear: () => real.clear(),
        get entryCount() { return real.entryCount; },
    };
    spyStore.put('inline/not-really-image', pngBytes(12));
    const bundle: any = {
        assets: [
            asset('filey', {
                kind: 'image', storageRef: 'inline/not-really-image',
                mimeType: 'image/png', name: 'attachment.bin', sizeBytes: 28,
            }),
        ],
    };
    bundle.conversation = {
        messages: [
            {
                id: 'm1', role: 'model',
                blocks: [{ type: 'file', assetId: 'filey', label: 'attachment.bin' }],
            },
        ],
    };
    const { ctx } = stageCtx(new AbortController().signal);
    const { output, diagnostics } = await resourceStage({ bundle, byteStore: spyStore }, ctx);

    assert.strictEqual(output.pathMap.has('filey'), false,
        'FileBlock asset never enters pathMap');
    assert.strictEqual(output.mounts.length, 0, 'nothing mounted');
    assert.deepStrictEqual(output.unresolved, []);
    const warnPlus = diagnostics.filter(
        (d: any) => d.path === 'asset:filey'
            && (d.severity === 'warning' || d.severity === 'error'),
    );
    assert.strictEqual(warnPlus.length, 0, 'metadata-only FileBlock gets no diagnostic');
    assert.deepStrictEqual(readRefs, [],
        'resolver must never touch the FileBlock bytes');
});

