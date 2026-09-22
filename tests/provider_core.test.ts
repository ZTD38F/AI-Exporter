export {};
const test = require('node:test');
const assert = require('node:assert');

const { ProviderRegistryClass } = require('../src/core/provider/providerRegistry.js');
const { GeminiProvider } = require('../src/core/provider/gemini/geminiProvider.js');
const TabService = require('../src/core/utils/tabService.js');

function makeGeminiClient() {
    return {
        getAllConversations: async () => ({
            conversations: [{
                id: 'g-1',
                title: 'Gemini One',
                createdAt: 100,
                updatedAt: 200,
                timestamp: 200,
                url: 'https://gemini.google.com/app/g-1'
            }],
            total: 1,
            stoppedEarly: false,
            diagnostics: { stopReason: 'complete' },
            hitGoogleLimit: false
        }),
        getConversationDetail: async (id: string) => ({
            id,
            title: 'Gemini Detail',
            messages: [{ role: 'user', content: 'hello' }],
            createdAt: 100,
            updatedAt: 200,
            timestamp: 200,
            attachmentCount: 0,
            nextPageToken: null,
            _raw: { provider: 'gemini' }
        })
    };
}

test('ProviderRegistry - strict registration, lookup, default and URL matching', () => {
    const registry = new ProviderRegistryClass();
    const gemini = new GeminiProvider(makeGeminiClient() as any);

    registry.register(gemini);
    assert.strictEqual(registry.get('gemini'), gemini);
    assert.strictEqual(registry.getDefault(), gemini);
    assert.strictEqual(registry.findByUrl('https://gemini.google.com/app/abc'), gemini);
    assert.strictEqual(registry.findByUrl('https://chatgpt.com/c/abc'), undefined);

    assert.throws(() => registry.register(new GeminiProvider(makeGeminiClient() as any)), /already registered/);

    registry.unregister('gemini');
    assert.strictEqual(registry.getDefault(), undefined);
});

test('GeminiProvider - preserves existing client output while namespacing provider/scope', async () => {
    const provider = new GeminiProvider(makeGeminiClient() as any);

    const page = await provider.listConversations({ accountSlot: 'u1' });
    assert.strictEqual(page.items.length, 1);
    assert.strictEqual(page.items[0].providerId, 'gemini');
    assert.strictEqual(page.items[0].scopeKey, 'u1');
    assert.strictEqual(page.items[0].id, 'g-1');
    assert.strictEqual(page.total, 1);
    assert.strictEqual(page.stoppedEarly, false);
    assert.strictEqual(page.hasMore, false);

    const detail = await provider.fetchConversationDetail('g-1', { accountSlot: 'u1' });
    assert.strictEqual(detail.providerId, 'gemini');
    assert.strictEqual(detail.scopeKey, 'u1');
    assert.strictEqual(detail.id, 'g-1');
    assert.strictEqual(detail.messages.length, 1);
    assert.deepStrictEqual(detail.raw, { provider: 'gemini' });
});

test('TabService - generic Gemini routing preserves old wrapper behavior', async () => {
    const oldChrome = (global as any).chrome;
    const sent: any[] = [];

    try {
        (global as any).chrome = {
            tabs: {
                query: async ({ url }: any) => {
                    assert.strictEqual(url, 'https://gemini.google.com/*');
                    return [
                        { id: 10, active: false, url: 'https://gemini.google.com/u/0/app/a' },
                        { id: 20, active: true, url: 'https://gemini.google.com/u/1/app/b' }
                    ];
                },
                sendMessage: (tabId: number, msg: any, cb: (value: any) => void) => {
                    sent.push([tabId, msg]);
                    cb({ ok: true, tabId });
                }
            },
            runtime: { lastError: null }
        };

        const generic = await TabService.getAITab('gemini', 'u1');
        const legacy = await TabService.getGeminiTab('u1');
        assert.strictEqual(generic.id, 20);
        assert.strictEqual(legacy.id, 20);

        const response = await TabService.sendToAITab('gemini', { action: 'ping' }, 'u1', 1000);
        assert.strictEqual(response.ok, true);
        assert.strictEqual(response.tabId, 20);
        assert.strictEqual(sent.length, 1);
    } finally {
        (global as any).chrome = oldChrome;
    }
});

test('TabService - unknown providers fail closed instead of broad tab access', async () => {
    const oldChrome = (global as any).chrome;
    try {
        let queried = false;
        (global as any).chrome = {
            tabs: {
                query: async () => {
                    queried = true;
                    return [];
                }
            },
            runtime: { lastError: null }
        };

        const tab = await TabService.getAITab('unknown-provider');
        assert.strictEqual(tab, null);
        assert.strictEqual(queried, false, 'unknown provider must not trigger broad tab enumeration');

        await assert.rejects(
            () => TabService.sendToAITab('unknown-provider', { action: 'ping' }),
            /no registered browser tab patterns/
        );
    } finally {
        (global as any).chrome = oldChrome;
    }
});
