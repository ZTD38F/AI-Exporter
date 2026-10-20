import test from 'node:test';
import assert from 'node:assert';

import * as GeminiUtils from '../src/core/utils/utils.js';
import * as GeminiParser from '../src/core/api/geminiParser.js';


test('GeminiUtils.getEffectiveTimestamp - hierarchy and type safety', () => {
    assert.strictEqual(typeof GeminiUtils.getEffectiveTimestamp, 'function', 'getEffectiveTimestamp must be exported');

    // Case 1: Empty or null
    assert.strictEqual(GeminiUtils.getEffectiveTimestamp(null), 0);
    assert.strictEqual(GeminiUtils.getEffectiveTimestamp({}), 0);

    // Case 2: Prioritizes updatedAt
    const chat1 = {
        createdAt: 1000,
        timestamp: 2000,
        updatedAt: 3000,
        lastSeen: '2026-09-03T12:00:00.000Z'
    };
    assert.strictEqual(GeminiUtils.getEffectiveTimestamp(chat1), 3000, 'updatedAt should take highest priority');

    // Case 3: Falls back to timestamp if updatedAt missing
    const chat2 = {
        createdAt: 1000,
        timestamp: 2500,
        lastSeen: '2026-09-03T12:00:00.000Z'
    };
    assert.strictEqual(GeminiUtils.getEffectiveTimestamp(chat2), 2500, 'timestamp should be fallback when updatedAt is absent');

    // Case 4: Falls back to createdAt if timestamp & updatedAt missing
    const chat3 = {
        createdAt: 1800
    };
    assert.strictEqual(GeminiUtils.getEffectiveTimestamp(chat3), 1800, 'createdAt fallback');

    // Case 5: lastSeen is client-observed and must NOT feed the authoritative
    // timestamp (PR-3, core-vocab audit D2). No server timestamp -> 0.
    const isoTime = '2026-09-03T18:00:00.000Z';
    const chat4 = {
        lastSeen: isoTime
    };
    assert.strictEqual(GeminiUtils.getEffectiveTimestamp(chat4), 0, 'lastSeen-only chat must return 0');
});

test('GeminiParser.parseDetail - exports updatedAt as maxTs and timestamp as maxTs', () => {
    const ParserClass = GeminiParser.GeminiResponseParserClass || GeminiParser;
    assert.ok(ParserClass, 'GeminiResponseParserClass should be present');

    const mockDetailInner = [
        [
            [
                ["c_test123", "r_turn_1"],
                null,
                [["User message 1"]],
                [[["rc_model_1", ["Model answer 1"]]]],
                [1700000000, 0]
            ],
            [
                ["c_test123", "r_turn_2"],
                null,
                [["User message 2"]],
                [[["rc_model_2", ["Model answer 2"]]]],
                [1700005000, 0]
            ]
        ],
        null,
        "Conversation Title"
    ];
    const topPayload = [
        ["wrb.fr", "hNvQHb", JSON.stringify(mockDetailInner)]
    ];
    const mockEnvelope = `)]}'\n\n${JSON.stringify(topPayload)}`;

    const detail = ParserClass.parseDetail(mockEnvelope, "c_test123");
    assert.ok(detail, 'Detail should be parsed');
    assert.strictEqual(detail.id, 'c_test123');

    // Verify time semantics:
    // createdAt must be minTs (1700000000000)
    // updatedAt must be maxTs (1700005000000)
    // timestamp must be maxTs (1700005000000)
    assert.strictEqual(detail.createdAt, 1700000000000, 'createdAt should be earliest turn timestamp');
    assert.strictEqual(detail.updatedAt, 1700005000000, 'updatedAt should be latest turn timestamp (activity time)');
    assert.strictEqual(detail.timestamp, 1700005000000, 'timestamp should align with updatedAt');
    assert.strictEqual(detail.chatTime, 1700005000000, 'chatTime should align with updatedAt');
});

