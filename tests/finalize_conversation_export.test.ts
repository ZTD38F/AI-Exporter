export {};
const test = require('node:test');
const assert = require('node:assert');
const { normId } = require('../src/core/utils/pathUtils.js');
const StorageService = require('../src/core/storage/storageService.js');
const {
    buildExportCompletion,
    completeConversationExport,
    computeExportMessageCount,
    computeAuthoritativeTimestamp,
    resolveExportRecordStatus,
    applyAssetFailureToExportRecord,
    normalizeReliableTitleSource,
    resolveReliableTitleSource
} = require('../src/core/engine/export/exportCompletion.js');
const { finalizeChatExport } = require('../src/core/engine/export/sessionRecovery.js');
const { applyExportTitleWriteback, setTitleBySource, resolveTitle, assertCanonicalTitleProvenance } = require('../src/core/utils/titleUtils.js');
const { resolveChat } = require('../src/core/engine/export/batchWorker.js');

function createMockChromeStorage(initialData: Record<string, any> = {}) {
    const mockStorage: Record<string, any> = { ...initialData };
    return {
        mockStorage,
        chrome: {
            storage: {
                local: {
                    get: async (keys: any) => {
                        if (keys === null || keys === undefined) return { ...mockStorage };
                        if (typeof keys === 'string') keys = [keys];
                        const res: Record<string, any> = {};
                        for (const k of (keys || [])) {
                            if (mockStorage[k] !== undefined) res[k] = mockStorage[k];
                        }
                        return res;
                    },
                    set: async (obj: any) => {
                        Object.assign(mockStorage, obj);
                    },
                    remove: async (keys: any) => {
                        if (typeof keys === 'string') keys = [keys];
                        for (const k of (keys || [])) delete mockStorage[k];
                    }
                }
            }
        }
    };
}

// 1. Batch production-shape: no conversationUpdate provided, generic existing title promoted
test('1. Batch production-shape: promotes generic title to real export title without fake provenance', async () => {
    const { mockStorage, chrome } = createMockChromeStorage({
        gemini_conversations: [
            { id: 'c_batch_1', title: '未命名对话', titleSource: 'default', messageCount: 1, updatedAt: 1000 }
        ]
    });
    const origChrome = (global as any).chrome;
    (global as any).chrome = chrome;

    try {
        let callbackCalled = false;
        // Batch pipeline call shape from sessionRecovery: only passes record and onItemExported
        const res = await StorageService.finalizeConversationExport(
            'u0',
            'c_batch_1',
            {
                title: '量子纠缠推演报告',
                format: 'markdown',
                exportedAt: new Date(2000).toISOString(),
                status: 'ok',
                messageCount: 5,
                chatTime: 2000
            },
            {
                onItemExported: (id: string, record: any) => {
                    assert.strictEqual(id, 'batch_1');
                    assert.strictEqual(record.title, '量子纠缠推演报告');
                    callbackCalled = true;
                }
            }
        );

        assert.strictEqual(res.ok, true);
        assert.strictEqual(callbackCalled, true);

        // Verify exportedIds SSoT
        const expMap = await StorageService.getExportedIds('u0');
        assert.ok(expMap['batch_1']);
        assert.strictEqual(expMap['batch_1'].title, '量子纠缠推演报告');

        // Verify gemini_conversations promotion: promoted to real title, source is 'legacy' (not fake api-detail/export)
        const convs = await StorageService.getConversations('u0');
        assert.strictEqual(convs.length, 1);
        assert.strictEqual(convs[0].title, '量子纠缠推演报告');
        assert.strictEqual(convs[0].titleSource, 'legacy');
        assert.notStrictEqual(convs[0].titleSource, 'api-detail', 'Must not synthesize fake api-detail provenance');
        assert.notStrictEqual(convs[0].titleSource, 'export', 'Must not synthesize unindexed export tier');
        assert.strictEqual(convs[0].messageCount, 5);
    } finally {
        (global as any).chrome = origChrome;
    }
});

// 2. Unknown candidate does NOT overwrite authoritative RPC title
test('2. Unknown candidate does NOT overwrite authoritative RPC title', async () => {
    const { mockStorage, chrome } = createMockChromeStorage({
        gemini_conversations: [
            {
                id: 'c_rpc_chat',
                title: '线上RPC权威标题',
                titleSource: 'rpc',
                titles: { rpc: '线上RPC权威标题' },
                messageCount: 3
            }
        ]
    });
    const origChrome = (global as any).chrome;
    (global as any).chrome = chrome;

    try {
        await StorageService.finalizeConversationExport(
            'u0',
            'c_rpc_chat',
            {
                title: '某种未提供来源的候选标题',
                format: 'markdown',
                exportedAt: new Date().toISOString(),
                status: 'ok'
            }
        );

        const convs = await StorageService.getConversations('u0');
        assert.strictEqual(convs[0].title, '线上RPC权威标题', '权威RPC标题绝不能被无来源候选标题覆盖');
        assert.strictEqual(convs[0].titleSource, 'rpc');
    } finally {
        (global as any).chrome = origChrome;
    }
});

