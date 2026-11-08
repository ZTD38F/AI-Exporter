import { geminiListPage, GEMINI_LIST_CAPTURE } from './fixtures/providers/geminiListCapture.js';
import { useIndexStorage } from './helpers/indexStorage.js';
useIndexStorage();
export {};

const test = require('node:test');
const assert = require('node:assert');

test('perf - geminiClient 429 backoff retries and recovers on transient rate limit', async () => {
    const { GeminiAPIClient } = require('../src/l1/client/gemini/geminiClient.js');
    const client = new GeminiAPIClient();

    const originalFetch = (global as any).fetch;
    let callCount = 0;
    const recordedDelays: number[] = [];

    const originalSetTimeout = (global as any).setTimeout;
    (global as any).setTimeout = (fn: any, delay: any) => {
        recordedDelays.push(delay);
        return originalSetTimeout(fn, 1);
    };

    try {
        (global as any).fetch = async (_url: any, _opts: any) => {
            callCount++;
            if (callCount < 3) {
                return {
                    ok: false,
                    status: 429,
                    statusText: 'Too Many Requests',
                    headers: new Map(),
                    text: async () => 'Rate limit exceeded'
                };
            }
            return {
                ok: true,
                status: 200,
                headers: new Map(),
                text: async () => geminiListPage().responseBody
            };
        };

        const res = await client.getConversationList(null, 'test_sid', null, { maxRetries: 3 });
        assert.strictEqual(callCount, 3, 'should have retried twice and succeeded on 3rd attempt');
        assert.ok(res.conversations && res.conversations.length === GEMINI_LIST_CAPTURE.firstPageRows, 'should have parsed conversations successfully');
        assert.strictEqual(res.conversations[0].id, GEMINI_LIST_CAPTURE.first.id);
        // P1-035: getConversationList now sets a 30s timeoutMs per request, so each
        // postBatchexecute arms one 30000ms timeout timer alongside the backoff sleeps.
        const timeoutTimers = recordedDelays.filter(d => d === 30000);
        assert.strictEqual(timeoutTimers.length, 3, 'each list request should arm a 30s timeout (P1-035)');
        const backoffDelays = recordedDelays.filter(d => d !== 30000);
        assert.strictEqual(backoffDelays.length, 2, 'should have delayed twice for 429 backoff');
        assert.ok(backoffDelays[0] >= 2000, 'first delay should be >= 2000ms');
        assert.ok(backoffDelays[1] >= 4000, 'second delay should be >= 4000ms');
    } finally {
        (global as any).fetch = originalFetch;
        (global as any).setTimeout = originalSetTimeout;
    }
});

test('perf - geminiClient 429 throws after exceeding maxRetries', async () => {
    const { GeminiAPIClient } = require('../src/l1/client/gemini/geminiClient.js');
    const client = new GeminiAPIClient();

    const originalFetch = (global as any).fetch;
    const originalSetTimeout = (global as any).setTimeout;
    (global as any).setTimeout = (fn: any, _delay: any) => originalSetTimeout(fn, 1);

    let callCount = 0;
    try {
        (global as any).fetch = async () => {
            callCount++;
            return {
                ok: false,
                status: 429,
                statusText: 'Too Many Requests',
                headers: new Map(),
                text: async () => 'Rate limit exceeded'
            };
        };

        await assert.rejects(async () => {
            await client.getConversationList(null, 'test_sid', null, { maxRetries: 2 });
        }, /HTTP 429/);
        assert.strictEqual(callCount, 3, 'initial attempt + 2 retries = 3 calls total');
    } finally {
        (global as any).fetch = originalFetch;
        (global as any).setTimeout = originalSetTimeout;
    }
});

test('perf - Takeout import yields to the event loop and reports monotonic progress for 120 conversations', async (t: import('node:test').TestContext) => {
    const { importTakeout } = require('../src/l1/imports/takeout/importTakeout.js');
    const { listIndexes } = require('../src/l3a/storageService.js');
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'JSZip');
    const JSZip = require('../lib/jszip.min.js');
    Object.defineProperty(globalThis, 'JSZip', { configurable: true, value: JSZip });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'JSZip', descriptor); else Reflect.deleteProperty(globalThis, 'JSZip'); });
    const zip = new JSZip();
    zip.file('Takeout/Gemini/MyActivity.html', '<html><body>' + Array.from({ length: 120 }, (_, index) =>
        `<div class="outer-cell"><a href="https://gemini.google.com/app/takeout_${index}">Link</a><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted Question ${index}<br><p>Answer ${index}</p></div></div>`).join('') + '</body></html>');
    const reports: number[] = [];
    let yielded = false; setTimeout(() => { yielded = true; }, 0);
    const id = '10000000-0000-4000-8000-000000000001';
    const result = await importTakeout(await zip.generateAsync({ type: 'nodebuffer' }), id, (percent: number) => reports.push(percent));
    assert.strictEqual(result.imported, 120); assert.strictEqual((await listIndexes(id)).length, 120);
    assert.strictEqual(yielded, true);
    assert.strictEqual(reports[reports.length - 1], 100);
    assert.ok(reports.every((value, index) => index === 0 || value >= reports[index - 1]));
    assert.ok(reports.some(percent => percent > 70 && percent < 100));
});

