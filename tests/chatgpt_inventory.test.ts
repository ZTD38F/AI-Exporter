export {};
const test = require('node:test');
const assert = require('node:assert');

const {
    offsetChain,
    cursorChain,
    captureChatGPTInventory,
    ChatGPTInventoryError
} = require('../src/core/provider/chatgpt/inventory.js');

test('ChatGPT inventory offset chain - follows short pages until true exhaustion when total is absent', async () => {
    const pages: Record<number, any> = {
        0: { items: [{ id: 'a' }, { id: 'b' }] },
        2: { items: [{ id: 'c' }] },
        3: { items: [] }
    };
    const offsets: number[] = [];

    const result = await offsetChain(async (offset: number) => {
        offsets.push(offset);
        return pages[offset];
    }, 'main', { pageSize: 100, maxPages: 10 });

    assert.deepStrictEqual(offsets, [0, 2, 3]);
    assert.deepStrictEqual(result.items.map((x: any) => x.id), ['a', 'b', 'c']);
    assert.strictEqual(result.evidence.complete, true);
    assert.strictEqual(result.evidence.stopReason, 'empty_page');
    assert.strictEqual(result.evidence.pagesFetched, 3);
});

test('ChatGPT inventory offset chain - honors authoritative total and deduplicates overlapping items', async () => {
    const result = await offsetChain(async (offset: number) => {
        if (offset === 0) return { total: 3, items: [{ id: 'a' }, { id: 'b' }] };
        return { total: 3, items: [{ id: 'b' }, { id: 'c' }] };
    }, 'main', { pageSize: 2, maxPages: 5 });

    assert.deepStrictEqual(result.items.map((x: any) => x.id), ['a', 'b', 'c']);
    assert.strictEqual(result.evidence.serverTotal, 3);
    assert.strictEqual(result.evidence.stopReason, 'total_reached');
    assert.strictEqual(result.evidence.itemsSeen, 4);
    assert.strictEqual(result.evidence.uniqueItems, 3);
});

test('ChatGPT inventory offset chain - repeated page is explicit failure', async () => {
    await assert.rejects(
        () => offsetChain(async () => ({ items: [{ id: 'same' }] }), 'main', {
            pageSize: 1,
            maxPages: 5
        }),
        (error: any) =>
            error instanceof ChatGPTInventoryError &&
            error.code === 'INVENTORY_REPEATED_PAGE'
    );
});

test('ChatGPT inventory offset chain - premature empty page cannot be marked complete', async () => {
    await assert.rejects(
        () => offsetChain(async (offset: number) => (
            offset === 0
                ? { total: 5, items: [{ id: 'a' }, { id: 'b' }] }
                : { total: 5, items: [] }
        ), 'main', { pageSize: 2, maxPages: 5 }),
        (error: any) =>
            error instanceof ChatGPTInventoryError &&
            error.code === 'INVENTORY_PREMATURE_EMPTY_PAGE'
    );
});

test('ChatGPT inventory cursor chain - normal termination produces evidence', async () => {
    const result = await cursorChain(async (cursor: string | null) => {
        if (cursor === null) return { items: [{ id: 'p1' }], cursor: 'next-1' };
        return { items: [{ id: 'p2' }], cursor: null };
    }, 'projects', null, { maxPages: 5 });

    assert.deepStrictEqual(result.items.map((x: any) => x.id), ['p1', 'p2']);
    assert.strictEqual(result.evidence.complete, true);
    assert.strictEqual(result.evidence.stopReason, 'cursor_exhausted');
    assert.strictEqual(result.evidence.pagesFetched, 2);
});

test('ChatGPT inventory cursor chain - repeated cursor fails closed', async () => {
    await assert.rejects(
        () => cursorChain(async () => ({ items: [{ id: 'x' }], cursor: 'loop' }), 'projects', null, {
            maxPages: 5
        }),
        (error: any) =>
            error instanceof ChatGPTInventoryError &&
            error.code === 'INVENTORY_CURSOR_CYCLE'
    );
});