// 3. Unknown candidate does NOT overwrite API-detail or Takeout existing real titles
test('3. Unknown candidate does NOT overwrite API-detail or Takeout existing real titles', async () => {
    const { mockStorage, chrome } = createMockChromeStorage({
        gemini_conversations: [
            {
                id: 'c_api_chat',
                title: 'API详细端权威标题',
                titleSource: 'api-detail',
                titles: { 'api-detail': 'API详细端权威标题' },
                messageCount: 2
            },
            {
                id: 'c_takeout_chat',
                title: 'Takeout历史真实标题',
                titleSource: 'takeout',
                titles: { takeout: 'Takeout历史真实标题' },
                messageCount: 4
            }
        ]
    });
    const origChrome = (global as any).chrome;
    (global as any).chrome = chrome;

    try {
        // Attempt overwrite on API-detail
        await StorageService.finalizeConversationExport('u0', 'c_api_chat', {
            title: '无来源导出标题A',
            status: 'ok'
        });
        // Attempt overwrite on Takeout
        await StorageService.finalizeConversationExport('u0', 'c_takeout_chat', {
            title: '无来源导出标题B',
            status: 'ok'
        });

        const convs = await StorageService.getConversations('u0');
        const apiChat = convs.find((c: any) => normId(c.id) === 'api_chat');
        const takeoutChat = convs.find((c: any) => normId(c.id) === 'takeout_chat');

        assert.strictEqual(apiChat.title, 'API详细端权威标题', 'api-detail 绝不能被无来源候选标题覆盖');
        assert.strictEqual(apiChat.titleSource, 'api-detail');

        assert.strictEqual(takeoutChat.title, 'Takeout历史真实标题', 'takeout 真实标题绝不能被无来源候选标题覆盖');
        assert.strictEqual(takeoutChat.titleSource, 'takeout');
    } finally {
        (global as any).chrome = origChrome;
    }
});

// 4. Live titleSource = default: promotes generic title without synthesizing fake api-detail
test('4. Live titleSource = default: promotes generic title without synthesizing fake api-detail', async () => {
    const { mockStorage, chrome } = createMockChromeStorage({
        gemini_conversations: [
            { id: 'c_live_chat', title: '未命名对话', titleSource: 'default', messageCount: 1 }
        ]
    });
    const origChrome = (global as any).chrome;
    (global as any).chrome = chrome;

    try {
        const liveChatObj = {
            id: 'c_live_chat',
            title: '未命名对话',
            titleSource: 'default',
            messages: [{ role: 'user', content: 'hello' }, { role: 'model', content: 'world' }]
        };

        await completeConversationExport(
            StorageService,
            'u0',
            {
                conversation: liveChatObj,
                conversationId: 'c_live_chat',
                format: 'markdown',
                exportedAt: Date.now(),
                titleCandidate: '流式量子分析报告',
                titleProvenance: liveChatObj.titleSource // 'default'
            }
        );

        const convs = await StorageService.getConversations('u0');
        assert.strictEqual(convs[0].title, '流式量子分析报告', '未命名对话应成功晋级为流式提取的真实标题');
        assert.strictEqual(convs[0].titleSource, 'legacy', '无可靠来源时应归为 legacy，不得伪造 api-detail');
        assert.notStrictEqual(convs[0].titleSource, 'api-detail');
    } finally {
        (global as any).chrome = origChrome;
    }
});

// 5. Known provenance continues source-tier arbitration
test('5. Known provenance continues source-tier arbitration (rpc > takeout, titles map merged)', async () => {
    const { mockStorage, chrome } = createMockChromeStorage({
        gemini_conversations: [
            {
                id: 'c_tier_test',
                title: 'Takeout旧标题',
                titleSource: 'takeout',
                titles: { takeout: 'Takeout旧标题' }
            }
        ]
    });
    const origChrome = (global as any).chrome;
    (global as any).chrome = chrome;

    try {
        // Upgrade with RPC source
        await StorageService.finalizeConversationExport(
            'u0',
            'c_tier_test',
            {
                title: 'RPC线上权威新标题',
                format: 'markdown',
                status: 'ok'
            },
            {
                conversationUpdate: {
                    title: 'RPC线上权威新标题',
                    titleSource: 'rpc',
                    titles: { rpc: 'RPC线上权威新标题' }
                }
            }
        );

        let convs = await StorageService.getConversations('u0');
        assert.strictEqual(convs[0].title, 'RPC线上权威新标题', 'RPC 必须晋级覆盖 Takeout');
        assert.strictEqual(convs[0].titleSource, 'rpc');
        assert.strictEqual(convs[0].titles.takeout, 'Takeout旧标题');
        assert.strictEqual(convs[0].titles.rpc, 'RPC线上权威新标题');

        // Subsequent weaker takeout update must NOT downgrade RPC
        await StorageService.finalizeConversationExport(
            'u0',
            'c_tier_test',
            {
                title: '另一个Takeout更旧标题',
                format: 'markdown',
                status: 'ok'
            },
            {
                conversationUpdate: {
                    title: '另一个Takeout更旧标题',
                    titleSource: 'takeout',
                    titles: { takeout: '另一个Takeout更旧标题' }
                }
            }
        );

        convs = await StorageService.getConversations('u0');
        assert.strictEqual(convs[0].title, 'RPC线上权威新标题', '弱势 Takeout 绝不能降级已有的 RPC');
        assert.strictEqual(convs[0].titleSource, 'rpc');
    } finally {
        (global as any).chrome = origChrome;
    }
});

// 6. Partial export: status = partial and hasFailedAssets = true on asset failure
test('6. Partial export: status = partial and hasFailedAssets = true matches across batch and live', () => {
    // Shared completion logic test
    const okCompletion = buildExportCompletion({
        conversationId: 'c_test_ok',
        conversation: { messages: [1, 2] },
        titleCandidate: 'Normal Chat',
        failedAssets: []
    });
    assert.strictEqual(okCompletion.exportRecord.status, 'ok');
    assert.strictEqual(okCompletion.exportRecord.hasFailedAssets, false);

    const partialCompletion = buildExportCompletion({
        conversationId: 'c_test_partial',
        conversation: { messages: [1, 2] },
        titleCandidate: 'Partial Chat',
        failedAssets: [{ file: 'img.png', error: 'fetch failed' }]
    });
    assert.strictEqual(partialCompletion.exportRecord.status, 'partial');
    assert.strictEqual(partialCompletion.exportRecord.hasFailedAssets, true);

    const emptyCompletion = buildExportCompletion({
        conversationId: 'c_test_empty',
        conversation: { messages: [] },
        titleCandidate: 'Empty Chat',
        failedAssets: []
    });
    assert.strictEqual(emptyCompletion.exportRecord.status, 'empty');
});

