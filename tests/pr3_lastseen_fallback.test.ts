/**
 * PR-3 回归测试（核心词表审计 D2，方案 a）：
 * getEffectiveTimestamp 删除 lastSeen fallback。
 *
 * 契约：
 *   1. 只有 lastSeen、无服务端时间戳的会话 → getEffectiveTimestamp 返回 0
 *      （lastSeen 是客户端观察到的时间，可能是 seed，不可当作服务端权威时间）。
 *   2. checkIsUpdated 对 lastSeen-only 会话不再误判为 updated（客户端 lastSeen
 *      推进超过导出时间也不能触发"有更新"）。
 *
 * 运行: node -r ./tests/ts_register.js --test tests/pr3_lastseen_fallback.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const { getEffectiveTimestamp, checkIsUpdated } = require('../src/core/utils/titleUtils.js');

// Case 1: lastSeen-only 会话返回 0，不再返回 lastSeen。
test('getEffectiveTimestamp: lastSeen-only chat returns 0', () => {
    const chat = { id: 'c_lastseen_only', lastSeen: '2026-09-03T12:00:00.000Z' };
    assert.strictEqual(getEffectiveTimestamp(chat), 0, 'lastSeen must not feed the authoritative timestamp');

    // 数字型 lastSeen 也一样
    assert.strictEqual(getEffectiveTimestamp({ id: 'c2', lastSeen: Date.now() }), 0);
});

// Case 2: checkIsUpdated 不再因客户端 lastSeen 推进而误判 updated。
test('checkIsUpdated: lastSeen-only chat is not flagged updated by client clock', () => {
    const rec = {
        id: 'c_lastseen_only',
        exportedAt: 1788000000000, // 导出时间
        messageCount: 4,
    };
    // 会话只有客户端 lastSeen（比导出时间更晚），没有服务端时间戳和消息数变化
    const chat = {
        id: 'c_lastseen_only',
        lastSeen: 1788100000000,
        messageCount: 4,
    };
    assert.strictEqual(checkIsUpdated(chat, rec), false, 'client-observed lastSeen must not mark export stale');
});
