/**
 * legacy fallback 标题槽守卫完备性测试（PR-5）。
 *
 * 背景：mergeConversation 的 legacy fallback 有两处手写标题槽枚举
 * （旧标题分支 / incoming 标题分支），曾写成
 * `!mergedTitles.legacy && !mergedTitles.rpc && !mergedTitles.dom && !mergedTitles.takeout`，
 * 漏了 `sniff`。后果：只有 sniff 槽有标题时，仍会凭空造一个 legacy 僵尸槽。
 * #413 合入后又多了一个真实槽 `api-detail`（rank 50，与 rpc 同级），同样必须进守卫。
 *
 * 修复：两处枚举收拢为 SSoT helper `hasAuthoritativeTitleSlot`，
 * 覆盖 rpc / api-detail / dom / takeout / sniff（`legacy` 自查、`default` 非权威，故意不进）。
 *
 * 运行：python3 tests/run_tests.py --filter title_slot_guard
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { mergeConversation } = require('../src/core/utils/mergeUtils.js');

const ID = 'c_9f2ab41c0d3e4f56';

test('sniff 槽有标题时：旧标题分支不再造 legacy 僵尸槽', () => {
    const old = {
        id: ID,
        title: '旧会话普通标题内容',
        // 注意：无 titleSource，才会走到 legacy fallback 的 else-if 分支
        titles: { sniff: '页面嗅探标题内容' },
    };
    const incoming = { id: ID };
    const { merged } = mergeConversation(old, incoming);
    assert.strictEqual(merged.titles.sniff, '页面嗅探标题内容');
    assert.ok(
        !('legacy' in merged.titles),
        `sniff 槽已有标题，不应凭空造 legacy 槽，实际 titles=${JSON.stringify(merged.titles)}`
    );
});

test('api-detail 槽有标题时：incoming 标题分支不再造 legacy 僵尸槽', () => {
    const old = { id: ID };
    const incoming = {
        id: ID,
        title: 'API 详情返回的标题内容',
        // 注意：无 titleSource，才会走到 legacy fallback 的 else-if 分支
        titles: { 'api-detail': 'API 详情标题内容' },
    };
    const { merged } = mergeConversation(old, incoming);
    assert.strictEqual(merged.titles['api-detail'], 'API 详情标题内容');
    assert.ok(
        !('legacy' in merged.titles),
        `api-detail 槽已有标题，不应凭空造 legacy 槽，实际 titles=${JSON.stringify(merged.titles)}`
    );
});

test('守卫未过度抑制：没有任何权威槽时 legacy fallback 仍然生效', () => {
    const old = {
        id: ID,
        title: '旧会话普通标题内容',
        titles: {},
    };
    const incoming = { id: ID };
    const { merged } = mergeConversation(old, incoming);
    assert.strictEqual(
        merged.titles.legacy,
        '旧会话普通标题内容',
        '无任何权威槽时，legacy fallback 必须照常工作'
    );
});