// 7. Callback: invoked after persistence, error in callback does not abort, not invoked on failure
test('7. Callback semantics: invoked after persistence, error does not abort, not invoked on failure', async () => {
    const { mockStorage, chrome } = createMockChromeStorage({ gemini_conversations: [] });
    const origChrome = (global as any).chrome;
    (global as any).chrome = chrome;

    try {
        let callbackCount = 0;
        // Case A: callback throws, finalize still succeeds
        const resA = await StorageService.finalizeConversationExport(
            'u0',
            'c_cb_success',
            { title: 'Callback Test', status: 'ok' },
            {
                onItemExported: () => {
                    callbackCount++;
                    throw new Error('Callback intentionally threw error');
                }
            }
        );
        assert.strictEqual(resA.ok, true, 'Callback throwing must not abort finalizeConversationExport');
        assert.strictEqual(callbackCount, 1);

        // Case B: saveExportRecord failure, callback must NOT be invoked
        let failureCallbackCalled = false;
        const brokenAdapter = {
            saveExportRecord: async () => { throw new Error('Disk IO failure'); },
            finalizeConversationExport: undefined
        };

        await assert.rejects(async () => {
            await completeConversationExport(
                brokenAdapter,
                'u0',
                { conversationId: 'c_fail', titleCandidate: 'Fail Chat' },
                {
                    onItemExported: () => { failureCallbackCalled = true; }
                }
            );
        }, /Disk IO failure/);

        assert.strictEqual(failureCallbackCalled, false, 'Callback must NOT be invoked if record persistence fails');
    } finally {
        (global as any).chrome = origChrome;
    }
});

// 8. Parity A: Batch / Live canonical record parity given same facts
test('8. Parity A: Batch / Live canonical record parity given identical input facts', () => {
    const chatFacts = {
        id: 'c_parity_123',
        title: '量子引力理论探究',
        titleSource: 'rpc',
        titles: { rpc: '量子引力理论探究' },
        messages: [{ role: 'user', content: 'q1' }, { role: 'model', content: 'a1' }],
        updatedAt: 1727777777000,
        truncated: false
    };
    const exportedAt = 1727788888000;

    // Live path simulation
    const liveCompletion = buildExportCompletion({
        conversation: chatFacts,
        conversationId: chatFacts.id,
        format: 'markdown',
        exportedAt,
        titleCandidate: chatFacts.title,
        titleProvenance: chatFacts.titleSource,
        titles: chatFacts.titles
    });

    // Batch path simulation (with explicit messageCount and chatTime from list snapshot)
    const batchCompletion = buildExportCompletion({
        conversation: chatFacts,
        conversationId: normId(chatFacts.id),
        format: 'markdown',
        exportedAt,
        titleCandidate: chatFacts.title,
        titleProvenance: chatFacts.titleSource,
        titles: chatFacts.titles,
        messageCount: 2,
        chatTime: computeAuthoritativeTimestamp(chatFacts)
    });

    // Assert parity across all canonical fields
    assert.strictEqual(batchCompletion.targetId, liveCompletion.targetId);
    assert.strictEqual(batchCompletion.exportRecord.title, liveCompletion.exportRecord.title);
    assert.strictEqual(batchCompletion.exportRecord.messageCount, liveCompletion.exportRecord.messageCount);
    assert.strictEqual(batchCompletion.exportRecord.chatTime, liveCompletion.exportRecord.chatTime);
    assert.strictEqual(batchCompletion.exportRecord.format, liveCompletion.exportRecord.format);
    assert.strictEqual(batchCompletion.exportRecord.status, liveCompletion.exportRecord.status);
    assert.strictEqual(batchCompletion.exportRecord.hasFailedAssets, liveCompletion.exportRecord.hasFailedAssets);
    assert.strictEqual(batchCompletion.exportRecord.isTruncated, liveCompletion.exportRecord.isTruncated);
    assert.strictEqual(batchCompletion.exportRecord.exportedAt, liveCompletion.exportRecord.exportedAt);
    assert.deepStrictEqual(batchCompletion.exportRecord, liveCompletion.exportRecord);
    assert.deepStrictEqual(batchCompletion.conversationUpdate, liveCompletion.conversationUpdate);
});

