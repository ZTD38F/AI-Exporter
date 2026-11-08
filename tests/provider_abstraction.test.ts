import { useIndexStorage } from './helpers/indexStorage.js';
import { bindTabAccounts } from './helpers/tabAccounts.js';
import { ACCOUNT_UUID } from './helpers/accountRuntime.js';
useIndexStorage();
/**
 * tests/provider_abstraction.test.ts
 * Comprehensive unit test suite for AIProvider abstraction layer,
 * ProviderRegistry and GeminiProvider.
 */
import test from 'node:test';
import assert from 'node:assert';

import { ProviderRegistryClass } from '../src/l1/client/providerRegistry.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import * as TabService from '../src/runtime/capabilities/tabService.js';

test('TabService - getAITab and sendToAITab integration', async () => {
    const origChrome = (global as any).chrome;
    try {
        const queries: string[] = [];
        const messages: Array<{ tabId: number; message: unknown }> = [];
        const runtime = chrome.runtime;
        (global as any).chrome = {
            ...chrome,
            tabs: {
                query: async ({ url }: { url: string }) => {
                    queries.push(url);
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
                sendMessage: (tabId: number, message: unknown, cb: (res: unknown) => void) => {
                    messages.push({ tabId, message });
                    cb({ ok: true, data: 'tab-response' });
                }
            },
            runtime
        };

        await assert.rejects(TabService.getAITab('chatgpt'), /Provider\/account mismatch/);

        await require('../src/l3a/storageService.js').putAccount({ id: ACCOUNT_UUID, providerId: 'gemini', providerAccountId: '10000000001' });
        bindTabAccounts({ 202: ACCOUNT_UUID });
        const geminiTab = await TabService.getAITab('gemini', ACCOUNT_UUID);
        assert.strictEqual(geminiTab?.id, 202, 'Should resolve Gemini tab');

        await assert.rejects(TabService.sendToAITab('chatgpt', { action: 'test' }), /Provider\/account mismatch/);
        const res = await TabService.sendToAITab('gemini', { action: 'test' }, ACCOUNT_UUID);
        assert.deepStrictEqual(res, { ok: true, data: 'tab-response' });
        assert.deepStrictEqual(queries, ['https://gemini.google.com/*', 'https://gemini.google.com/*']);
        assert.deepStrictEqual(messages, [{ tabId: 202, message: { action: 'test', accountId: ACCOUNT_UUID } }]);
    } finally {
        (global as any).chrome = origChrome;
    }
});