test('Conversation sorting - orders by latest server activity; lastSeen-only chats sort after timestamped ones (PR-3)', () => {
    const getEffectiveTime = GeminiUtils.getEffectiveTimestamp;

    function sortConversations(list: any[]) {
        return [...list].sort((a, b) => {
            let valA = getEffectiveTime(a);
            let valB = getEffectiveTime(b);
            if (valA !== valB) return valB - valA;

            let idxA = typeof a.sidebarIndex === 'number' ? a.sidebarIndex : 999999;
            let idxB = typeof b.sidebarIndex === 'number' ? b.sidebarIndex : 999999;
            if (idxA !== idxB) return idxA - idxB;

            let lsA = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
            let lsB = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
            return lsB - lsA;
        });
    }


    const now = 1788460500000;

    // Chat A: created 1 year ago (1750000000000), but updated TODAY (1788460500000)
    const chatA = {
        id: 'chat_revived',
        title: 'Revived Chat',
        createdAt: 1750000000000,
        updatedAt: now,
        timestamp: now
    };

    // Chat B: created 1 month ago (1785000000000), updated 1 month ago (1785000000000)
    const chatB = {
        id: 'chat_month_old',
        title: 'Month Old Chat',
        createdAt: 1785000000000,
        updatedAt: 1785000000000,
        timestamp: 1785000000000
    };

    // Chat C: created 3 days ago (1788200000000), updated 3 days ago
    const chatC = {
        id: 'chat_3days_old',
        title: 'Three Days Old Chat',
        createdAt: 1788200000000,
        updatedAt: 1788200000000,
        timestamp: 1788200000000
    };

    // Chat D: Brand new chat captured from DOM on page (has sidebarIndex: 0 and recent lastSeen, no server timestamp yet)
    const chatD = {
        id: 'chat_brand_new_dom',
        title: 'Brand New Chat',
        lastSeen: new Date(now + 1000).toISOString(),
        sidebarIndex: 0
    };

    // Test 1: Revived old chat MUST be ranked above older inactive chats
    const sorted1 = sortConversations([chatB, chatA, chatC]);
    assert.strictEqual(sorted1[0].id, 'chat_revived', 'Revived chat must be at top due to recent updatedAt');
    assert.strictEqual(sorted1[1].id, 'chat_3days_old');
    assert.strictEqual(sorted1[2].id, 'chat_month_old');

    // Test 2 (PR-3, core-vocab audit D2): lastSeen no longer feeds
    // getEffectiveTimestamp, so a DOM capture without server timestamps
    // orders below server-timestamped chats in a pure-server-time sort.
    const sorted2 = sortConversations([chatB, chatC, chatD]);
    assert.strictEqual(sorted2[0].id, 'chat_3days_old');
    assert.strictEqual(sorted2[1].id, 'chat_month_old');
    assert.strictEqual(sorted2[2].id, 'chat_brand_new_dom', 'lastSeen-only chat sorts after timestamped chats');
});

test('Conversation merge - updates updatedAt when conversation becomes active again', () => {
    // Simulate upsertConversations logic
    function mergeConversations(existing: any[], incoming: any[]) {
        const map = new Map();
        existing.forEach((c: any) => map.set(c.id, { ...c }));

        incoming.forEach((c: any) => {
            const old = map.get(c.id);
            let cUpdated = c.updatedAt || c.timestamp || null;
            let oldUpdated = old?.updatedAt || old?.timestamp || null;

            let bestUpdatedAt = oldUpdated;
            if (cUpdated && (!bestUpdatedAt || cUpdated > bestUpdatedAt)) {
                bestUpdatedAt = cUpdated;
            }

            let bestCreatedAt = old?.createdAt || c.createdAt || null;
            if (c.createdAt && old?.createdAt && c.createdAt < old.createdAt) {
                bestCreatedAt = c.createdAt;
            }

            let bestTimestamp = bestUpdatedAt || old?.timestamp || c.timestamp || null;

            map.set(c.id, {
                ...(old || {}),
                ...c,
                timestamp: bestTimestamp,
                updatedAt: bestUpdatedAt || bestTimestamp,
                createdAt: bestCreatedAt
            });
        });

        return Array.from(map.values());
    }

    const initial = [
        { id: 'chat_1', title: 'Old Chat 1', createdAt: 1000, updatedAt: 1000, timestamp: 1000 }
    ];

    // User chats again in chat_1 at time 5000
    const update = [
        { id: 'chat_1', title: 'Old Chat 1', updatedAt: 5000, timestamp: 5000 }
    ];

    const merged = mergeConversations(initial, update);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].updatedAt, 5000, 'updatedAt should be bumped to 5000');
    assert.strictEqual(merged[0].timestamp, 5000, 'timestamp should be updated to 5000');
    assert.strictEqual(merged[0].createdAt, 1000, 'createdAt should remain 1000');
});

