export {};

const test = require('node:test');
const assert = require('node:assert');
const AssetFetcherModule = require('../src/content/assetFetcher.js');

const { fetchWithCredentialFallback, downloadAssetDirect, fetchGgChain, toHighRes } = AssetFetcherModule;

test('assetFetcher - toHighRes preserves gstatic.com thumbnail URLs without corrupting them', () => {
    const gstaticUrl = 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTQ9Ag43ZZiH3Vfs56ySvDFnu_p3Lx_RC_99CHpWd4i2nozwkOlerQxMFI&s=10';
    const transformed = toHighRes(gstaticUrl);
    assert.strictEqual(transformed, gstaticUrl, 'Must not append =s1024-rj to gstatic.com images');

    const lh3Url = 'https://lh3.googleusercontent.com/abc=s512?alr=yes';
    const transformedLh3 = toHighRes(lh3Url);
    assert.ok(transformedLh3.includes('=s1024-rj'), 'googleusercontent URLs should still be upgraded');
});

test('assetFetcher & attachments - bare /gg/ and /rd-gg/ URLs normalize to authoritative =s0 rendition', () => {
    const { highResVariant } = require('../src/core/api/parser/attachments.js');
    const bareGg = 'https://lh3.googleusercontent.com/gg/AN-53XYZ1234567890';
    assert.strictEqual(highResVariant(bareGg), `${bareGg}=s0`, 'highResVariant appends =s0 to bare /gg/');
    assert.strictEqual(highResVariant(`${bareGg}?authuser=0`), `${bareGg}=s0?authuser=0`, 'highResVariant preserves queries on bare /gg/');
    assert.strictEqual(highResVariant(`${bareGg}=s512-rj?authuser=0`), `${bareGg}=s0?authuser=0`, 'highResVariant replaces =s512-rj with =s0');

    assert.strictEqual(toHighRes(bareGg), `${bareGg}=s0?alr=yes`, 'toHighRes appends =s0 and ?alr=yes to bare /gg/');
    assert.strictEqual(toHighRes(`${bareGg}?authuser=0`), `${bareGg}=s0?authuser=0&alr=yes`, 'toHighRes preserves queries and ensures alr=yes');
    assert.strictEqual(toHighRes(`${bareGg}=s0`), `${bareGg}=s0?alr=yes`, 'toHighRes avoids duplicating =s0');
});

test('fetchWithCredentialFallback - include 抛 TypeError → omit 成功', async () => {
    const callLog: { url: string; credentials?: string }[] = [];

    const mockFetch = async (input: any, init?: RequestInit) => {
        const creds = init?.credentials;
        callLog.push({ url: String(input), credentials: creds });

        if (creds === 'include') {
            throw new TypeError('Failed to fetch (CORS header missing or wildcard with credentials)');
        }
        if (creds === 'omit') {
            return {
                ok: true,
                status: 200,
                headers: new Map([['content-type', 'image/png']]),
                text: async () => 'image-data'
            } as any;
        }
        throw new Error(`Unexpected credentials: ${creds}`);
    };

    const res = await fetchWithCredentialFallback(
        'https://encrypted-tbn0.gstatic.com/images?q=tbn:test',
        undefined,
        mockFetch as any
    );

    assert.ok(res.ok, 'Response must be ok');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(callLog.length, 2, 'Must try include first, then fallback to omit');
    assert.strictEqual(callLog[0].credentials, 'include', '1st attempt must use credentials: include');
    assert.strictEqual(callLog[1].credentials, 'omit', '2nd attempt must use credentials: omit');
});

test('fetchWithCredentialFallback - include 成功 → 不产生第二次请求', async () => {
    const callLog: { url: string; credentials?: string }[] = [];

    const mockFetch = async (input: any, init?: RequestInit) => {
        const creds = init?.credentials;
        callLog.push({ url: String(input), credentials: creds });
        return {
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'image/png']])
        } as any;
    };

    const res = await fetchWithCredentialFallback(
        'https://encrypted-tbn0.gstatic.com/images?q=tbn:test',
        undefined,
        mockFetch as any
    );

    assert.ok(res.ok);
    assert.strictEqual(callLog.length, 1, 'When include succeeds, must not attempt second request');
    assert.strictEqual(callLog[0].credentials, 'include');
});

