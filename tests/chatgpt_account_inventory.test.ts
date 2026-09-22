export {};
const test = require('node:test');
const assert = require('node:assert');

const {
    captureChatGPTAccountInventory
} = require('../src/core/provider/chatgpt/accountInventory.js');

test('ChatGPT account inventory - captures all account artifacts and paginates custom GPTs', async () => {
    const artifactCalls: string[] = [];
    const client = {
        accountArtifact: async (kind: string) => {
            artifactCalls.push(kind);
            return { kind, value: true };
        },
        myGptsPage: async (cursor: string | null) => {
            if (cursor === null) {
                return {
                    items: [
                        { id: 'gpt-1', name: 'One' },
                        { id: 'gpt-2', name: 'Two' }
                    ],
                    cursor: 'page-2'
                };
            }
            assert.strictEqual(cursor, 'page-2');
            return {
                items: [
                    { id: 'gpt-2', name: 'Two duplicate' },
                    { id: 'gpt-3', name: 'Three' }
                ],
                cursor: null
            };
        }
    };

    const result = await captureChatGPTAccountInventory(
        client as any,
        'raw-workspace-id',
        'chatgpt-public-workspace',
        { maxPages: 10 }
    );

    assert.strictEqual(result.accountInventoryComplete, true);
    assert.deepStrictEqual(
        artifactCalls.sort(),
        ['beta_features', 'custom_instructions', 'memories', 'settings']
    );
    assert.deepStrictEqual(
        Object.keys(result.artifacts).sort(),
        ['beta_features', 'custom_instructions', 'memories', 'settings']
    );
    assert.deepStrictEqual(result.customGpts.map((x: any) => x.id), ['gpt-1', 'gpt-2', 'gpt-3']);
    assert.strictEqual(result.evidence.length, 1);
    assert.strictEqual(result.evidence[0].scope, 'custom_gpts');
    assert.strictEqual(result.evidence[0].complete, true);
    assert.strictEqual(result.errors.length, 0);
});

test('ChatGPT account inventory - a single artifact failure makes account inventory incomplete without discarding other evidence', async () => {
    const client = {
        accountArtifact: async (kind: string) => {
            if (kind === 'memories') {
                const error: any = new Error('schema changed');
                error.code = 'CONTRACT_DRIFT';
                throw error;
            }
            return { kind };
        },
        myGptsPage: async () => ({ items: [], cursor: null })
    };

    const result = await captureChatGPTAccountInventory(
        client as any,
        'raw-workspace-id',
        'chatgpt-public-workspace',
        { maxPages: 10 }
    );

    assert.strictEqual(result.accountInventoryComplete, false);
    assert.ok(!Object.prototype.hasOwnProperty.call(result.artifacts, 'memories'));
    assert.ok(result.artifacts.settings);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].scope, 'account:memories');
    assert.strictEqual(result.errors[0].code, 'CONTRACT_DRIFT');
    assert.strictEqual(result.evidence[0].complete, true);
});

test('ChatGPT account inventory - custom GPT cursor cycle is explicit partial state', async () => {
    const client = {
        accountArtifact: async (kind: string) => ({ kind }),
        myGptsPage: async () => ({
            items: [{ id: 'gpt-1' }],
            cursor: 'loop'
        })
    };

    const result = await captureChatGPTAccountInventory(
        client as any,
        'raw-workspace-id',
        'chatgpt-public-workspace',
        { maxPages: 10 }
    );

    assert.strictEqual(result.accountInventoryComplete, false);
    assert.strictEqual(result.customGpts.length, 0);
    assert.ok(result.errors.some((e: any) =>
        e.scope === 'custom_gpts' && e.code === 'INVENTORY_CURSOR_CYCLE'
    ));
});

test('ChatGPT account inventory - AUTH_REQUIRED bubbles instead of being mislabeled partial', async () => {
    const TransportError = require('../src/core/provider/chatgpt/transport.js').ChatGPTTransportError;
    const client = {
        accountArtifact: async () => {
            throw new TransportError('AUTH_REQUIRED', 'expired', 401);
        },
        myGptsPage: async () => ({ items: [], cursor: null })
    };

    await assert.rejects(
        () => captureChatGPTAccountInventory(
            client as any,
            'raw-workspace-id',
            'chatgpt-public-workspace',
            { maxPages: 10 }
        ),
        (error: any) => error.code === 'AUTH_REQUIRED'
    );
});