// 9. Parity B: Batch production path via sessionRecovery uses shared builder
test('9. Parity B: Batch production-shape execution through sessionRecovery uses shared builder output', async () => {
    const { mockStorage, chrome } = createMockChromeStorage({
        gemini_conversations: [
            { id: 'c_batch_pipe', title: '未命名对话', titleSource: 'default', messageCount: 1 }
        ]
    });
    const origChrome = (global as any).chrome;
    (global as any).chrome = chrome;

    try {
        const chat = {
            id: 'c_batch_pipe',
            title: '高维拓扑流形研究报告',
            titleSource: 'rpc',
            titles: { rpc: '高维拓扑流形研究报告' },
            messages: [{ role: 'user', content: 'hello' }, { role: 'model', content: 'world' }],
            updatedAt: 1727777000000
        };

        const completion = buildExportCompletion({
            conversation: chat,
            conversationId: 'batch_pipe',
            format: 'markdown',
            exportedAt: '2026-10-01T12:00:00.000Z',
            titleCandidate: chat.title,
            titleProvenance: chat.titleSource,
            titles: chat.titles,
            messageCount: 2,
            chatTime: chat.updatedAt
        });

        const chatRecordsMap = new Map<string, any>([
            ['batch_pipe', {
                ...completion.exportRecord,
                exportRecord: completion.exportRecord,
                conversationUpdate: completion.conversationUpdate,
                targetId: completion.targetId
            }]
        ]);

        const finalizedChatsSet = new Set<string>();
        const chatFailedAssetsSet = new Set<string>();
        let itemExportedCalled = false;

        const finalized = await finalizeChatExport('c_batch_pipe', {
            finalizedChatsSet,
            chatRecordsMap,
            chatFailedAssetsSet,
            Storage: StorageService,
            storageAdapter: StorageService,
            slot: 'u0',
            onItemExported: (id: string, rec: any) => {
                itemExportedCalled = true;
                assert.strictEqual(normId(id), 'batch_pipe');
                assert.strictEqual(rec.title, '高维拓扑流形研究报告');
            }
        });

        assert.strictEqual(finalized, true);
        assert.strictEqual(itemExportedCalled, true);
        assert.ok(finalizedChatsSet.has('batch_pipe'));

        // Verify exportedIds SSoT matches canonical completion record
        const exportedMap = await StorageService.getExportedIds('u0');
        assert.ok(exportedMap['batch_pipe']);
        assert.strictEqual(exportedMap['batch_pipe'].title, '高维拓扑流形研究报告');
        assert.strictEqual(exportedMap['batch_pipe'].messageCount, 2);
        assert.strictEqual(exportedMap['batch_pipe'].status, 'ok');

        // Verify gemini_conversations was updated with authoritative metadata
        const convs = await StorageService.getConversations('u0');
        assert.strictEqual(convs[0].title, '高维拓扑流形研究报告');
        assert.strictEqual(convs[0].titleSource, 'rpc');
    } finally {
        (global as any).chrome = origChrome;
    }
});

// 10. Parity C: Partial export with asset failure matches across batch and live
test('10. Parity C: Partial export with asset failure matches across batch and live', () => {
    const chat = { id: 'c_part', messages: [1, 2], title: 'Partial Parity Chat' };

    // Live path: asset failure passed into builder
    const livePartial = buildExportCompletion({
        conversationId: 'c_part',
        conversation: chat,
        titleCandidate: 'Partial Parity Chat',
        failedAssets: [{ file: 'failed.png', error: '404' }]
    });

    // Batch path: initially built with ok status, then patched via applyAssetFailureToExportRecord
    const batchInitial = buildExportCompletion({
        conversationId: 'c_part',
        conversation: chat,
        titleCandidate: 'Partial Parity Chat'
    });
    assert.strictEqual(batchInitial.exportRecord.status, 'ok');
    assert.strictEqual(batchInitial.exportRecord.hasFailedAssets, false);

    applyAssetFailureToExportRecord(batchInitial.exportRecord);

    assert.strictEqual(batchInitial.exportRecord.status, 'partial');
    assert.strictEqual(batchInitial.exportRecord.hasFailedAssets, true);
    assert.strictEqual(livePartial.exportRecord.status, batchInitial.exportRecord.status);
    assert.strictEqual(livePartial.exportRecord.hasFailedAssets, batchInitial.exportRecord.hasFailedAssets);
});

// 11. Parity D: Empty conversation matches across batch and live
test('11. Parity D: Empty conversation matches across batch and live', () => {
    const emptyChat = { id: 'c_empty', messages: [], title: 'Empty Chat' };

    const liveEmpty = buildExportCompletion({
        conversationId: 'c_empty',
        conversation: emptyChat,
        titleCandidate: 'Empty Chat'
    });

    const batchEmpty = buildExportCompletion({
        conversationId: 'c_empty',
        conversation: emptyChat,
        titleCandidate: 'Empty Chat',
        messageCount: 0
    });

    assert.strictEqual(liveEmpty.exportRecord.status, 'empty');
    assert.strictEqual(batchEmpty.exportRecord.status, 'empty');
    assert.strictEqual(liveEmpty.exportRecord.messageCount, 0);
    assert.strictEqual(batchEmpty.exportRecord.messageCount, 0);
});

// 12. Parity E: Failed override priority prevents asset failure downgrade
test('12. Parity E: Failed override priority prevents asset failure downgrade', () => {
    // 1. In resolveExportRecordStatus directly
    const failedWithAssets = resolveExportRecordStatus({
        statusOverride: 'failed',
        failedAssetsCount: 3,
        messageCount: 5
    });
    assert.strictEqual(failedWithAssets.status, 'failed', 'Hard failure must not be downgraded to partial by failed assets');
    assert.strictEqual(failedWithAssets.hasFailedAssets, true);

    const failedNoAssets = resolveExportRecordStatus({
        statusOverride: 'failed',
        failedAssetsCount: 0,
        messageCount: 5
    });
    assert.strictEqual(failedNoAssets.status, 'failed');
    assert.strictEqual(failedNoAssets.hasFailedAssets, false);

    // 2. Via applyAssetFailureToExportRecord
    const record = { status: 'failed', hasFailedAssets: false };
    applyAssetFailureToExportRecord(record);
    assert.strictEqual(record.status, 'failed', 'applyAssetFailureToExportRecord must preserve failed status');
    assert.strictEqual(record.hasFailedAssets, true);
});

// 13. Parity F: Adapter contract rejection when persistence methods are missing
test('13. Parity F: Adapter contract rejects when adapter lacks persistence methods', async () => {
    const invalidAdapter = {
        someOtherMethod: () => {}
    };

    await assert.rejects(async () => {
        await completeConversationExport(
            invalidAdapter,
            'u0',
            { conversationId: 'c_invalid_adapter', titleCandidate: 'Invalid Adapter Chat' }
        );
    }, /storageAdapter must implement finalizeConversationExport or saveExportRecord/);
});

