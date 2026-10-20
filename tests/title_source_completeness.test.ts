/**
 * TitleSource / TITLE_TIER_RANK / TITLE_SOURCE_PRIORITY 三源归一完备性测试。
 *
 * 背景：TitleSource 类型联合、TITLE_TIER_RANK（权威分值表）、TITLE_SOURCE_PRIORITY
 * （仲裁遍历顺序）三处曾各自为政——运行时最高频的 'rpc' 不在 union 里，
 * union 里的 'api-detail' 不在 RANK 里（被 `?? 0` 静默降为 default，导致
 * messageBridge 的 sniff-upgrade 守卫用低权威 sniff 标题覆盖 api-detail 标题），
 * 'api-list'/'user-edit'/'url' 则是无生产者的死成员。
 *
 * 修复：union 收敛为真实存在的 7 个 source（删死成员、补 rpc/legacy/default），
 * RANK 与 PRIORITY 与之对齐并改用 Record<TitleSource, number> 约束；
 * api-detail 与 rpc 同级（50），行为与修正前一致。
 *
 * 本测试是防漂移网：新增 TitleSource 时若不同步更新 RANK/PRIORITY，测试失败。
 *
 * 运行：node -r tests/ts_register.js --test tests/title_source_completeness.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const {
    TITLE_TIER_RANK,
    TITLE_SOURCE_PRIORITY,
    resolveTitle,
} = require('../src/core/utils/titleUtils.js');

// 与 src/types/conversation.ts 的 TitleSource 联合保持同步：
// 测试里硬编码一份"期望成员"，任一处增删都必须两处同步改，否则测试失败。
const EXPECTED_SOURCES: string[] = ['rpc', 'api-detail', 'dom', 'takeout', 'openai', 'sniff', 'legacy', 'default'];

test('union 成员 ⊆ RANK keys：每个 TitleSource 都有权威分值', () => {
    for (const s of EXPECTED_SOURCES) {
        assert.ok(
            Object.prototype.hasOwnProperty.call(TITLE_TIER_RANK, s),
            `TITLE_TIER_RANK 缺少 '${s}'，新增 TitleSource 时必须同步补 rank`
        );
        assert.strictEqual(typeof TITLE_TIER_RANK[s], 'number');
    }
});

test('RANK keys ⊆ union：分值表没有类型之外的幽灵 key', () => {
    for (const k of Object.keys(TITLE_TIER_RANK)) {
        assert.ok(EXPECTED_SOURCES.includes(k), `TITLE_TIER_RANK 有多余 key '${k}'`);
    }
});

test('PRIORITY 覆盖全部 source 且按 rank 降序排列', () => {
    assert.deepStrictEqual(
        [...TITLE_SOURCE_PRIORITY].sort(),
        [...EXPECTED_SOURCES].sort(),
        'TITLE_SOURCE_PRIORITY 必须恰好覆盖全部 TitleSource'
    );
    const ranks = TITLE_SOURCE_PRIORITY.map((s: string) => TITLE_TIER_RANK[s]);
    const sorted = [...ranks].sort((a, b) => b - a);
    assert.deepStrictEqual(ranks, sorted, 'TITLE_SOURCE_PRIORITY 必须按 rank 降序排列');
});

test('死成员已清除：api-list / user-edit / url 不再出现在任何一处', () => {
    for (const dead of ['api-list', 'user-edit', 'url']) {
        assert.ok(!Object.prototype.hasOwnProperty.call(TITLE_TIER_RANK, dead));
        assert.ok(!TITLE_SOURCE_PRIORITY.includes(dead));
    }
});

test('H1 回归：api-detail 的 rank 高于 sniff，sniff 标题不得覆盖它', () => {
    assert.ok(
        TITLE_TIER_RANK['api-detail'] > TITLE_TIER_RANK['sniff'],
        'api-detail 必须高于 sniff，否则 sniff-upgrade 守卫会降级覆盖'
    );
});

test('api-detail 槽标题参与仲裁：不再依赖错位的 rpc 槽', () => {
    const chat = {
        id: 'c1',
        title: '',
        titles: { 'api-detail': 'API 标题', sniff: 'sniff 标题' },
    };
    const res = resolveTitle(chat);
    assert.strictEqual(res.title, 'API 标题');
    assert.strictEqual(res.source, 'api-detail');
});
