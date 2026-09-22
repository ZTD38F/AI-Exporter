export {};
const test = require('node:test');
const assert = require('node:assert');

const providerIndex = require('../src/core/provider/index.js');
const { ProviderRegistry } = require('../src/core/provider/providerRegistry.js');
const { ChatGPTProvider } = require('../src/core/provider/chatgpt/chatgptProvider.js');
const {
    assertChatGPTDetailMessageSize,
    ChatGPTBridgePayloadError
} = require('../src/core/provider/chatgpt/bridgePayload.js');

function installChromeResponder(responder: (action: string, message: any) => any, hasTab = true) {
    const oldChrome = (global as any).chrome;
    const sent: any[] = [];

    (global as any).chrome = {
        tabs: {
            query: async ({ url }: any) => {
                assert.strictEqual(url, 'https://chatgpt.com/*');
                return hasTab
                    ? [{ id: 501, active: true, url: 'https://chatgpt.com/c/example' }]
                    : [];
            },
            sendMessage: (tabId: number, message: any, cb: (value: any) => void) => {
                sent.push({ tabId, message });
                cb(responder(message.action, message));
            }
        },
        runtime: { lastError: null }
    };

    return {
        sent,
        restore() {
            (global as any).chrome = oldChrome;
        }
    };
}

test('provider facade - ChatGPT is registered but Gemini remains default provider', () => {
    assert.ok(providerIndex.ChatGPTProvider);
    assert.strictEqual(ProviderRegistry.get('chatgpt')?.id, 'chatgpt');
    assert.strictEqual(ProviderRegistry.get('gemini')?.id, 'gemini');
    assert.strictEqual(ProviderRegistry.getDefault()?.id, 'gemini');
    assert.strictEqual(
        ProviderRegistry.findByUrl('https://chatgpt.com/c/abc')?.id,
        'chatgpt'
    );
});

test('ChatGPTProvider - capabilities remain conservative until unimplemented/live-unverified layers are proven', () => {
    const provider = new ChatGPTProvider();
    assert.strictEqual(provider.capabilities.workspaces, true);
    assert.strictEqual(provider.capabilities.collections, true);
    assert.strictEqual(provider.capabilities.sharedItems, true);
    assert.strictEqual(provider.capabilities.accountArtifacts, true);
    assert.strictEqual(provider.capabilities.thoughtBlocks, true);

    assert.strictEqual(provider.capabilities.assets, false);
    assert.strictEqual(provider.capabilities.officialImport, false);
    assert.strictEqual(provider.capabilities.realtimeObservation, false);
    assert.strictEqual(provider.capabilities.incrementalSync, false);
});

test('ChatGPTProvider - readiness is false when no authorized ChatGPT tab exists', async () => {
    const mock = installChromeResponder(() => ({ ok: true }), false);
    try {
        const provider = new ChatGPTProvider();
        const readiness = await provider.checkReadiness();
        assert.strictEqual(readiness.ready, false);
        assert.ok(readiness.error.includes('chatgpt.com'));
        assert.strictEqual(mock.sent.length, 0);
    } finally {
        mock.restore();
    }
});

test('ChatGPTProvider - readiness never exposes bearer and returns account identity from bridge summary', async () => {
    const mock = installChromeResponder((action) => {
        assert.strictEqual(action, 'chatgptReadiness');
        return {
            ok: true,
            provider: 'chatgpt',
            session: {
                authenticated: true,
                user: { email: 'owner@example.com' }
            }
        };
    });

    try {
        const provider = new ChatGPTProvider();
        const readiness = await provider.checkReadiness();
        assert.strictEqual(readiness.ready, true);
        assert.strictEqual(readiness.accountName, 'owner@example.com');
        assert.ok(!JSON.stringify(readiness).toLowerCase().includes('bearer'));
    } finally {
        mock.restore();
    }
});

test('ChatGPTProvider - conversation inventory maps canonical inventory keys, not shared item ids', async () => {
    const mock = installChromeResponder((action, message) => {
        assert.strictEqual(action, 'chatgptConversationInventory');
        assert.strictEqual(message.workspaceKey, 'chatgpt-workspace-hash');
        return {
            ok: true,
            provider: 'chatgpt',
            inventory: {
                conversationInventoryComplete: true,
                listings: {
                    'c-main': {
                        id: 'c-main',
                        title: 'Main',
                        create_time: 1700000000,
                        update_time: 1700000100
                    },
                    'c-shared-only': {
                        id: 'share-999',
                        conversation_id: 'c-shared-only',
                        title: 'Shared only',
                        update_time: '2026-09-22T00:00:00Z'
                    }
                },
                memberships: {
                    'c-main': [{ scope: 'main' }],
                    'c-shared-only': [{ scope: 'shared', shareId: 'share-999' }]
                },
                projects: {},
                shares: { 'share-999': { id: 'share-999' } },
                evidence: [{ scope: 'main', complete: true }],
                errors: []
            }
        };
    });

    try {
        const provider = new ChatGPTProvider();
        const page = await provider.listConversations({
            workspaceKey: 'chatgpt-workspace-hash'
        });

        assert.strictEqual(page.items.length, 2);
        assert.strictEqual(page.hasMore, false);
        assert.strictEqual(page.stoppedEarly, false);

        const main = page.items.find((x: any) => x.id === 'c-main');
        assert.strictEqual(main.providerId, 'chatgpt');
        assert.strictEqual(main.scopeKey, 'chatgpt-workspace-hash');
        assert.strictEqual(main.createdAt, 1700000000000);
        assert.strictEqual(main.updatedAt, 1700000100000);
        assert.strictEqual(main.remoteVersionMarker, '1700000100');

        const shared = page.items.find((x: any) => x.id === 'c-shared-only');
        assert.ok(shared, 'shared-only conversation must use inventory key as canonical id');
        assert.strictEqual(shared.url, 'https://chatgpt.com/c/c-shared-only');
        assert.strictEqual(shared.memberships[0].scope, 'shared');
        assert.strictEqual(shared.memberships[0].collectionId, 'share-999');
        assert.notStrictEqual(shared.id, 'share-999');
    } finally {
        mock.restore();
    }
});

