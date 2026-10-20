export {};
const test = require('node:test');
const assert = require('node:assert');
const StorageService = require('../src/core/storage/storageService.js');
const SyncEngine = require('../src/content/syncEngine.js');
const { __setModuleOverride, __getModuleOverride } = require('../src/core/utils/moduleOverrides.js');
const Pagination = require('../src/core/api/client/pagination.js');

function mockStorageContext(initialCheckpoint: number | null = null) {
    let savedList: any[] = [];
    let checkpoint: number | null = initialCheckpoint;
    const localStore: Record<string, any> = {};
    if (initialCheckpoint !== null) {
        localStore['gemini_scan_checkpoint'] = initialCheckpoint;
    }

    const mockStorage = {
        getConversations: async () => [...savedList],
        transactConversations: async (_slot: string, updater: any) => {
            const res = updater([...savedList]);
            if (res && res.list) savedList = res.list;
            return { list: savedList, changed: res?.changed || 0, written: !!res };
        },
        setLastSync: async () => {},
        updateAccountSlot: async () => {},
        getScanCheckpoint: async (_slot?: string | null) => checkpoint,
        setScanCheckpoint: async (_slot: string | null | undefined, ts: number | null) => {
            checkpoint = ts;
            if (ts !== null) {
                localStore['gemini_scan_checkpoint'] = ts;
            } else {
                delete localStore['gemini_scan_checkpoint'];
            }
        }
    };

    (global as any).chrome = {
        runtime: {
            sendMessage: () => {}
        },
        storage: {
            local: {
                get: async (keys: any) => {
                    if (keys === null) return { ...localStore };
                    if (typeof keys === 'string') keys = [keys];
                    const out: Record<string, any> = {};
                    for (const k of (keys || [])) {
                        if (k in localStore) out[k] = localStore[k];
                    }
                    return out;
                },
                set: async (obj: any) => {
                    Object.assign(localStore, obj);
                },
                remove: async (keys: any) => {
                    if (typeof keys === 'string') keys = [keys];
                    for (const k of (keys || [])) delete localStore[k];
                }
            }
        }
    };
    __setModuleOverride('StorageService', mockStorage);

    return {
        getSavedList: () => savedList,
        getCheckpoint: () => checkpoint,
        setCheckpoint: (ts: number | null) => { checkpoint = ts; },
        mockStorage
    };
}

function makeItem(id: string, timestamp: number, title: string = `Chat ${id}`) {
    return {
        id,
        title,
        titleSource: 'rpc',
        titles: { rpc: title },
        timestamp,
        updatedAt: timestamp,
        createdAt: timestamp - 3600000,
        url: `https://gemini.google.com/app/${id}`
    };
}