// 14. Parity G: Concurrency and callback guarantees in sessionRecovery
test('14. Parity G: Concurrency claim and callback guarantees in sessionRecovery', async () => {
    const { mockStorage, chrome } = createMockChromeStorage({ gemini_conversations: [] });
    const origChrome = (global as any).chrome;
    (global as any).chrome = chrome;

    try {
        const finalizedChatsSet = new Set<string>();
        const chatRecordsMap = new Map<string, any>([
            ['conc_test', {
                title: 'Concurrency Test',
                status: 'ok',
                messageCount: 1,
                exportedAt: new Date().toISOString()
            }]
        ]);

        let callbackCalls = 0;
        const context = {
            finalizedChatsSet,
            chatRecordsMap,
            Storage: StorageService,
            storageAdapter: StorageService,
            slot: 'u0',
            onItemExported: () => {
                callbackCalls++;
            }
        };

        // First call succeeds
        const res1 = await finalizeChatExport('c_conc_test', context);
        assert.strictEqual(res1, true);
        assert.strictEqual(callbackCalls, 1);
        assert.ok(finalizedChatsSet.has('conc_test'));

        // Second duplicate call is deduped and returns false without invoking callback
        const res2 = await finalizeChatExport('c_conc_test', context);
        assert.strictEqual(res2, false);
        assert.strictEqual(callbackCalls, 1, 'Callback must not be invoked on duplicate finalize');

        // Claim release on persistence failure
        const brokenSet = new Set<string>();
        const brokenContext = {
            finalizedChatsSet: brokenSet,
            chatRecordsMap: new Map<string, any>([['broken_id', { title: 'Broken', status: 'ok' }]]),
            storageAdapter: {
                saveExportRecord: async () => { throw new Error('Persist error'); }
            },
            slot: 'u0'
        };

        await assert.rejects(async () => {
            await finalizeChatExport('broken_id', brokenContext);
        }, /Persist error/);

        assert.strictEqual(brokenSet.has('broken_id'), false, 'Claim must be released on persistence failure');
    } finally {
        (global as any).chrome = origChrome;
    }
});

// 15. Targeted Provenance A: default chat source falls back to RPC list source
test('15. Targeted Provenance A: default chat source falls back to RPC list source', async () => {
    const { mockStorage, chrome } = createMockChromeStorage({
        gemini_conversations: [
            { id: 'c_prov_rpc', title: '未命名对话', titleSource: 'default', messageCount: 1 }
        ]
    });
    const origChrome = (global as any).chrome;
    (global as any).chrome = chrome;

    try {
        const chat: any = {
            id: 'c_prov_rpc',
            title: 'Real RPC Title',
            titleSource: 'default'
        };
        const listC = {
            id: 'c_prov_rpc',
            titleSource: 'rpc',
            titles: {
                rpc: 'Real RPC Title'
            }
        };

        const titleProvenance = resolveReliableTitleSource(chat.titleSource, listC.titleSource);
        assert.strictEqual(titleProvenance, 'rpc');

        const completion = buildExportCompletion({
            conversation: chat,
            conversationId: 'c_prov_rpc',
            titleCandidate: chat.title,
            titleProvenance,
            titles: { ...(listC?.titles || {}), ...(chat.titles || {}) }
        });

        assert.strictEqual(completion.exportRecord.title, 'Real RPC Title');
        assert.strictEqual(completion.conversationUpdate.titleSource, 'rpc');

        await StorageService.finalizeConversationExport(
            'u0',
            completion.targetId,
            completion.exportRecord,
            { conversationUpdate: completion.conversationUpdate }
        );

        const convs = mockStorage.gemini_conversations;
        const saved = convs.find((c: any) => normId(c.id) === 'prov_rpc');
        assert.ok(saved);
        assert.strictEqual(saved.title, 'Real RPC Title');
        assert.strictEqual(saved.titleSource, 'rpc');
    } finally {
        (global as any).chrome = origChrome;
    }
});

// 16. Targeted Provenance B: default chat source falls back to api-detail
test('16. Targeted Provenance B: default chat source falls back to api-detail', async () => {
    const { mockStorage, chrome } = createMockChromeStorage({
        gemini_conversations: [
            { id: 'c_prov_api', title: '未命名对话', titleSource: 'default', messageCount: 1 }
        ]
    });
    const origChrome = (global as any).chrome;
    (global as any).chrome = chrome;

    try {
        const chat: any = {
            id: 'c_prov_api',
            title: 'Real API Detail Title',
            titleSource: 'default'
        };
        const listC = {
            id: 'c_prov_api',
            titleSource: 'api-detail',
            titles: {
                'api-detail': 'Real API Detail Title'
            }
        };

        const titleProvenance = resolveReliableTitleSource(chat.titleSource, listC.titleSource);
        assert.strictEqual(titleProvenance, 'api-detail');

        const completion = buildExportCompletion({
            conversation: chat,
            conversationId: 'c_prov_api',
            titleCandidate: chat.title,
            titleProvenance,
            titles: { ...(listC?.titles || {}), ...(chat.titles || {}) }
        });

        assert.strictEqual(completion.exportRecord.title, 'Real API Detail Title');
        assert.strictEqual(completion.conversationUpdate.titleSource, 'api-detail');

        await StorageService.finalizeConversationExport(
            'u0',
            completion.targetId,
            completion.exportRecord,
            { conversationUpdate: completion.conversationUpdate }
        );

        const convs = mockStorage.gemini_conversations;
        const saved = convs.find((c: any) => normId(c.id) === 'prov_api');
        assert.ok(saved);
        assert.strictEqual(saved.title, 'Real API Detail Title');
        assert.strictEqual(saved.titleSource, 'api-detail');
    } finally {
        (global as any).chrome = origChrome;
    }
});