test('ChatGPTProvider - partial inventory preserves discovered items but reports stoppedEarly/hasMore', async () => {
    const mock = installChromeResponder(() => ({
        ok: true,
        provider: 'chatgpt',
        inventory: {
            conversationInventoryComplete: false,
            listings: {
                c1: { id: 'c1', title: 'Known chat' }
            },
            memberships: { c1: [{ scope: 'main' }] },
            projects: {},
            shares: {},
            evidence: [{ scope: 'main', complete: true }],
            errors: [{
                scope: 'archived',
                code: 'INVENTORY_REPEATED_PAGE',
                message: 'repeated'
            }]
        }
    }));

    try {
        const provider = new ChatGPTProvider();
        const page = await provider.listConversations({
            workspaceKey: 'chatgpt-workspace-hash'
        });
        assert.strictEqual(page.items.length, 1);
        assert.strictEqual(page.hasMore, true);
        assert.strictEqual(page.stoppedEarly, true);
        assert.strictEqual(page.diagnostics.complete, false);
        assert.strictEqual(page.diagnostics.errors[0].code, 'INVENTORY_REPEATED_PAGE');
    } finally {
        mock.restore();
    }
});

test('ChatGPTProvider - workspace key is mandatory for scoped list/detail calls', async () => {
    const provider = new ChatGPTProvider();
    await assert.rejects(
        () => provider.listConversations(),
        /workspaceKey is required/
    );
    await assert.rejects(
        () => provider.fetchConversationDetail('c1'),
        /workspaceKey is required/
    );
});

test('ChatGPTProvider - detail preserves normalized graph/integrity returned by same-origin bridge', async () => {
    const mock = installChromeResponder((action, message) => {
        assert.strictEqual(action, 'chatgptConversationDetail');
        assert.strictEqual(message.workspaceKey, 'chatgpt-ws');
        assert.strictEqual(message.conversationId, 'c-detail');
        return {
            ok: true,
            provider: 'chatgpt',
            detail: {
                providerId: 'chatgpt',
                scopeKey: 'chatgpt-ws',
                id: 'c-detail',
                title: 'Detail',
                messages: [{ role: 'user', content: 'hello' }],
                graph: {
                    totalNodes: 2,
                    activePathComplete: true,
                    normalizationComplete: true
                },
                integrity: {
                    state: 'NORMALIZED',
                    complete: true
                },
                raw: { mapping: {} }
            }
        };
    });

    try {
        const provider = new ChatGPTProvider();
        const detail = await provider.fetchConversationDetail('c-detail', {
            workspaceKey: 'chatgpt-ws'
        });

        assert.strictEqual(detail.providerId, 'chatgpt');
        assert.strictEqual(detail.scopeKey, 'chatgpt-ws');
        assert.strictEqual(detail.graph.normalizationComplete, true);
        assert.strictEqual(detail.integrity.complete, true);
        assert.deepStrictEqual(detail.raw, { mapping: {} });
    } finally {
        mock.restore();
    }
});

test('ChatGPTProvider - bridge errors propagate explicit code/status', async () => {
    const mock = installChromeResponder(() => ({
        ok: false,
        code: 'DETAIL_TOO_LARGE_FOR_MESSAGE',
        status: 413,
        error: 'too large'
    }));

    try {
        const provider = new ChatGPTProvider();
        await assert.rejects(
            async () => {
                try {
                    await provider.fetchConversationDetail('huge', {
                        workspaceKey: 'chatgpt-ws'
                    });
                } catch (error: any) {
                    assert.strictEqual(error.code, 'DETAIL_TOO_LARGE_FOR_MESSAGE');
                    assert.strictEqual(error.status, 413);
                    throw error;
                }
            },
            /too large/
        );
    } finally {
        mock.restore();
    }
});

test('ChatGPT detail bridge payload guard - accepts normal payload and rejects oversized/cyclic data explicitly', () => {
    const size = assertChatGPTDetailMessageSize({ mapping: { a: { message: 'ok' } } }, 1024);
    assert.ok(size > 0 && size < 1024);

    assert.throws(
        () => assertChatGPTDetailMessageSize({ text: 'x'.repeat(2048) }, 100),
        (error: any) =>
            error instanceof ChatGPTBridgePayloadError
            && error.code === 'DETAIL_TOO_LARGE_FOR_MESSAGE'
            && error.byteLength > 100
    );

    const cyclic: any = {};
    cyclic.self = cyclic;
    assert.throws(
        () => assertChatGPTDetailMessageSize(cyclic, 1024),
        (error: any) =>
            error instanceof ChatGPTBridgePayloadError
            && error.code === 'DETAIL_SERIALIZATION_FAILED'
    );
});