test('1. StorageService - scan checkpoint persistence and slot isolation', async () => {
    const origChrome = (global as any).chrome;
    const prevStorageOverride = __getModuleOverride('StorageService');
    __setModuleOverride('StorageService', undefined as any); // ensure the real module is used

    const mockStorage: Record<string, any> = {};
    (global as any).chrome = {
        storage: {
            local: {
                get: async (keys: any) => {
                    if (keys === null) return { ...mockStorage };
                    if (typeof keys === 'string') keys = [keys];
                    const res: Record<string, any> = {};
                    for (const k of (keys || [])) {
                        if (k in mockStorage) res[k] = mockStorage[k];
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
    };

    try {
        // Initially null
        assert.strictEqual(await StorageService.getScanCheckpoint('u0'), null);
        assert.strictEqual(await StorageService.getScanCheckpoint('u1'), null);

        // Set u0
        await StorageService.setScanCheckpoint('u0', 1700000100000);
        assert.strictEqual(mockStorage['gemini_scan_checkpoint'], 1700000100000);
        assert.strictEqual(await StorageService.getScanCheckpoint('u0'), 1700000100000);
        assert.strictEqual(await StorageService.getScanCheckpoint('u1'), null);

        // Set u1
        await StorageService.setScanCheckpoint('u1', 1700000200000);
        assert.strictEqual(mockStorage['gemini_scan_checkpoint_u1'], 1700000200000);
        assert.strictEqual(await StorageService.getScanCheckpoint('u1'), 1700000200000);
        assert.strictEqual(await StorageService.getScanCheckpoint('u0'), 1700000100000);

        // Clear u0 with null
        await StorageService.setScanCheckpoint('u0', null);
        assert.strictEqual(mockStorage['gemini_scan_checkpoint'], undefined);
        assert.strictEqual(await StorageService.getScanCheckpoint('u0'), null);
        assert.strictEqual(await StorageService.getScanCheckpoint('u1'), 1700000200000);
    } finally {
        (global as any).chrome = origChrome;
        __setModuleOverride('StorageService', prevStorageOverride);
    }
});

test('2. Cold start baseline rule - Sniffing batches NEVER establishes a baseline when checkpoint is null', async () => {
    const ctx = mockStorageContext(null);
    SyncEngine.resetSessionSlice();

    // Sniff Page 1 with conversations (use valid IDs with length >= 3)
    const batch = [
        makeItem('chat_c1', 1700000500000),
        makeItem('chat_c2', 1700000400000),
        makeItem('chat_c3', 1700000300000)
    ];

    const result = await SyncEngine.ingestListBatch(batch, 'network-list', { isPage1: true });

    // Should save conversations into storage via Fail-Closed upsert
    assert.strictEqual(result.count, 3);
    assert.strictEqual(ctx.getSavedList().length, 3);

    // But should NEVER create or advance watermark
    assert.strictEqual(result.reachedWatermark, false, 'Cold start must not report reachedWatermark');
    assert.strictEqual(result.establishedBaseline, false, 'Cold start sniffing must not establish baseline');
    assert.strictEqual(result.newWatermark, null, 'Watermark must remain null');
    assert.strictEqual(ctx.getCheckpoint(), null, 'Storage checkpoint must remain null');
});

test('3. Full scan establishes baseline upon reaching end of history', async () => {
    const ctx = mockStorageContext(null);
    SyncEngine.resetSessionSlice();

    // Simulate full scan driving pages:
    // Page 1: [1700000500000, 1700000400000]
    await SyncEngine.ingestListBatch([
        makeItem('chat_c1', 1700000500000),
        makeItem('chat_c2', 1700000400000)
    ], 'batchexecute', { isPage1: true, participateInWatermark: true });

    // Page 2: [1700000300000, 1700000200000]
    await SyncEngine.ingestListBatch([
        makeItem('chat_c3', 1700000300000),
        makeItem('chat_c4', 1700000200000)
    ], 'batchexecute', { isPage1: false, participateInWatermark: true });

    // Checkpoint still null during traversal
    assert.strictEqual(ctx.getCheckpoint(), null);

    // Full scan reaches natural end: notify with isFullScanComplete: true
    const finalRes = await SyncEngine.ingestListBatch([], 'batchexecute', { isFullScanComplete: true, participateInWatermark: true });

    assert.strictEqual(finalRes.establishedBaseline, true);
    assert.strictEqual(finalRes.newWatermark, 1700000500000, 'Baseline anchored to Page 1 max timestamp');
    assert.strictEqual(ctx.getCheckpoint(), 1700000500000, 'Storage checkpoint saved with Page 1 max timestamp');
});

test('4. Sniffing NEVER advances watermark even when the batch crosses it (data still written)', async () => {
    // Phase A (P1-3): 嗅探是数据面，不参与水位。即使批次跨过水位线，
    // 水位也不能动——只有扫描控制面（participateInWatermark: true）能推进水位。
    const BASELINE = 1700000500000;
    const ctx = mockStorageContext(BASELINE);
    SyncEngine.resetSessionSlice();

    // Sniff Page 1 with new items (max = 1700000800000) and items crossing the checkpoint (min = 1700000400000 <= 1700000500000)
    const freshBatch = [
        makeItem('chat_new1', 1700000800000),
        makeItem('chat_new2', 1700000700000),
        makeItem('chat_c1', 1700000500000),
        makeItem('chat_c2', 1700000400000)
    ];

    const result = await SyncEngine.ingestListBatch(freshBatch, 'network-list', { isPage1: true });

    // 数据面：4 条全部入库
    assert.strictEqual(result.count, 4, 'Sniffed data must still be written');
    assert.strictEqual(ctx.getSavedList().length, 4, 'Sniffed conversations must reach storage');

    // 控制面：水位纹丝不动
    assert.strictEqual(result.reachedWatermark, false, 'Sniffing must never report reachedWatermark');
    assert.strictEqual(result.newWatermark, BASELINE, 'Watermark must not advance on sniff');
    assert.strictEqual(ctx.getCheckpoint(), BASELINE, 'Storage checkpoint must stay at baseline');
});

test('5. Gap detection - Sniffing strictly above watermark rejects advancement', async () => {
    const BASELINE = 1700000500000;
    const ctx = mockStorageContext(BASELINE);
    SyncEngine.resetSessionSlice();

    // Sniff Page 1 where min timestamp is strictly greater than checkpoint (e.g. 1700000750000 > 1700000500000 + 60s)
    const gappedBatch = [
        makeItem('chat_gap1', 1700000900000),
        makeItem('chat_gap2', 1700000750000)
    ];

    const result = await SyncEngine.ingestListBatch(gappedBatch, 'network-list', { isPage1: true });

    assert.strictEqual(result.reachedWatermark, false, 'Gap detected: batch min > checkpoint, must NOT report reachedWatermark');
    assert.strictEqual(result.newWatermark, BASELINE, 'Watermark must NOT advance');
    assert.strictEqual(ctx.getCheckpoint(), BASELINE, 'Storage checkpoint remains at old baseline');
});

test('6. Multi-page domino chaining - Connecting Page 1 -> Page 2 -> Page 3 across watermark', async () => {
    const BASELINE = 1700000500000;
    const ctx = mockStorageContext(BASELINE);
    SyncEngine.resetSessionSlice();

    // Page 1 arrives via sniffing: [1700000900000 .. 1700000800000] (gap to 500k)
    const p1Res = await SyncEngine.ingestListBatch([
        makeItem('chat_p1_1', 1700000900000),
        makeItem('chat_p1_2', 1700000800000)
    ], 'network-list', { isPage1: true, participateInWatermark: true });
    assert.strictEqual(p1Res.reachedWatermark, false, 'Page 1 has gap, cannot advance');
    assert.strictEqual(ctx.getCheckpoint(), BASELINE);

    // Page 2 arrives via sniffing: [1700000790000 .. 1700000650000] (connects with 800k, but min 650k still > 500k)
    const p2Res = await SyncEngine.ingestListBatch([
        makeItem('chat_p2_1', 1700000790000),
        makeItem('chat_p2_2', 1700000650000)
    ], 'network-list', { isPage1: false, participateInWatermark: true });
    assert.strictEqual(p2Res.reachedWatermark, false, 'Page 2 chains but still has gap to baseline');
    assert.strictEqual(ctx.getCheckpoint(), BASELINE);

    // Page 3 arrives via sniffing: [1700000640000 .. 1700000450000] (connects with 650k, and min 450k <= 500k touches baseline!)
    const p3Res = await SyncEngine.ingestListBatch([
        makeItem('chat_p3_1', 1700000640000),
        makeItem('chat_p3_2', 1700000450000)
    ], 'network-list', { isPage1: false, participateInWatermark: true });

    // Domino chain completed: [450k .. 900k] touches baseline 500k!
    assert.strictEqual(p3Res.reachedWatermark, true, 'Page 3 closes the chain to baseline');
    assert.strictEqual(p3Res.newWatermark, 1700000900000, 'Watermark advances all the way to Page 1 head (900k)');
    assert.strictEqual(ctx.getCheckpoint(), 1700000900000, 'Storage checkpoint updated to Page 1 head');
});

test('7. Scanner stateless page driver - Early exits cleanly without timestamp math inside pagination', async () => {
    // Mock Client that yields pages
    const pages = [
        [makeItem('chat_p1_a', 1000), makeItem('chat_p1_b', 900)],
        [makeItem('chat_p2_a', 800), makeItem('chat_p2_b', 700)],
        [makeItem('chat_p3_a', 600), makeItem('chat_p3_b', 500)]
    ];

    let pageRequests = 0;
    const mockClient = {
        aborted: false,
        getConversationList: async (token?: string) => {
            const pageIndex = token ? parseInt(token, 10) : 0;
            pageRequests++;
            const items = pages[pageIndex] || [];
            const nextToken = pageIndex + 1 < pages.length ? String(pageIndex + 1) : null;
            return {
                conversations: items,
                nextPageToken: nextToken
            };
        }
    };

    let onPageBatchCallCount = 0;
    const res = await Pagination.getAllConversations(mockClient, {
        onPageBatch: async (batch: any[], meta: any) => {
            onPageBatchCallCount++;
            // On Page 2, consumer signals watermark reached
            if (meta.page === 2) {
                return { shouldStop: true, reason: 'watermark_reached' };
            }
            return { shouldStop: false };
        }
    });

    assert.strictEqual(pageRequests, 2, 'Scanner stopped after Page 2 without requesting Page 3');
    assert.strictEqual(onPageBatchCallCount, 2);
    assert.strictEqual(res.conversations.length, 4, 'Contains items from Page 1 and Page 2');
    assert.strictEqual(res.stoppedEarly, true);
    assert.strictEqual(res.diagnostics.stopReason, 'watermark_reached');
});

test('8. Force full scan ignores watermark checkpoint and recalibrates baseline at end', async () => {
    const BASELINE = 1700000500000;
    const ctx = mockStorageContext(BASELINE);
    SyncEngine.resetSessionSlice();

    // Page 1 with forceFull: true
    const p1Res = await SyncEngine.ingestListBatch([
        makeItem('chat_ff_1', 1700000900000),
        makeItem('chat_ff_2', 1700000800000)
    ], 'batchexecute', { isPage1: true, forceFull: true, participateInWatermark: true });
    assert.strictEqual(p1Res.reachedWatermark, false, 'forceFull must not early stop on watermark');

    // Page 2 with forceFull: true (min <= checkpoint, normally would early stop)
    const p2Res = await SyncEngine.ingestListBatch([
        makeItem('chat_ff_3', 1700000400000)
    ], 'batchexecute', { isPage1: false, forceFull: true, participateInWatermark: true });
    assert.strictEqual(p2Res.reachedWatermark, false, 'forceFull must continue through checkpoint');

    // Natural end reached
    const endRes = await SyncEngine.ingestListBatch([], 'batchexecute', { isFullScanComplete: true, participateInWatermark: true });
    assert.strictEqual(endRes.establishedBaseline, true);
    assert.strictEqual(endRes.newWatermark, 1700000900000, 'Baseline recalibrated to new Page 1 max');
    assert.strictEqual(ctx.getCheckpoint(), 1700000900000);
});

test('9. Deadzone Prevention - 35 conversations updated within 60s of checkpoint must NOT early stop on Page 1', async () => {
    // Checkpoint at T_cp = 1700000000000
    const CHECKPOINT = 1700000000000;
    const ctx = mockStorageContext(CHECKPOINT);
    SyncEngine.resetSessionSlice();

    // 35 conversations updated within (CHECKPOINT, CHECKPOINT + 50s]:
    // Page 1: 30 items, timestamps range from CHECKPOINT + 50s down to CHECKPOINT + 10s (min = CHECKPOINT + 10s)
    const page1Items = [];
    for (let i = 0; i < 30; i++) {
        // i = 0 -> CHECKPOINT + 50000; i = 29 -> CHECKPOINT + 10000
        const ts = CHECKPOINT + 50000 - i * 1379;
        page1Items.push(makeItem(`chat_dense_p1_${i}`, ts));
    }
    const page1Min = Math.min(...page1Items.map(c => c.timestamp));
    assert.ok(page1Min > CHECKPOINT, 'Page 1 min is strictly above checkpoint');
    assert.ok(page1Min < CHECKPOINT + 60000, 'Page 1 min falls inside the former 60s deadzone');

    // Ingest Page 1: MUST NOT trigger reachedWatermark because min > CHECKPOINT!
    const p1Res = await SyncEngine.ingestListBatch(page1Items, 'batchexecute', { isPage1: true, participateInWatermark: true });
    assert.strictEqual(p1Res.reachedWatermark, false, 'Page 1 MUST NOT report reachedWatermark; there are remaining items in Page 2');
    assert.strictEqual(ctx.getCheckpoint(), CHECKPOINT, 'Watermark MUST NOT advance on Page 1');

    // Page 2: 5 items, timestamps range from CHECKPOINT + 8s down to CHECKPOINT (or slightly below)
    const page2Items = [
        makeItem('chat_dense_p2_0', CHECKPOINT + 8000),
        makeItem('chat_dense_p2_1', CHECKPOINT + 5000),
        makeItem('chat_dense_p2_2', CHECKPOINT + 2000),
        makeItem('chat_dense_p2_3', CHECKPOINT),
        makeItem('chat_dense_p2_4', CHECKPOINT - 10000)
    ];

    // Ingest Page 2: min <= CHECKPOINT, now chain touches checkpoint!
    const p2Res = await SyncEngine.ingestListBatch(page2Items, 'batchexecute', { isPage1: false, participateInWatermark: true });
    assert.strictEqual(p2Res.reachedWatermark, true, 'Page 2 touches checkpoint, safely stops');
    assert.strictEqual(p2Res.newWatermark, page1Items[0].timestamp, 'Watermark advances to Page 1 head');
    assert.strictEqual(ctx.getCheckpoint(), page1Items[0].timestamp, 'Storage checkpoint updated to Page 1 head');

    // Verify all 35 conversations were saved into storage
    assert.strictEqual(ctx.getSavedList().length, 35, 'All 35 conversations ingested without silent loss');
});

test('10. Empty account baseline - Natural completion of full scan on 0 conversations anchors baseline', async () => {
    const ctx = mockStorageContext(null);
    SyncEngine.resetSessionSlice();

    // Account with 0 conversations completes full scan
    const beforeNow = Date.now();
    const res = await SyncEngine.ingestListBatch([], 'batchexecute', { isFullScanComplete: true, participateInWatermark: true });
    const afterNow = Date.now();

    assert.strictEqual(res.establishedBaseline, true);
    assert.ok(typeof res.newWatermark === 'number' && res.newWatermark >= beforeNow && res.newWatermark <= afterNow);
    assert.strictEqual(ctx.getCheckpoint(), res.newWatermark);
});