// 17. Targeted Provenance C: default chat source falls back to takeout
test('17. Targeted Provenance C: default chat source falls back to takeout', async () => {
    const { mockStorage, chrome } = createMockChromeStorage({
        gemini_conversations: [
            { id: 'c_prov_takeout', title: '未命名对话', titleSource: 'default', messageCount: 1 }
        ]
    });
    const origChrome = (global as any).chrome;
    (global as any).chrome = chrome;

    try {
        const chat: any = {
            id: 'c_prov_takeout',
            title: 'Real Takeout Title',
            titleSource: 'default'
        };
        const listC = {
            id: 'c_prov_takeout',
            titleSource: 'takeout',
            titles: {
                takeout: 'Real Takeout Title'
            }
        };

        const titleProvenance = resolveReliableTitleSource(chat.titleSource, listC.titleSource);
        assert.strictEqual(titleProvenance, 'takeout');

        const completion = buildExportCompletion({
            conversation: chat,
            conversationId: 'c_prov_takeout',
            titleCandidate: chat.title,
            titleProvenance,
            titles: { ...(listC?.titles || {}), ...(chat.titles || {}) }
        });

        assert.strictEqual(completion.exportRecord.title, 'Real Takeout Title');
        assert.strictEqual(completion.conversationUpdate.titleSource, 'takeout');

        await StorageService.finalizeConversationExport(
            'u0',
            completion.targetId,
            completion.exportRecord,
            { conversationUpdate: completion.conversationUpdate }
        );

        const convs = mockStorage.gemini_conversations;
        const saved = convs.find((c: any) => normId(c.id) === 'prov_takeout');
        assert.ok(saved);
        assert.strictEqual(saved.title, 'Real Takeout Title');
        assert.strictEqual(saved.titleSource, 'takeout');
    } finally {
        (global as any).chrome = origChrome;
    }
});

// 18. Targeted Provenance D: unreliable sources do not fabricate provenance
test('18. Targeted Provenance D: unreliable sources do not fabricate provenance', async () => {
    const { mockStorage, chrome } = createMockChromeStorage({
        gemini_conversations: [
            { id: 'c_prov_unreliable', title: '未命名对话', titleSource: 'default', messageCount: 1 }
        ]
    });
    const origChrome = (global as any).chrome;
    (global as any).chrome = chrome;

    try {
        const chat: any = {
            id: 'c_prov_unreliable',
            title: 'Unprovenanced Real Title',
            titleSource: 'default'
        };
        const listC = {
            id: 'c_prov_unreliable',
            titleSource: 'legacy',
            titles: {
                legacy: 'Unprovenanced Real Title'
            }
        };

        const titleProvenance = resolveReliableTitleSource(chat.titleSource, listC.titleSource);
        assert.strictEqual(titleProvenance, undefined, 'Neither default nor legacy can be treated as reliable provenance');

        const completion = buildExportCompletion({
            conversation: chat,
            conversationId: 'c_prov_unreliable',
            titleCandidate: chat.title,
            titleProvenance,
            titles: { ...(listC?.titles || {}), ...(chat.titles || {}) }
        });

        assert.strictEqual(completion.exportRecord.title, 'Unprovenanced Real Title');
        assert.strictEqual(completion.conversationUpdate.titleSource, undefined, 'Must not fabricate rpc/api-detail provenance');

        await StorageService.finalizeConversationExport(
            'u0',
            completion.targetId,
            completion.exportRecord,
            { conversationUpdate: completion.conversationUpdate }
        );

        const convs = mockStorage.gemini_conversations;
        const saved = convs.find((c: any) => normId(c.id) === 'prov_unreliable');
        assert.ok(saved);
        assert.strictEqual(saved.title, 'Unprovenanced Real Title');
        // Promoted to legacy via candidate rule, never fabricating rpc or api-detail
        assert.strictEqual(saved.titleSource, 'legacy');
    } finally {
        (global as any).chrome = origChrome;
    }
});

// 19. Adapter Contract E: adapter with only finalizeConversationExport
test('19. Adapter Contract E: adapter with only finalizeConversationExport is accepted by sessionRecovery', async () => {
    let finalizeCalls = 0;
    let finalizeArgs: any = null;
    let callbackCalls = 0;

    const mockAdapter = {
        finalizeConversationExport: async (slot: string, id: string, rec: any, options: any) => {
            finalizeCalls++;
            finalizeArgs = { slot, id, rec, options };
            if (options?.onItemExported) {
                options.onItemExported(id, rec);
            }
        }
    };

    const finalizedChatsSet = new Set<string>();
    const chatRecordsMap = new Map<string, any>([
        ['c_fin_only', {
            exportRecord: {
                title: 'Finalize Only Chat',
                status: 'ok',
                messageCount: 3,
                exportedAt: new Date().toISOString()
            },
            conversationUpdate: {
                title: 'Finalize Only Chat',
                titleSource: 'rpc',
                messageCount: 3
            },
            targetId: 'fin_only'
        }]
    ]);

    const context = {
        finalizedChatsSet,
        chatRecordsMap,
        storageAdapter: mockAdapter,
        slot: 'u1',
        onItemExported: (id: string, rec: any) => {
            callbackCalls++;
        }
    };

    const res = await finalizeChatExport('c_fin_only', context);
    assert.strictEqual(res, true);
    assert.strictEqual(finalizeCalls, 1);
    assert.strictEqual(callbackCalls, 1);
    assert.strictEqual(finalizeArgs.id, 'c_fin_only');
    assert.strictEqual(finalizeArgs.slot, 'u1');
    assert.strictEqual(finalizeArgs.options.conversationUpdate.titleSource, 'rpc');
    assert.ok(finalizedChatsSet.has('fin_only'));
});