test('ChatGPT conversation inventory - merges memberships across main/project/shared without duplicate conversations', async () => {
    const calls: string[] = [];
    const client = {
        conversationPage: async (offset: number, _limit: number, archived: boolean) => {
            calls.push(`${archived ? 'archived' : 'main'}:${offset}`);
            if (!archived) {
                if (offset === 0) {
                    return {
                        total: 2,
                        items: [
                            { id: 'c-main', title: 'Main' },
                            { id: 'c-both', title: 'Both' }
                        ]
                    };
                }
            } else if (offset === 0) {
                return {
                    total: 1,
                    items: [{ id: 'c-archived', title: 'Archived' }]
                };
            }
            return { items: [] };
        },
        projectsPage: async (cursor: string | null) => {
            assert.strictEqual(cursor, null);
            return {
                items: [{
                    id: 'wrapper-id',
                    resource: {
                        gizmo: {
                            id: 'g-p-project1',
                            display: { name: 'Project One' },
                            files: [{ id: 'file-project' }]
                        }
                    }
                }],
                cursor: null
            };
        },
        projectConversations: async (projectId: string, cursor: string) => {
            assert.strictEqual(projectId, 'g-p-project1');
            assert.strictEqual(cursor, '0');
            return {
                items: [
                    { id: 'c-both', title: 'Both' },
                    { id: 'c-project-only', title: 'Project only' }
                ],
                cursor: null
            };
        },
        sharedPage: async (offset: number) => {
            if (offset === 0) {
                return {
                    total: 2,
                    items: [
                        { id: 'share-1', conversation_id: 'c-both' },
                        { id: 'share-2', conversation_id: 'c-shared-only' }
                    ]
                };
            }
            return { items: [] };
        }
    };

    const result = await captureChatGPTInventory(
        client as any,
        'raw-account-id-that-must-not-be-output-as-a-scope-key',
        'chatgpt-hashed-workspace-key',
        { pageSize: 100, maxPages: 10 }
    );

    assert.strictEqual(result.conversationInventoryComplete, true);
    assert.strictEqual(result.providerId, 'chatgpt');
    assert.strictEqual(result.workspaceKey, 'chatgpt-hashed-workspace-key');
    assert.deepStrictEqual(
        Object.keys(result.listings).sort(),
        ['c-archived', 'c-both', 'c-main', 'c-project-only', 'c-shared-only']
    );

    const bothScopes = result.memberships['c-both'].map((m: any) => m.scope).sort();
    assert.deepStrictEqual(bothScopes, ['main', 'project', 'shared']);
    assert.deepStrictEqual(result.memberships['c-archived'], [{ scope: 'archived' }]);
    assert.strictEqual(result.projects['g-p-project1'].name, 'Project One');
    assert.strictEqual(result.projects['g-p-project1'].files.length, 1);
    assert.strictEqual(Object.keys(result.shares).length, 2);
    assert.strictEqual(result.errors.length, 0);
    assert.ok(result.evidence.some((e: any) => e.scope === 'main' && e.complete));
    assert.ok(result.evidence.some((e: any) => e.scope === 'archived' && e.complete));
    assert.ok(result.evidence.some((e: any) => e.scope === 'projects' && e.complete));
    assert.ok(result.evidence.some((e: any) => e.scope === 'project:g-p-project1' && e.complete));
    assert.ok(result.evidence.some((e: any) => e.scope === 'shared' && e.complete));
});

test('ChatGPT conversation inventory - one failed scope makes inventory explicitly incomplete while preserving successful scopes', async () => {
    const client = {
        conversationPage: async (_offset: number, _limit: number, archived: boolean) => {
            if (archived) {
                throw new ChatGPTInventoryError('INVENTORY_REPEATED_PAGE', 'archived repeated', 'archived');
            }
            return { total: 1, items: [{ id: 'c-main' }] };
        },
        projectsPage: async () => ({ items: [], cursor: null }),
        projectConversations: async () => ({ items: [], cursor: null }),
        sharedPage: async () => ({ items: [], total: 0 })
    };

    const result = await captureChatGPTInventory(
        client as any,
        'raw-account',
        'chatgpt-workspace',
        { pageSize: 100, maxPages: 10 }
    );

    assert.strictEqual(result.conversationInventoryComplete, false);
    assert.ok(result.listings['c-main']);
    assert.ok(result.errors.some((e: any) =>
        e.scope === 'archived' && e.code === 'INVENTORY_REPEATED_PAGE'
    ));
});
