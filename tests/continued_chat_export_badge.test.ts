export {};
const test = require('node:test');
const assert = require('node:assert');
const { resolveConversationExportState, checkIsUpdated } = require('../src/core/utils/titleUtils.js');
const { buildExportCompletion, computeAuthoritativeTimestamp } = require('../src/core/engine/export/exportCompletion.js');

test('regression: 老会话追加一轮 -> 自动导出完成 -> badge 必须为 exported；再新增一轮后才变 updated', () => {
    const CHAT_ID = 'chat_continued_test_1';

    // 1. 初始状态：会话包含 1 轮提问（2 条消息），初始时间戳 T1
    const T1 = 1700000000000;
    const c1: any = {
        id: CHAT_ID,
        title: '老会话初始对话',
        titleSource: 'rpc',
        updatedAt: T1,
        timestamp: T1,
        messageCount: 2,
        messages: [
            { role: 'user', content: '提问 1', timestamp: T1 },
            { role: 'model', content: '回答 1', timestamp: T1 + 500 }
        ]
    };

    // 初始导出完成
    const initialCompletion = buildExportCompletion({
        conversation: c1,
        conversationId: CHAT_ID,
        exportedAt: new Date(T1 + 1000).toISOString()
    });
    const rec1 = initialCompletion.exportRecord;

    assert.strictEqual(rec1.chatTime, T1 + 500, '初始导出记录必须捕获最新 Turn 的权威时间戳');
    assert.strictEqual(rec1.messageCount, 2, '初始导出记录消息数必须为 2');

    // 校验初始导出后的 badge 状态
    c1.updatedAt = rec1.chatTime;
    const st1 = resolveConversationExportState(c1, rec1);
    assert.strictEqual(st1.hasNewerActivity, false);
    assert.strictEqual(st1.state, 'exported_ok');
    assert.strictEqual(st1.badge.kind, 'exported_ok', '初始导出后 badge 必须为 exported_ok');
    assert.strictEqual(checkIsUpdated(c1, rec1), false);

    // 2. 老会话追加一轮 (Turn 2): Google hNvQHb 产生新时间戳 T2 与更多消息
    const T2 = 1700000100000;
    c1.updatedAt = T2 + 800;
    c1.timestamp = T2 + 800;
    c1.messageCount = 4;
    c1.messages.push(
        { role: 'user', content: '追加提问 2', timestamp: T2 },
        { role: 'model', content: '追加回答 2', timestamp: T2 + 800 }
    );

    // 自动导出尚未执行或正在执行时，Option 页必须立即识别到未导出的新活动，标记为 updated
    const stPreExport = resolveConversationExportState(c1, rec1);
    assert.strictEqual(stPreExport.hasNewerActivity, true, '检测到新 Turn 后必须标记 hasNewerActivity');
    assert.strictEqual(stPreExport.state, 'updated');
    assert.strictEqual(stPreExport.badge.kind, 'updated', '在自动导出前 badge 必须为 updated');
    assert.strictEqual(checkIsUpdated(c1, rec1), true);

    // 3. 自动导出完成：LiveSave / AutoExport 完成写入，生成新的 ExportRecord
    // 真实数据链：chat.chatTime 权威反映已导出的最新 Turn 时间戳 T2 + 800
    const liveSaveCompletion = buildExportCompletion({
        conversation: c1,
        conversationId: CHAT_ID,
        // 本地导出时间发生于 Turn 2 完成后 (T2 + 1000)
        exportedAt: new Date(T2 + 1000).toISOString()
    });
    const rec2 = liveSaveCompletion.exportRecord;

    assert.strictEqual(rec2.chatTime, T2 + 800, '自动导出记录的 chatTime 必须就是实际被导出的最新 Turn 权威时间');
    assert.strictEqual(rec2.messageCount, 4, '自动导出记录的消息数必须是当前导出的 4 条');

    // 更新 storage 后的 conversation 与 rec2 对齐
    c1.updatedAt = rec2.chatTime;
    c1.messageCount = rec2.messageCount;

    // 核心断言：自动导出完成后，badge 必须为 exported，不能误判为 updated！
    const stPostExport = resolveConversationExportState(c1, rec2);
    assert.strictEqual(stPostExport.hasNewerActivity, false, '导出完成后 hasNewerActivity 必须归位为 false');
    assert.strictEqual(stPostExport.state, 'exported_ok', '导出完成后 state 必须为 exported_ok');
    assert.strictEqual(stPostExport.badge.kind, 'exported_ok', '自动导出完成 -> badge 必须为 exported');
    assert.strictEqual(checkIsUpdated(c1, rec2), false, 'checkIsUpdated 必须返回 false');

    // 4. 再新增一轮 (Turn 3): 用户又继续发送了第三轮提问
    const T3 = 1700000300000;
    c1.updatedAt = T3 + 900;
    c1.timestamp = T3 + 900;
    c1.messageCount = 6;
    c1.messages.push(
        { role: 'user', content: '再新增一轮提问 3', timestamp: T3 },
        { role: 'model', content: '再新增一轮回答 3', timestamp: T3 + 900 }
    );

    // 核心断言：再新增一轮后才变 updated
    const stTurn3 = resolveConversationExportState(c1, rec2);
    assert.strictEqual(stTurn3.hasNewerActivity, true, '再新增一轮后 hasNewerActivity 必须为 true');
    assert.strictEqual(stTurn3.state, 'updated', '再新增一轮后 state 必须为 updated');
    assert.strictEqual(stTurn3.badge.kind, 'updated', '再新增一轮后 badge 必须变 updated');
    assert.strictEqual(checkIsUpdated(c1, rec2), true, 'checkIsUpdated 必须返回 true');
});