test('GeminiParser.parseList - accurately extracts server timestamp from index 5 and orders pages correctly', () => {
    const ParserClass = GeminiParser.GeminiResponseParserClass || GeminiParser;
    assert.ok(ParserClass, 'GeminiResponseParserClass must be present');

    // Realistic Google MaZiqc response
    // Page 1: Newer conversation (updated at 1788464818.885831 -> 1788464818885 ms)
    const page1Raw = `)]}'\n\n[["wrb.fr","MaZiqc","[null,null,[[\\"c_page1\\",\\"Page 1 Conversation\\",null,null,null,[1788464818,885831000],null,null,null,1]]]"]]`;
    const res1 = ParserClass.parseList(page1Raw);
    assert.strictEqual(res1.conversations.length, 1);
    const conv1 = res1.conversations[0];
    assert.strictEqual(conv1.id, 'page1');
    assert.strictEqual(conv1.title, 'Page 1 Conversation');
    assert.strictEqual(conv1.updatedAt, 1788464818885, 'Must extract exact server timestamp from index 5');
    assert.strictEqual(conv1.timestamp, 1788464818885, 'timestamp must match server updatedAt');

    // Page 2: Older conversation (updated 1 day ago: 1788378418.000000 -> 1788378418000 ms)
    const page2Raw = `)]}'\n\n[["wrb.fr","MaZiqc","[null,null,[[\\"c_page2\\",\\"Page 2 Older Conversation\\",null,null,null,[1788378418,0],null,null,null,1]]]"]]`;
    const res2 = ParserClass.parseList(page2Raw);
    assert.strictEqual(res2.conversations.length, 1);
    const conv2 = res2.conversations[0];
    assert.strictEqual(conv2.id, 'page2');
    assert.strictEqual(conv2.updatedAt, 1788378418000, 'Must extract older server timestamp from index 5');

    // Verify ordering: Page 1 (newer) MUST be ahead of Page 2 (older), even if Page 2 was parsed later in real time
    const combined = [conv2, conv1]; // Even if scanned in reverse or later
    combined.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    assert.strictEqual(combined[0].id, 'page1', 'Page 1 (newer updatedAt) must remain on top of Page 2');
    assert.strictEqual(combined[1].id, 'page2');
});

test('GeminiUtils.compareConversations - authoritative SSoT comparator', () => {
    assert.strictEqual(typeof GeminiUtils.compareConversations, 'function', 'compareConversations must be exported');

    // 1. Sort by effective timestamp descending (newer first)
    const convNew = { id: 'c1', updatedAt: 2000 };
    const convOld = { id: 'c2', updatedAt: 1000 };
    assert.ok(GeminiUtils.compareConversations(convNew, convOld) < 0, 'Newer should come before older');
    assert.ok(GeminiUtils.compareConversations(convOld, convNew) > 0, 'Older should come after newer');

    // 2. When timestamps are identical, sort by sidebarIndex ascending (0 before 1)
    const convIdx0 = { id: 'c3', updatedAt: 1000, sidebarIndex: 0 };
    const convIdx1 = { id: 'c4', updatedAt: 1000, sidebarIndex: 1 };
    assert.ok(GeminiUtils.compareConversations(convIdx0, convIdx1) < 0, 'Lower sidebarIndex should come first');
    assert.ok(GeminiUtils.compareConversations(convIdx1, convIdx0) > 0, 'Higher sidebarIndex should come second');

    // 3. When sidebarIndex is also equal or absent, sort by lastSeen descending
    const convSeenLater = { id: 'c5', updatedAt: 1000, sidebarIndex: 0, lastSeen: '2026-09-01T12:00:00.000Z' };
    const convSeenEarlier = { id: 'c6', updatedAt: 1000, sidebarIndex: 0, lastSeen: '2026-09-01T10:00:00.000Z' };
    assert.ok(GeminiUtils.compareConversations(convSeenLater, convSeenEarlier) < 0, 'More recent lastSeen should come first');
    assert.ok(GeminiUtils.compareConversations(convSeenEarlier, convSeenLater) > 0, 'Older lastSeen should come second');

    // 4. Array sort stability
    const list = [convOld, convNew, convIdx1, convIdx0];
    list.sort(GeminiUtils.compareConversations);
    assert.deepStrictEqual(list.map(c => c.id), ['c1', 'c3', 'c4', 'c2']);
});

