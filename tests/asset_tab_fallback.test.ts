import test from 'node:test';
import assert from 'node:assert/strict';
import AssetPipeline from '../src/core/engine/assetPipeline.js';
import TabService from '../src/core/utils/tabService.js';

test('asset download retries another Gemini tab when the selected tab has no content-script receiver', async () => {
    const originalChrome = (globalThis as any).chrome;
    const sent: number[] = [];
    const writes: string[] = [];
    const runtime: any = { lastError: null };
    (globalThis as any).chrome = {
        runtime,
        tabs: {
            query: async () => [
                { id: 11, url: 'https://gemini.google.com/app/old', active: false },
                { id: 22, url: 'https://gemini.google.com/app/current', active: false }
            ],
            sendMessage(tabId: number, message: any, callback: (response?: any) => void) {
                sent.push(tabId);
                if (tabId === 11) {
                    runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
                    callback(undefined);
                } else {
                    callback(message.preferBuffer
                        ? { success: true, dataBuffer: {} } // Chrome message serialization drops ArrayBuffer bytes
                        : { success: true, dataBase64: 'AQID' });
                }
                runtime.lastError = null;
            }
        }
    };

    try {
        const pipeline = new AssetPipeline({
            currentSlot: 'u0',
            getGeminiTab: TabService.getGeminiTab,
            sendToGeminiTab: TabService.sendToGeminiTab,
            writer: { writeFile: async (name: string) => { writes.push(name); return name; } } as any
        });
        const result = await pipeline.processAsset(
            { url: 'https://lh3.googleusercontent.com/image', localName: 'assets/image.jpg' },
            { id: 'chat_1' },
            { isImage: true, maxRetries: 0 }
        );
        assert.deepEqual(sent, [11, 11, 22, 11, 11, 22]);
        assert.equal(result.saved, true);
        assert.deepEqual(writes, ['assets/image.jpg']);
    } finally {
        (globalThis as any).chrome = originalChrome;
    }
});