test('authoritative timestamp extraction across turns in hNvQHb messages', () => {
    // 验证无论字段位于 messages[].timestamp、chatTime 还是 updatedAt，提取器均能准确捕获最新值
    const chatFromRpc = {
        id: 'rpc_chat',
        title: 'RPC 对话',
        messages: [
            { role: 'user', content: 'q1', timestamp: 1700000001000 },
            { role: 'model', content: 'a1', timestamp: 1700000002000 },
            { role: 'user', content: 'q2', timestamp: 1700000005000 },
            { role: 'model', content: 'a2', timestamp: 1700000006500 }
        ]
    };
    const ts = computeAuthoritativeTimestamp(chatFromRpc);
    assert.strictEqual(ts, 1700000006500, '从 messages 列表中必须精准提取出最新 Turn 的 1700000006500');
});

test('clock skew robustness: client clock behind Google server clock never falsely triggers updated badge when chatTime matches', () => {
    // 模拟客户端时钟比 Google 服务端时钟慢 10 秒（本地 now 为 T - 10000，而 Google turn 时间戳为 T）
    const GOOGLE_SERVER_TS = 1700000050000;
    const CLIENT_SKEW_NOW = GOOGLE_SERVER_TS - 10000;

    const chat = {
        id: 'skew_chat',
        title: '时钟偏差对话',
        updatedAt: GOOGLE_SERVER_TS,
        messageCount: 4
    };

    const completion = buildExportCompletion({
        conversation: chat,
        conversationId: 'skew_chat',
        exportedAt: new Date(CLIENT_SKEW_NOW).toISOString(), // 客户端本地时间（比服务端慢 10s）
        chatTime: GOOGLE_SERVER_TS
    });

    // 导出的记录 chatTime 权威记录了服务端的 1700000050000
    assert.strictEqual(completion.exportRecord.chatTime, GOOGLE_SERVER_TS);

    // 状态判定：即使 c.updatedAt (服务端) > rec.exportedAt (客户端)，因为 c.updatedAt === rec.chatTime，
    // 依然判定为 exported_ok，绝不误触 updated！
    const state = resolveConversationExportState(chat, completion.exportRecord);
    assert.strictEqual(state.hasNewerActivity, false, '相同 chatTime 下时钟偏差绝不能导致 false positive updated');
    assert.strictEqual(state.badge.kind, 'exported_ok', '徽章必须保持 exported_ok');
    assert.strictEqual(checkIsUpdated(chat, completion.exportRecord), false);
});

