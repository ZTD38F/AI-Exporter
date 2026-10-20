/**
 * tests/provider_abstraction.test.ts
 * Comprehensive unit test suite for AIProvider abstraction layer,
 * ProviderRegistry and GeminiProvider.
 */
import test from 'node:test';
import assert from 'node:assert';

import { ProviderRegistryClass } from '../src/core/provider/providerRegistry.js';
import { GeminiProvider } from '../src/core/provider/gemini/geminiProvider.js';
import * as TabService from '../src/core/utils/tabService.js';

test('ProviderRegistry - registration, lookup, and URL auto-matching', () => {
    const registry = new ProviderRegistryClass();
    const gemini = new GeminiProvider();

    registry.register(gemini);

    assert.strictEqual(registry.get('gemini')?.id, 'gemini');
    assert.strictEqual(registry.get('nonexistent'), undefined);

    // URL resolution
    const geminiMatch = registry.findByUrl('https://gemini.google.com/app/c_12345678');
    assert.strictEqual(geminiMatch?.id, 'gemini', 'Should match gemini URL');

    const unknownMatch = registry.findByUrl('https://claude.ai/chat/123');
    assert.strictEqual(unknownMatch, undefined, 'Unregistered URL should return undefined');

    // Default provider
    registry.setDefaultProviderId('gemini');
    assert.strictEqual(registry.getDefault()?.id, 'gemini');
});

test('GeminiProvider - contract verification', () => {
    const gemini = new GeminiProvider();
    assert.strictEqual(gemini.id, 'gemini');
    assert.strictEqual(gemini.name, 'Google Gemini');

    assert.ok(gemini.matchesUrl('https://gemini.google.com/app'));
    assert.ok(!gemini.matchesUrl('https://chatgpt.com'));
});

test('TabService - getAITab and sendToAITab integration', async () => {
    const origChrome = (global as any).chrome;
    try {
        (global as any).chrome = {
            tabs: {
                query: async ({ url }: { url: string }) => {
                    try {
                        const parsed = new URL(url.replace(/\*$/, ''));
                        if (parsed.hostname === 'chatgpt.com') {
                            return [{ id: 101, url: 'https://chatgpt.com/c/test', active: true }];
                        }
                        if (parsed.hostname === 'gemini.google.com') {
                            return [{ id: 202, url: 'https://gemini.google.com/app', active: true }];
                        }
                    } catch {}
                    return [];
                },
                sendMessage: (_tabId: number, _msg: any, cb: (res: any) => void) => {
                    cb({ ok: true, data: 'tab-response' });
                }
            },
            runtime: {}
        };

        const chatgptTab = await TabService.getAITab('chatgpt');
        assert.strictEqual(chatgptTab?.id, 101, 'Should resolve ChatGPT tab');

        const geminiTab = await TabService.getAITab('gemini');
        assert.strictEqual(geminiTab?.id, 202, 'Should resolve Gemini tab');

        const res = await TabService.sendToAITab('chatgpt', { action: 'test' });
        assert.strictEqual(res.ok, true);
    } finally {
        (global as any).chrome = origChrome;
    }
});