// 20. Adapter Contract F: adapter with neither finalizeConversationExport nor saveExportRecord is rejected
test('20. Adapter Contract F: adapter with neither finalizeConversationExport nor saveExportRecord is rejected', async () => {
    const brokenAdapter = {
        someOtherMethod: () => {}
    };

    const context = {
        chatRecordsMap: new Map<string, any>([
            ['c_broken', { title: 'Broken Chat', status: 'ok' }]
        ]),
        storageAdapter: brokenAdapter,
        slot: 'u0'
    };

    await assert.rejects(async () => {
        await finalizeChatExport('c_broken', context);
    }, /adapter must implement finalizeConversationExport or saveExportRecord/);
});

// ============================================================================
// ADVERSARIAL PROVENANCE BOUNDARY TEST MATRIX (Scenarios A through J)
// ============================================================================

// Matrix A: Unknown titles-only input has zero influence
test('21. Adversarial Matrix A: unknown titles-only input has zero influence', () => {
    const existing: any = {
        id: 'c_adv_a',
        title: '未命名对话',
        titleSource: 'default',
        titles: {}
    };
    const incoming: any = {
        titles: {
            'random-source': 'Dirty Title'
        }
    };

    applyExportTitleWriteback(existing, incoming);
    assert.strictEqual(existing.title, '未命名对话');
    assert.strictEqual(existing.titleSource, 'default');
    assert.strictEqual(existing.titles['random-source'], undefined);
    assert.strictEqual(existing.titles.legacy, undefined);
    assertCanonicalTitleProvenance(existing);
});

// Matrix B: export titles-only input has zero influence
test('22. Adversarial Matrix B: export titles-only input has zero influence', () => {
    const existing: any = {
        id: 'c_adv_b',
        title: '未命名对话',
        titleSource: 'default',
        titles: {}
    };
    const incoming: any = {
        titles: {
            export: 'Export Title'
        }
    };

    applyExportTitleWriteback(existing, incoming);
    assert.strictEqual(existing.title, '未命名对话');
    assert.strictEqual(existing.titleSource, 'default');
    assert.strictEqual(existing.titles.export, undefined);
    assert.strictEqual(existing.titles.legacy, undefined);
    assertCanonicalTitleProvenance(existing);
});

// Matrix C: Unknown titleSource + explicit incoming.title promotes as legacy
test('23. Adversarial Matrix C: unknown titleSource + explicit incoming.title promotes as legacy', async () => {
    const existing: any = {
        id: 'c_adv_c',
        title: '未命名对话',
        titleSource: 'default',
        titles: {}
    };
    const incoming: any = {
        title: 'Real Title',
        titleSource: 'random-source'
    };

    applyExportTitleWriteback(existing, incoming);
    assert.strictEqual(existing.title, 'Real Title');
    assert.strictEqual(existing.titleSource, 'legacy');
    assert.strictEqual(existing.titles.legacy, 'Real Title');
    assert.strictEqual(existing.titles['random-source'], undefined);
    assertCanonicalTitleProvenance(existing);

    // Also verify persistence in Chrome storage
    const { mockStorage, chrome } = createMockChromeStorage({
        gemini_conversations: [
            { id: 'c_adv_c', title: '未命名对话', titleSource: 'default', messageCount: 1 }
        ]
    });
    const origChrome = (global as any).chrome;
    (global as any).chrome = chrome;

    try {
        await StorageService.finalizeConversationExport(
            'u0',
            'c_adv_c',
            { title: 'Real Title', status: 'ok', exportedAt: new Date().toISOString() },
            {
                conversationUpdate: {
                    title: 'Real Title',
                    titleSource: 'random-source'
                }
            }
        );

        const saved = mockStorage.gemini_conversations.find((c: any) => normId(c.id) === normId('c_adv_c'));
        assert.ok(saved);
        assert.strictEqual(saved.title, 'Real Title');
        assert.strictEqual(saved.titleSource, 'legacy');
        assert.strictEqual(saved.titles?.['random-source'], undefined);
        assertCanonicalTitleProvenance(saved);
    } finally {
        (global as any).chrome = origChrome;
    }
});

// Matrix D: Unknown slot + reliable slot
test('24. Adversarial Matrix D: unknown slot is dropped while reliable slot arbitrates', async () => {
    const existing: any = {
        id: 'c_adv_d',
        title: '未命名对话',
        titleSource: 'default',
        titles: {}
    };
    const incoming: any = {
        titles: {
            'random-source': 'Dirty',
            rpc: 'RPC Title'
        }
    };

    applyExportTitleWriteback(existing, incoming);
    assert.strictEqual(existing.title, 'RPC Title');
    assert.strictEqual(existing.titleSource, 'rpc');
    assert.strictEqual(existing.titles.rpc, 'RPC Title');
    assert.strictEqual(existing.titles['random-source'], undefined);
    assertCanonicalTitleProvenance(existing);
});

// Matrix E: Reliable source + conflicting explicit title
test('25. Adversarial Matrix E: reliable source + explicit title preserves canonical arbitration', () => {
    const existing: any = {
        id: 'c_adv_e',
        title: '未命名对话',
        titleSource: 'default',
        titles: {}
    };
    const incoming: any = {
        title: 'RPC Title',
        titleSource: 'rpc',
        titles: {
            rpc: 'RPC Title'
        }
    };

    applyExportTitleWriteback(existing, incoming);
    assert.strictEqual(existing.title, 'RPC Title');
    assert.strictEqual(existing.titleSource, 'rpc');
    assert.strictEqual(existing.titles.rpc, 'RPC Title');
    assertCanonicalTitleProvenance(existing);
});