test('mergeConversation - newer incoming server timestamp upgrades updatedAt/timestamp monotonically', () => {
    // Pure merge semantics: an RPC/list entry carrying a newer SERVER
    // timestamp upgrades the record (Math.max).
    const existingList = [
        { id: 'c_top1', title: 'Top 1', updatedAt: 5000, timestamp: 5000, createdAt: 4500, sidebarIndex: 0 },
        { id: 'c_top2', title: 'Top 2', updatedAt: 4000, timestamp: 4000, createdAt: 3500, sidebarIndex: 1 },
        { id: 'c_top3', title: 'Top 3', updatedAt: 3000, timestamp: 3000, createdAt: 2500, sidebarIndex: 2 },
        { id: 'c_old_chat', title: 'Old Chat Project', updatedAt: 1000, timestamp: 1000, createdAt: 800, sidebarIndex: 3, messageCount: 4 }
    ];

    // Verify initial ordering: old chat is at the tail (index 3)
    existingList.sort(GeminiUtils.compareConversations);
    assert.strictEqual(existingList[3].id, 'c_old_chat', 'Old chat should initially be at the tail');

    // A list-sync entry with a newer server timestamp upgrades the record
    const now = 9000;
    const incomingSync = {
        id: 'old_chat',
        timestamp: now,
        updatedAt: now,
        sidebarIndex: 0
    };

    const mergeRes = GeminiUtils.mergeConversation(existingList[3], incomingSync, { source: 'network-list' });
    assert.strictEqual(mergeRes.isChanged, true, 'merge must flag isChanged when timestamp is bumped');
    assert.strictEqual(mergeRes.merged.updatedAt, 9000, 'updatedAt must be bumped to newer server time');
    assert.strictEqual(mergeRes.merged.timestamp, 9000, 'timestamp must be bumped to newer server time');
    assert.strictEqual(mergeRes.merged.createdAt, 800, 'original createdAt must be preserved');
    assert.strictEqual(mergeRes.merged.title, 'Old Chat Project', 'original title must be preserved');
    assert.strictEqual(mergeRes.merged.messageCount, 4, 'original messageCount must be preserved');

    // Re-sorting with the updated chat
    const updatedList = [existingList[0], existingList[1], existingList[2], mergeRes.merged];
    updatedList.sort(GeminiUtils.compareConversations);

    // Assert old_chat is now at the very top (index 0)
    assert.strictEqual(updatedList[0].id, 'old_chat', 'Conversation with newer server timestamp must rise to index 0 (top of list)');
    assert.strictEqual(updatedList[1].id, 'c_top1');
    assert.strictEqual(updatedList[2].id, 'c_top2');
    assert.strictEqual(updatedList[3].id, 'c_top3');
});