test('perf - assetFetcher returns ArrayBuffer directly when preferBuffer is true', async () => {
    const { AssetFetcher } = require('../src/runtime/capabilities/assetFetcher.js');

    const originalFetch = (global as any).fetch;
    const testData = Buffer.from('fake image binary content 1234567890');
    try {
        (global as any).fetch = async () => ({
            ok: true,
            headers: new Map([['content-type', 'image/png']]),
            blob: async () => ({
                size: testData.length,
                type: 'image/png',
                arrayBuffer: async () => testData.buffer.slice(testData.byteOffset, testData.byteOffset + testData.byteLength)
            })
        });

        let responsePayload: any = null;
        await AssetFetcher.downloadAssetDirect({
            url: 'https://lh3.googleusercontent.com/test_img.png',
            preferBuffer: true
        }, (res: any) => {
            responsePayload = res;
        });

        assert.ok(responsePayload, 'should receive response');
        assert.strictEqual(responsePayload.success, true);
        assert.ok(responsePayload.dataBuffer instanceof ArrayBuffer, 'dataBuffer should be an ArrayBuffer');
        assert.strictEqual(responsePayload.dataBuffer.byteLength, testData.length);
        assert.strictEqual(responsePayload.dataBase64, undefined, 'dataBase64 should not be generated when preferBuffer is fulfilled');
    } finally {
        (global as any).fetch = originalFetch;
    }
});

test('perf - assetFetcher returns base64 when preferBuffer is false', async () => {
    const { AssetFetcher } = require('../src/runtime/capabilities/assetFetcher.js');

    const originalFetch = (global as any).fetch;
    const originalReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
    // Content Scripts have FileReader; Node does not. Mock that browser boundary,
    // not a production Buffer fallback, and use a real Blob in the response.
    class TestFileReader {
        result: string | null = null;
        error: Error | null = null;
        onloadend: (() => void) | null = null;
        onerror: (() => void) | null = null;

        readAsDataURL(blob: Blob): void {
            void blob.arrayBuffer().then(
                bytes => {
                    this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`;
                    this.onloadend?.();
                },
                (error: unknown) => {
                    this.error = error instanceof Error ? error : new Error(String(error));
                    this.onerror?.();
                }
            );
        }
    }
    Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: TestFileReader });
    const testData = Buffer.from('fake image binary content 1234567890');
    try {
        (global as any).fetch = async () => ({
            ok: true,
            headers: new Map([['content-type', 'image/png']]),
            blob: async () => new Blob([testData.toString('utf8')], { type: 'image/png' })
        });

        let responsePayload: any = null;
        await AssetFetcher.downloadAssetDirect({
            url: 'https://lh3.googleusercontent.com/test_img.png',
            preferBuffer: false
        }, (res: any) => {
            responsePayload = res;
        });

        assert.ok(responsePayload, 'should receive response');
        assert.strictEqual(responsePayload.success, true);
        assert.strictEqual(responsePayload.dataBase64, testData.toString('base64'), 'base64 must preserve actual Blob bytes');
        assert.strictEqual(responsePayload.dataBuffer, undefined, 'dataBuffer should not be generated when preferBuffer is false');
    } finally {
        (global as any).fetch = originalFetch;
        if (originalReader) Object.defineProperty(globalThis, 'FileReader', originalReader);
        else Reflect.deleteProperty(globalThis, 'FileReader');
    }
});



test('perf - runtime Tab transport times out instead of hanging an acquisition task', async (t: import('node:test').TestContext) => {
    const { sendTabMessage } = require('../src/runtime/capabilities/tabService.js');
    const host = chrome;
    const previous = Object.getOwnPropertyDescriptor(host, 'tabs');
    Object.defineProperty(host, 'tabs', { configurable: true, value: { sendMessage() {} } });
    t.after(() => { if (previous) Object.defineProperty(host, 'tabs', previous); else Reflect.deleteProperty(host, 'tabs'); });
    const start = Date.now();
    await assert.rejects(sendTabMessage(12345, { action: 'getFileBlob' }, 50), /timed out/);
    assert.ok(Date.now() - start >= 45);
});
