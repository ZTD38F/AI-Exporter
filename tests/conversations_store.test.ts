export {};
const test = require('node:test');
const assert = require('node:assert');

const ConversationsStore = require('../src/ui/state/conversationsStore.js');

test('conversationsStore - normId', () => {
    assert.strictEqual(ConversationsStore.normId('c_12345678'), '12345678');
    assert.strictEqual(ConversationsStore.normId('12345678'), '12345678');
    assert.strictEqual(ConversationsStore.normId(''), '');
    assert.strictEqual(ConversationsStore.normId(null), '');
});

test('conversationsStore - in-memory get and set', () => {
    const list: any[] = [{ id: '1', title: 'Chat 1' }, { id: '2', title: 'Chat 2' }];
    ConversationsStore.setConversations(list);
    assert.deepStrictEqual(ConversationsStore.getConversations(), list);

    const expMap = { '1': { exportedAt: 1000 } };
    ConversationsStore.setExportedIds(expMap);
    assert.deepStrictEqual(ConversationsStore.getExportedIds(), expMap);

    ConversationsStore.setCurrentSlot('u1');
    assert.strictEqual(ConversationsStore.getCurrentSlot(), 'u1');
});

test('conversationsStore - getExportedRecord normalization', () => {
    ConversationsStore.setExportedIds({
        'c_123': { exportedAt: 5000 },
        '456': { exportedAt: 6000 }
    });

    assert.ok(ConversationsStore.getExportedRecord('123'));
    assert.strictEqual(ConversationsStore.getExportedRecord('123').exportedAt, 5000);
    assert.ok(ConversationsStore.getExportedRecord('c_123'));

    assert.ok(ConversationsStore.getExportedRecord('456'));
    assert.strictEqual(ConversationsStore.getExportedRecord('456').exportedAt, 6000);
    assert.ok(ConversationsStore.getExportedRecord('c_456'));

    assert.strictEqual(ConversationsStore.getExportedRecord('non_existent'), null);
    assert.strictEqual(ConversationsStore.getExportedRecord(null), null);
});

test('conversationsStore - getSignature', () => {
    const sigEmpty = ConversationsStore.getSignature([]);
    assert.strictEqual(sigEmpty, 'empty');

    const sigA = ConversationsStore.getSignature([{ id: 'a', title: 'Title 1' }, { id: 'b', title: 'Title 2' }]);
    const sigB = ConversationsStore.getSignature([{ id: 'a', title: 'Title 1' }, { id: 'b', title: 'Title 2' }]);
    assert.strictEqual(sigA, sigB);

    const sigC = ConversationsStore.getSignature([{ id: 'a', title: 'Title 1' }, { id: 'c', title: 'Title 2' }]);
    assert.ok(sigA !== sigC);

    const sigD = ConversationsStore.getSignature([{ id: 'a', title: 'Real Title' }, { id: 'b', title: 'Title 2' }]);
    assert.ok(sigA !== sigD);
});

test('conversationsStore - hasTakeoutData detection', () => {
    ConversationsStore.setConversations([
        { id: '1', title: 'Normal Chat 1' },
        { id: '2', title: 'Normal Chat 2' }
    ] as any);
    assert.strictEqual(ConversationsStore.hasTakeoutData(), false);

    ConversationsStore.setConversations([
        { id: '1', title: 'Normal Chat 1' },
        { id: '2', title: 'Takeout Chat 2', source: 'takeout' }
    ] as any);
    assert.strictEqual(ConversationsStore.hasTakeoutData(), true);

    ConversationsStore.setConversations([
        { id: '3', title: 'Takeout Chat 3', titleSource: 'takeout' }
    ] as any);
    assert.strictEqual(ConversationsStore.hasTakeoutData(), true);

    ConversationsStore.setConversations([
        { id: '4', title: 'Takeout Chat 4', titles: { takeout: 'Takeout Title' } }
    ] as any);
    assert.strictEqual(ConversationsStore.hasTakeoutData(), true);
});

test('conversationsStore - normalizeAndDeduplicate basic and multi-tier merge', () => {
    const list = [
        { id: 'c_abc123', title: 'Google Gemini', titleSource: 'dom', timestamp: 1700000000000 },
        { id: 'abc123', title: '真实量子计算研究', titleSource: 'rpc', timestamp: 1700000005000 },
        { id: 'def456', title: '未命名对话', titleSource: 'default', timestamp: 1690000000000 }
    ];

    const { processed, hasDirtyTitles } = ConversationsStore.normalizeAndDeduplicate(list);
    assert.strictEqual(processed.length, 2);
    assert.strictEqual(hasDirtyTitles, true);

    const first = processed[0];
    assert.strictEqual(first.id, 'abc123');
    assert.strictEqual(first.title, '真实量子计算研究');
    assert.strictEqual(first.titleSource, 'rpc');
    assert.strictEqual(first.timestamp, 1700000005000);

    const second = processed[1];
    assert.strictEqual(second.id, 'def456');
    assert.strictEqual(second.title, '未命名对话');
});

test('utils - mergeConversation SSoT title priority and timestamp arbitration', () => {
    const GeminiUtils = require('../src/core/utils/utils.js');
    const { mergeConversation, deduplicateConversations } = GeminiUtils;

    // 1. Initial conversation with default/unnamed title
    const old = {
        id: 'chat_999',
        title: '未命名对话',
        titleSource: 'default',
        timestamp: 1700000000000,
        updatedAt: 1700000000000,
        createdAt: 1700000000000
    };

    // 2. Incoming with sniffed prompt title
    const incoming = {
        id: 'c_chat_999',
        title: '如何构建高性能分布式缓存系统',
        titleSource: 'sniff',
        timestamp: 1700000010000,
        updatedAt: 1700000010000,
        createdAt: 1699999990000
    };

    const res = mergeConversation(old, incoming);
    assert.strictEqual(res.isChanged, true);
    assert.strictEqual(res.merged.id, 'chat_999');
    assert.strictEqual(res.merged.title, '如何构建高性能分布式缓存系统');
    assert.strictEqual(res.merged.titleSource, 'sniff');
    assert.strictEqual(res.merged.timestamp, 1700000010000);
    assert.strictEqual(res.merged.createdAt, 1699999990000);
    assert.strictEqual(res.merged.titles.sniff, '如何构建高性能分布式缓存系统');

    // 3. DeduplicateConversations filtering bad URLs and sorting
    const rawList: any[] = [
        { id: '1', title: 'Earlier Chat', timestamp: 1000 },
        { id: '2', title: 'Sign In', url: 'https://accounts.google.com/SignOutOptions' },
        { id: '3', title: 'Later Chat', timestamp: 2000 }
    ];
    const dedup = deduplicateConversations(rawList);
    assert.strictEqual(dedup.processed.length, 2);
    assert.strictEqual(dedup.processed[0].id, '3');
    assert.strictEqual(dedup.processed[1].id, '1');
});