test('Title arbitration & non-downgrade CAS immunity - Takeout and DOM titles cannot be overwritten by truncated sniff', () => {
    // 1. Existing Takeout conversation
    const oldTakeout = {
        id: 'c_tock_resy',
        title: '预约平台混淆： Tock与Resy的区别',
        titleSource: 'takeout',
        titles: { takeout: '预约平台混淆： Tock与Resy的区别' },
        updatedAt: 1000
    };

    // 2. Incoming sniff from detail RPC with truncated smartSummarizePrompt
    const incomingSniff = {
        id: 'tock_resy',
        title: '预约平台混淆',
        titleSource: 'sniff',
        titles: { sniff: '预约平台混淆' },
        updatedAt: 1000
    };

    const res1 = GeminiUtils.mergeConversation(oldTakeout, incomingSniff, { source: 'network-detail' });
    assert.strictEqual(res1.merged.title, '预约平台混淆： Tock与Resy的区别', 'Takeout title must NOT be overwritten by truncated sniff title');
    assert.strictEqual(res1.merged.titleSource, 'takeout');

    // 3. Incoming DOM title upgrades Takeout title
    const incomingDom = {
        id: 'tock_resy',
        title: '预约平台混淆： Tock与Resy的区别 (完整版)',
        titleSource: 'dom',
        titles: { dom: '预约平台混淆： Tock与Resy的区别 (完整版)' },
        updatedAt: 1000
    };
    const res2 = GeminiUtils.mergeConversation(res1.merged, incomingDom, { source: 'dom-scrape' });
    assert.strictEqual(res2.merged.title, '预约平台混淆： Tock与Resy的区别 (完整版)', 'DOM title must upgrade Takeout title');
    assert.strictEqual(res2.merged.titleSource, 'dom');

    // 4. Later incoming sniff still cannot downgrade DOM title
    const res3 = GeminiUtils.mergeConversation(res2.merged, incomingSniff, { source: 'network-detail' });
    assert.strictEqual(res3.merged.title, '预约平台混淆： Tock与Resy的区别 (完整版)', 'DOM title must NOT be downgraded by sniff');
    assert.strictEqual(res3.merged.titleSource, 'dom');

    // 5. Incoming authoritative RPC title upgrades DOM title
    const incomingRpc = {
        id: 'tock_resy',
        title: '预约平台混淆： Tock与Resy的区别 (权威RPC)',
        titleSource: 'rpc',
        titles: { rpc: '预约平台混淆： Tock与Resy的区别 (权威RPC)' },
        updatedAt: 1000
    };
    const res4 = GeminiUtils.mergeConversation(res3.merged, incomingRpc, { source: 'network-list' });
    assert.strictEqual(res4.merged.title, '预约平台混淆： Tock与Resy的区别 (权威RPC)', 'RPC title must upgrade DOM title');
    assert.strictEqual(res4.merged.titleSource, 'rpc');
});

test('Stale Takeout snapshot must not shrink messages/messageCount/lastSeen (CON-HF7 message dimension)', () => {
    // Online record is richer (8 turns, recent lastSeen); Takeout export predates
    // the last online turns, so its snapshot is smaller with an older lastSeen.
    const online = {
        id: 'stale_demo',
        title: 'Online Title',
        titleSource: 'rpc',
        titles: { rpc: 'Online Title' },
        messages: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
        messageCount: 8,
        updatedAt: 5000,
        timestamp: 5000,
        lastSeen: '2026-09-10T12:00:00.000Z'
    };
    const staleTakeout = {
        id: 'stale_demo',
        title: 'Takeout Prefix',
        titleSource: 'takeout',
        titles: { takeout: 'Takeout Prefix' },
        messageCount: 2,
        updatedAt: 1000,
        timestamp: 1000,
        lastSeen: '2026-09-01T12:00:00.000Z'
    };

    const res = GeminiUtils.mergeConversation(online, staleTakeout, { source: 'takeout-import' });
    assert.strictEqual(res.merged.updatedAt, 5000, 'updatedAt guard keeps the newer timestamp');
    assert.strictEqual(res.merged.messageCount, 8, 'stale snapshot must not shrink messageCount');
    assert.deepStrictEqual(res.merged.messages, online.messages, 'stale snapshot must not replace messages');
    assert.strictEqual(res.merged.lastSeen, online.lastSeen, 'stale snapshot must not rewind lastSeen');
    assert.strictEqual(res.merged.titles.takeout, 'Takeout Prefix', 'takeout title slot is still seeded for the upgrade loop');
    assert.strictEqual(res.merged.title, 'Online Title', 'rpc title stays authoritative');

    // Growth direction still flows through and flags isChanged.
    const growing = {
        id: 'stale_demo',
        title: 'Online Title',
        titleSource: 'rpc',
        titles: { rpc: 'Online Title' },
        messageCount: 10,
        updatedAt: 6000,
        timestamp: 6000
    };
    const res2 = GeminiUtils.mergeConversation(
        { id: 'stale_demo', title: 'Online Title', titleSource: 'rpc', titles: { rpc: 'Online Title' }, messageCount: 8, updatedAt: 5000, timestamp: 5000 },
        growing,
        { source: 'network-list' }
    );
    assert.strictEqual(res2.merged.messageCount, 10, 'richer incoming messageCount must flow through');
    assert.strictEqual(res2.isChanged, true, 'message growth is a meaningful change');
});