test('fetchWithCredentialFallback - include/omit 都失败 → 保持当前失败语义', async () => {
    const callLog: { url: string; credentials?: string }[] = [];

    const mockFetch = async (input: any, init?: RequestInit) => {
        const creds = init?.credentials;
        callLog.push({ url: String(input), credentials: creds });
        throw new TypeError('Network connection reset');
    };

    await assert.rejects(
        async () => {
            await fetchWithCredentialFallback(
                'https://broken.host/image.png',
                undefined,
                mockFetch as any
            );
        },
        {
            name: 'TypeError',
            message: 'Network connection reset'
        },
        'Must rethrow original error when both attempts fail'
    );

    assert.strictEqual(callLog.length, 2, 'Must try include then omit before failing');
    assert.strictEqual(callLog[0].credentials, 'include');
    assert.strictEqual(callLog[1].credentials, 'omit');
});

test('fetchWithCredentialFallback - private/authenticated URL 仍能使用 include 成功', async () => {
    const callLog: { url: string; credentials?: string }[] = [];
    const authUrl = 'https://bard-storage.google.com/private/signed_token_asset.png';

    const mockFetch = async (input: any, init?: RequestInit) => {
        const creds = init?.credentials;
        callLog.push({ url: String(input), credentials: creds });
        if (creds !== 'include') {
            return { ok: false, status: 401 } as any;
        }
        return {
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'image/png']])
        } as any;
    };

    const res = await fetchWithCredentialFallback(
        authUrl,
        { credentials: 'include' },
        mockFetch as any
    );

    assert.ok(res.ok);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(callLog.length, 1);
    assert.strictEqual(callLog[0].credentials, 'include');
});

test('downloadAssetDirect - transparently downloads CORS-restricted asset via omit fallback', async () => {
    const origFetch = (global as any).fetch;
    const fetchAttempts: string[] = [];

    try {
        (global as any).fetch = async (url: string, init?: RequestInit) => {
            fetchAttempts.push(init?.credentials || 'none');
            if (init?.credentials === 'include') {
                throw new TypeError('Failed to fetch');
            }
            if (init?.credentials === 'omit') {
                const sampleBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4]);
                return {
                    ok: true,
                    status: 200,
                    headers: new Map([['content-type', 'image/png']]),
                    blob: async () => ({
                        size: sampleBytes.length,
                        type: 'image/png',
                        arrayBuffer: async () => sampleBytes.buffer
                    })
                };
            }
            throw new Error(`Unexpected credentials: ${init?.credentials}`);
        };

        let result: any = null;
        await downloadAssetDirect(
            {
                url: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTest',
                preferBuffer: true
            },
            (resp: any) => {
                result = resp;
            }
        );

        assert.ok(result, 'Must receive downloadAssetDirect response');
        assert.strictEqual(result.success, true, 'Download must succeed via fallback');
        assert.ok(result.dataBuffer, 'Must return dataBuffer');
        assert.strictEqual(result.size, 8);
        assert.strictEqual(fetchAttempts[0], 'include', 'First try must include credentials');
        assert.strictEqual(fetchAttempts[1], 'omit', 'Second try must omit credentials');
    } finally {
        (global as any).fetch = origFetch;
    }
});

test('handleGetImageBlob - bare /gg/<token> requests =s0 rendition and downloads native resolution buffer', async () => {
    const { handleGetImageBlob } = AssetFetcherModule;
    const origFetch = (global as any).fetch;
    const requestedUrls: string[] = [];
    try {
        const nativeBytes = Buffer.alloc(230904, 0x42); // 1408x768 native payload
        (global as any).fetch = async (input: any, init?: RequestInit) => {
            const url = String(input);
            requestedUrls.push(url);
            return {
                ok: true,
                status: 200,
                headers: new Map([['content-type', 'image/jpeg']]),
                clone: () => ({ blob: async () => ({ type: 'image/jpeg' }) }),
                blob: async () => ({
                    size: nativeBytes.length,
                    type: 'image/jpeg',
                    arrayBuffer: async () => nativeBytes.buffer
                })
            };
        };

        let result: any = null;
        await handleGetImageBlob(
            {
                url: 'https://lh3.googleusercontent.com/gg/AN-53XYZ1234567890',
                preferBuffer: true
            },
            (resp: any) => { result = resp; }
        );

        assert.ok(result?.success, 'handleGetImageBlob must succeed');
        assert.ok(requestedUrls.length > 0, 'Must have initiated fetch');
        assert.ok(requestedUrls[0].includes('=s0'), `Must request =s0 rendition, got: ${requestedUrls[0]}`);
        assert.ok(requestedUrls[0].includes('alr=yes'), `Must include alr=yes, got: ${requestedUrls[0]}`);
        assert.strictEqual(result.size, 230904, 'Must return native size (not preview 69036)');
    } finally {
        (global as any).fetch = origFetch;
    }
});
