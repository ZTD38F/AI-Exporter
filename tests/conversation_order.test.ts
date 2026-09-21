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

    // Case 5: Falls back to lastSeen string
    const isoTime = '2026-09-03T18:00:00.000Z';
    const chat4 = {
        lastSeen: isoTime
    };
    assert.strictEqual(GeminiUtils.getEffectiveTimestamp(chat4), new Date(isoTime).getTime());
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

test('Conversation sorting - accurately orders by latest activity and never puts new chats at tail', () => {
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

    // Test 2: Brand new chat captured from DOM with recent lastSeen MUST NOT be pushed to tail
    const sorted2 = sortConversations([chatB, chatC, chatD]);
    assert.strictEqual(sorted2[0].id, 'chat_brand_new_dom', 'Brand new chat must be ranked at top and never at the tail');
    assert.notStrictEqual(sorted2[sorted2.length - 1].id, 'chat_brand_new_dom', 'Brand new chat must never be at the tail');
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
    combined.sort((a, b) => b.updatedAt - a.updatedAt);
    assert.strictEqual(combined[0].id, 'page1', 'Page 1 (newer updatedAt) must remain on top of Page 2');
    assert.strictEqual(combined[1].id, 'page2');
});

test('Conversation merge - authoritative RPC server list heals contaminated Date.now() timestamps', () => {
    function mergeWithRpcAuthority(existing: any[], incoming: any[]) {
        const map = new Map();
        existing.forEach((c: any) => map.set(c.id, { ...c }));

        incoming.forEach((c: any) => {

            const old = map.get(c.id);
            let cUpdated = c.updatedAt || c.timestamp || null;
            let oldUpdated = old?.updatedAt || old?.timestamp || null;

            let isRpcSource = c.titleSource === 'rpc' || c.source === 'network-list';
            let bestUpdatedAt = oldUpdated;
            if (cUpdated && (isRpcSource || !bestUpdatedAt || cUpdated > bestUpdatedAt)) {
                bestUpdatedAt = cUpdated;
            }

            let bestTimestamp = isRpcSource ? (cUpdated || bestUpdatedAt) : (bestUpdatedAt || old?.timestamp || c.timestamp || null);

            map.set(c.id, {
                ...(old || {}),
                ...c,
                timestamp: bestTimestamp,
                updatedAt: bestUpdatedAt || bestTimestamp
            });
        });

        return Array.from(map.values());
    }

    // Suppose old stored item was contaminated with an inflated Date.now() timestamp (e.g. 1799999999000)
    const contaminatedExisting = [
        { id: 'chat_old_history', title: 'Old History', updatedAt: 1799999999000, timestamp: 1799999999000 }
    ];

    // Authoritative RPC scan returns the true historical timestamp from Google (1700000000000)
    const rpcIncoming = [
        { id: 'chat_old_history', title: 'Old History', titleSource: 'rpc', updatedAt: 1700000000000, timestamp: 1700000000000 }
    ];

    const merged = mergeWithRpcAuthority(contaminatedExisting, rpcIncoming);
    assert.strictEqual(merged.length, 1);
    assert.strictEqual(merged[0].updatedAt, 1700000000000, 'Contaminated timestamp must be corrected by authoritative RPC timestamp');
    assert.strictEqual(merged[0].timestamp, 1700000000000, 'timestamp must be healed to true server timestamp');
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

test('Continuing old conversation - updates timestamp and elevates conversation to index 0', () => {
    const existingList = [
        { id: 'c_top1', title: 'Top 1', updatedAt: 5000, timestamp: 5000, createdAt: 4500, sidebarIndex: 0 },
        { id: 'c_top2', title: 'Top 2', updatedAt: 4000, timestamp: 4000, createdAt: 3500, sidebarIndex: 1 },
        { id: 'c_top3', title: 'Top 3', updatedAt: 3000, timestamp: 3000, createdAt: 2500, sidebarIndex: 2 },
        { id: 'c_old_chat', title: 'Old Chat Project', updatedAt: 1000, timestamp: 1000, createdAt: 800, sidebarIndex: 3, messageCount: 4 }
    ];

    // Verify initial ordering: old chat is at the tail (index 3)
    existingList.sort(GeminiUtils.compareConversations);
    assert.strictEqual(existingList[3].id, 'c_old_chat', 'Old chat should initially be at the tail');

    // User chats in c_old_chat, triggering stream-complete at now = 9000
    const now = 9000;
    const incomingTouch = {
        id: 'old_chat',
        timestamp: now,
        updatedAt: now,
        sidebarIndex: 0
    };

    const mergeRes = GeminiUtils.mergeConversation(existingList[3], incomingTouch, { source: 'stream-complete' });
    assert.strictEqual(mergeRes.isChanged, true, 'merge must flag isChanged when timestamp is bumped');
    assert.strictEqual(mergeRes.merged.updatedAt, 9000, 'updatedAt must be bumped to current stream time');
    assert.strictEqual(mergeRes.merged.timestamp, 9000, 'timestamp must be bumped to current stream time');
    assert.strictEqual(mergeRes.merged.createdAt, 800, 'original createdAt must be preserved');
    assert.strictEqual(mergeRes.merged.title, 'Old Chat Project', 'original title must be preserved');
    assert.strictEqual(mergeRes.merged.messageCount, 4, 'original messageCount must be preserved');

    // Re-sorting with the updated chat
    const updatedList = [existingList[0], existingList[1], existingList[2], mergeRes.merged];
    updatedList.sort(GeminiUtils.compareConversations);

    // Assert old_chat is now at the very top (index 0)
    assert.strictEqual(updatedList[0].id, 'old_chat', 'Continued conversation must rise to index 0 (top of list)');
    assert.strictEqual(updatedList[1].id, 'c_top1');
    assert.strictEqual(updatedList[2].id, 'c_top2');
    assert.strictEqual(updatedList[3].id, 'c_top3');
});