// Matrix F: Existing real authoritative title not influenced by unknown input
test('26. Adversarial Matrix F: existing real authoritative title not influenced by unknown input', () => {
    const existing: any = {
        id: 'c_adv_f',
        title: 'RPC Title',
        titleSource: 'rpc',
        titles: {
            rpc: 'RPC Title'
        }
    };
    const incoming: any = {
        title: 'Unknown Candidate',
        titleSource: 'random-source',
        titles: {
            'random-source': 'Dirty'
        }
    };

    applyExportTitleWriteback(existing, incoming);
    assert.strictEqual(existing.title, 'RPC Title');
    assert.strictEqual(existing.titleSource, 'rpc');
    assert.strictEqual(existing.titles.rpc, 'RPC Title');
    assert.strictEqual(existing.titles['random-source'], undefined);
    assert.strictEqual(existing.titles.legacy, undefined);
    assertCanonicalTitleProvenance(existing);
});

// Matrix G: Existing generic + plain unprovenanced title promotes as legacy
test('27. Adversarial Matrix G: existing generic + plain unprovenanced title promotes as legacy', () => {
    const existing: any = {
        id: 'c_adv_g',
        title: '未命名对话',
        titleSource: 'default',
        titles: {}
    };
    const incoming: any = {
        title: 'Real Unprovenanced Title'
    };

    applyExportTitleWriteback(existing, incoming);
    assert.strictEqual(existing.title, 'Real Unprovenanced Title');
    assert.strictEqual(existing.titleSource, 'legacy');
    assert.strictEqual(existing.titles.legacy, 'Real Unprovenanced Title');
    assertCanonicalTitleProvenance(existing);
});

// Matrix H: setTitleBySource dirty-source direct call is strictly non-polluting
test('28. Adversarial Matrix H: setTitleBySource dirty-source direct call is strictly non-polluting', () => {
    // 1. Generic chat
    const chat: any = {
        id: 'c_adv_h',
        title: '未命名对话',
        titleSource: 'default',
        titles: {}
    };
    const res = setTitleBySource(chat, 'random-source', 'Dirty');
    assert.strictEqual(chat.titles['random-source'], undefined);
    assert.strictEqual(chat.titleSource, 'default');
    assert.strictEqual(chat.title, '未命名对话');
    assert.strictEqual(res.source, 'default');
    assertCanonicalTitleProvenance(chat);

    // 2. Real authoritative chat
    const chat2: any = {
        id: 'c_adv_h2',
        title: 'Authoritative RPC',
        titleSource: 'rpc',
        titles: { rpc: 'Authoritative RPC' }
    };
    const res2 = setTitleBySource(chat2, 'random-source', 'Dirty');
    assert.strictEqual(chat2.titles['random-source'], undefined);
    assert.strictEqual(chat2.titleSource, 'rpc');
    assert.strictEqual(chat2.title, 'Authoritative RPC');
    assert.strictEqual(res2.source, 'rpc');
    assertCanonicalTitleProvenance(chat2);
});

// Matrix I: Fresh conversation registration with dirty metadata purges dirty source
test('29. Adversarial Matrix I: fresh conversation registration purges dirty metadata and ensures canonical consistency', async () => {
    const { mockStorage, chrome } = createMockChromeStorage({
        gemini_conversations: []
    });
    const origChrome = (global as any).chrome;
    (global as any).chrome = chrome;

    try {
        await StorageService.finalizeConversationExport(
            'u0',
            'fresh_dirty',
            { title: 'Real', status: 'ok', exportedAt: new Date().toISOString() },
            {
                conversationUpdate: {
                    title: 'Real',
                    titleSource: 'random-source',
                    titles: {
                        'random-source': 'Dirty',
                        rpc: 'RPC'
                    }
                }
            }
        );

        const saved = mockStorage.gemini_conversations.find((c: any) => normId(c.id) === 'fresh_dirty');
        assert.ok(saved, 'fresh conversation must be registered');
        assert.strictEqual(saved.titles['random-source'], undefined, 'dirty slot must not exist');
        assert.strictEqual(saved.titles.rpc, 'RPC', 'reliable rpc must be preserved in titles');
        assert.strictEqual(saved.title, 'RPC', 'canonical title must arbitrate to rpc');
        assert.strictEqual(saved.titleSource, 'rpc', 'canonical titleSource must arbitrate to rpc');
        assertCanonicalTitleProvenance(saved);
    } finally {
        (global as any).chrome = origChrome;
    }
});

// Matrix J: BatchWorker merge dirty map
test('30. Adversarial Matrix J: BatchWorker merge dirty map filters non-canonical source slots', async () => {
    const chat: any = {
        id: 'c_adv_j',
        title: 'RPC Title',
        messages: [{ role: 'user', content: 'hello' }],
        titles: {
            'random-source': 'Dirty',
            rpc: 'RPC Title'
        }
    };
    const listConversation: any = {
        id: 'c_adv_j',
        title: '未命名对话',
        titleSource: 'default',
        titles: {}
    };

    await resolveChat(chat, { id: 'c_adv_j' }, listConversation);

    assert.strictEqual(listConversation.titles['random-source'], undefined, 'random-source must be excluded');
    assert.strictEqual(listConversation.titles.rpc, 'RPC Title', 'rpc slot must be preserved');
    assert.strictEqual(listConversation.title, 'RPC Title', 'resolved title must be RPC Title');
    assert.strictEqual(listConversation.titleSource, 'rpc', 'resolved titleSource must be rpc');
    assertCanonicalTitleProvenance(listConversation);
});


