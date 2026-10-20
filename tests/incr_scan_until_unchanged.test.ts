/**
 * 增量同步语义回归测试。
 *
 * 历史：这里曾钉住 pagination 的"连续 5 条时间戳未变化就早退"分支
 * （existingMap + unchangedThreshold）。该策略已被 checkpoint 水位闭环取代，
 * 生产路径恒传 onPageBatch、无调用方再传 existingMap，分支已删除，
 * 相关测试一并移除。
 *
 * 保留的契约：
 *   1. resolveListSyncMode 不再做基线预判（条数 proxy 已删除）、不再给增量设
 *      小页数上限：增量默认 maxPages = 2000（与全量同一上限，纯防死循环）。
 *   2. 无基线（新安装/本地为空）时，扫描自然走到服务端尽头才停 ——
 *      等价于一次全量，不需要基线检查。
 *
 * 运行: node -r ./tests/ts_register.js --test tests/incr_scan_until_unchanged.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const Pagination = require('../src/core/api/client/pagination.js');
const { resolveListSyncMode } = require('../src/content/syncEngine.js');

const NOW = 1757980000000;

function listItem(id: string, tsMs: number, title: string) {
    return {
        id,
        title,
        titleSource: 'rpc',
        titles: { rpc: title },
        createdAt: tsMs - 86400000,
        updatedAt: tsMs,
        chatTime: tsMs,
        timestamp: tsMs,
        messageCount: 3,
        url: `https://gemini.google.com/app/${id}`,
    };
}

// ---- 1. 模式决策：纯语义，无基线预判、无小页数上限 ----

test('resolveListSyncMode: 默认与 forceIncremental 都是增量，上限 2000（不再 2 页截断）', () => {
    for (const opts of [undefined, {}, { forceIncremental: true } as any]) {
        const r = resolveListSyncMode(opts);
        assert.strictEqual(r.useIncremental, true);
        assert.strictEqual(r.maxPages, 2000);
    }
});

test('resolveListSyncMode: forceFull 切全量，上限同样 2000', () => {
    const r = resolveListSyncMode({ forceFull: true });
    assert.strictEqual(r.useIncremental, false);
    assert.strictEqual(r.maxPages, 2000);
});

test('resolveListSyncMode: 显式 maxPages 仍然生效', () => {
    const r = resolveListSyncMode({ maxPages: 7 });
    assert.strictEqual(r.maxPages, 7);
    assert.strictEqual(r.useIncremental, true);
});

// ---- 2. 无基线：自然扫到服务端尽头，等价于全量 ----

test('无基线（本地为空）：扫到服务端尽头自然结束', async () => {
    const pages: any[][] = [];
    for (let p = 0; p < 3; p++) {
        const page: any[] = [];
        for (let k = 0; k < 50; k++) {
            const idx = p * 50 + k;
            page.push(listItem(`c${idx}`, NOW - idx * 60000, `Chat ${idx}`));
        }
        pages.push(page);
    }
    let calls = 0;
    const client: any = {
        aborted: false,
        getConversationList: async () => {
            const page = pages[Math.min(calls, pages.length - 1)];
            const hasMore = calls < pages.length - 1;
            calls++;
            return { conversations: page, nextPageToken: hasMore ? `tok${calls}` : null };
        },
    };
    const savedIds = new Set<string>();
    const res: any = await Pagination.getAllConversations(client, {
        maxPages: 2000,
        incremental: true,
        onProgress: (prog: any) => {
            if (prog.batch && prog.batch.length) {
                for (const c of prog.batch) savedIds.add(c.id);
            }
        },
    });
    assert.strictEqual(calls, 3, '应扫完全部 3 页');
    assert.strictEqual(savedIds.size, 150, '150 条应全部交付');
    assert.strictEqual(res.stoppedEarly, undefined, '自然结束不应标记 stoppedEarly');
});
