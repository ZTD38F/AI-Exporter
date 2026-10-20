export {};
const test = require('node:test');
const assert = require('node:assert/strict');
const AssetPipeline = require('../src/core/engine/assetPipeline.js').default;

test('search image export downloads from extension origin and writes actual image bytes', async () => {
    const originalFetch = globalThis.fetch;
    const requests: any[] = [];
    const writes: any[] = [];
    globalThis.fetch = async (url: any, init: any) => {
        requests.push({ url, init });
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
    };
    try {
        const pipeline = new AssetPipeline({ useZip: false,
            writeFileDirect: async (path: string, bytes: any) => writes.push({ path, bytes }),
            fetchAssetDelegate: async () => { throw new Error('must not use page CORS fetch'); }
        });
        const result = await pipeline.processAsset({ sourceUrl: 'http://encrypted-tbn2.gstatic.com/licensed-image?q=test',
            localName: 'assets/search.png' }, { id: 'chat' }, { isImage: true, maxRetries: 0 });
        assert.equal(result.saved, true);
        assert.equal(requests[0].url, 'https://encrypted-tbn2.gstatic.com/licensed-image?q=test');
        assert.equal(requests[0].init.credentials, 'omit');
        assert.equal(writes[0].path, 'assets/search.png');
        assert.deepEqual(Array.from(writes[0].bytes), [1, 2, 3]);
    } finally { globalThis.fetch = originalFetch; }
});


test('missing search images retain HTTP errors and never write a fake successful asset', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('', { status: 404 });
    try {
        const pipeline = new AssetPipeline({ useZip: false,
            writeFileDirect: async () => { throw new Error('must not write missing images'); },
            fetchAssetDelegate: async () => ({ success: false, error: 'Failed to fetch' })
        });
        const result = await pipeline.processAsset({ sourceUrl: 'https://encrypted-tbn2.gstatic.com/licensed-image?q=missing',
            localName: 'assets/missing.png' }, { id: 'chat' }, { isImage: true, maxRetries: 0 });
        assert.equal(result.saved, false);
        assert.match(result.failReason, /HTTP 404/);
    } finally { globalThis.fetch = originalFetch; }
});
