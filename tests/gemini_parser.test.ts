export {};
const test = require('node:test');
const assert = require('node:assert');
const { GeminiResponseParserClass, isRealTitle } = require('../src/core/api/geminiParser.js');
const { isRealTitle: utilsIsRealTitle, cleanTitle } = require('../src/core/utils/utils.js');

test('gemini_parser - isRealTitle', () => {
    assert.strictEqual(isRealTitle(''), false);
    assert.strictEqual(isRealTitle('Untitled'), false);
    assert.strictEqual(isRealTitle('未命名'), false);
    assert.strictEqual(isRealTitle('New chat'), false);
    assert.strictEqual(isRealTitle('Gemini'), false);
    assert.strictEqual(isRealTitle('Google Gemini'), false);
    assert.strictEqual(isRealTitle('Google Bard'), false);
    assert.strictEqual(isRealTitle('Google AI'), false);
    assert.strictEqual(isRealTitle('39d5b41870e49a67'), false);
    assert.strictEqual(isRealTitle('c_39d5b41870e49a67'), false);
    assert.strictEqual(isRealTitle('我拟定了一个研究方案'), false);
    assert.strictEqual(isRealTitle('量子计算的基本原理'), true);
    assert.strictEqual(isRealTitle('AI Prompt Engineering Guide'), true);
});

test('utils - cleanTitle brand suffix and prefix stripping', () => {
    assert.strictEqual(cleanTitle('Google Gemini'), '');
    assert.strictEqual(cleanTitle('Gemini'), '');
    assert.strictEqual(cleanTitle('Google Bard'), '');
    assert.strictEqual(cleanTitle('Google AI'), '');
    assert.strictEqual(cleanTitle('量子计算的基本原理 - Google Gemini'), '量子计算的基本原理');
    assert.strictEqual(cleanTitle('深度学习架构 - Gemini'), '深度学习架构');
    assert.strictEqual(cleanTitle('Python 性能优化 | Google Gemini'), 'Python 性能优化');
    assert.strictEqual(cleanTitle('Gemini - 机器学习实战'), '机器学习实战');
    assert.strictEqual(cleanTitle('Google Gemini - 分布式系统设计'), '分布式系统设计');
    assert.strictEqual(cleanTitle('AI 提示词工程 · Gemini'), 'AI 提示词工程');
    assert.strictEqual(cleanTitle('纯净标题没有后缀'), '纯净标题没有后缀');
});

test('gemini_parser - highResVariant', () => {
    const orig = 'https://lh3.googleusercontent.com/abc=s256';
    const high = GeminiResponseParserClass.highResVariant(orig);
    assert.strictEqual(high, 'https://lh3.googleusercontent.com/abc=s0');

    // Never mutate Google Places / Maps photo CDN signatures
    const places = 'https://lh3.googleusercontent.com/places/v1/media/xyz';
    assert.strictEqual(GeminiResponseParserClass.highResVariant(places), places);
});

test('gemini_parser - parseList with valid batchexecute RPC text', () => {
    const inner = JSON.stringify([null, [["c_1234567890abcdef","Test Title",[1700000000,0],[1700000000,0],5]], "tC_token123"]);
    const outer = JSON.stringify([["wrb.fr","MaZiqc",inner]]);
    const mockRpc = `)]}'\n\n${outer}`;
    const res = GeminiResponseParserClass.parseList(mockRpc);
    assert.strictEqual(res.conversations.length, 1);
    assert.strictEqual(res.conversations[0].id, '1234567890abcdef');
    assert.strictEqual(res.conversations[0].title, 'Test Title');
    assert.strictEqual(res.nextPageToken, 'tC_token123');
});

test('utils - resolveTitle multi-tier source priority arbitration', () => {
    const { resolveTitle, setTitleBySource } = require('../src/core/utils/utils.js');

    // 1. Takeout only
    const chatTakeout = {
        id: 'chat_1',
        titles: { takeout: '什么是量子计算？' }
    };
    const res1 = resolveTitle(chatTakeout);
    assert.strictEqual(res1.title, '什么是量子计算？');
    assert.strictEqual(res1.source, 'takeout');

    // 2. Takeout + Sniffed low-tier loading title (e.g. Google Gemini)
    // Low tier should NOT trample Takeout!
    setTitleBySource(chatTakeout, 'sniff', 'Google Gemini');
    const res2 = resolveTitle(chatTakeout);
    assert.strictEqual(res2.title, '什么是量子计算？');
    assert.strictEqual(res2.source, 'takeout');

    // 3. Takeout + DOM Header (DOM should win over Takeout)
    setTitleBySource(chatTakeout, 'dom', '量子计算超导路线详解');
    const res3 = resolveTitle(chatTakeout);
    assert.strictEqual(res3.title, '量子计算超导路线详解');
    assert.strictEqual(res3.source, 'dom');

    // 4. RPC arrives (RPC Tier 1 should win over DOM and Takeout)
    setTitleBySource(chatTakeout, 'rpc', '量子计算与超导量子比特深度解析');
    const res4 = resolveTitle(chatTakeout);
    assert.strictEqual(res4.title, '量子计算与超导量子比特深度解析');
    assert.strictEqual(res4.source, 'rpc');

    // 5. Subsequent sniff should NEVER degrade RPC title
    setTitleBySource(chatTakeout, 'sniff', '辅助嗅探文本');
    const res5 = resolveTitle(chatTakeout);
    assert.strictEqual(res5.title, '量子计算与超导量子比特深度解析');
    assert.strictEqual(res5.source, 'rpc');

    // 6. Legacy fallback
    const legacyChat = { id: 'legacy_1', title: '旧版直接保存的标题' };
    const resLegacy = resolveTitle(legacyChat);
    assert.strictEqual(resLegacy.title, '旧版直接保存的标题');
    assert.strictEqual(resLegacy.source, 'legacy');
});

test('gemini_parser - parseDetail with bundled MaZiqc metadata RPC extracts official RPC title', () => {
    const mockDetailInner = [
        [
            [
                ["c_d3226d9a046c1116", "r_turn_1"],
                null,
                [["然后mod要怎么打呢，我下载了一个mod文件，但是https://www.nexusmods.com/slaythespire2/mods/91"]],
                [[["rc_model_1", ["这是Mod安装解答内容"]]]]
            ]
        ],
        null,
        null
    ];
    const mockMetaInner = [
        null,
        null,
        [["c_d3226d9a046c1116", "杀戮尖塔存档删除Mod风险", null, null, null, [1774139824, 809290000], null, null, null, 2]]
    ];

    const topPayload = [
        ["wrb.fr", "hNvQHb", JSON.stringify(mockDetailInner)],
        ["wrb.fr", "MaZiqc", JSON.stringify(mockMetaInner)]
    ];
    const rawText = `)]}'\n\n${JSON.stringify(topPayload)}`;

    const parsed = GeminiResponseParserClass.parseDetail(rawText, 'd3226d9a046c1116');
    assert.strictEqual(parsed.id.replace(/^c_/, ''), 'd3226d9a046c1116');
    assert.strictEqual(parsed.title, '杀戮尖塔存档删除Mod风险');
    assert.strictEqual(parsed.titleSource, 'rpc');
    assert.strictEqual(parsed.titles.rpc, '杀戮尖塔存档删除Mod风险');
    assert.strictEqual(parsed.messages.length, 2);
});

test('gemini_parser - parseDetail with hNvQHb only falls back gracefully', () => {
    const mockDetailInner = [
        [
            [
                ["c_fallback_123", "r_turn_1"],
                null,
                [["如何用Rust写WebAssembly插件"]],
                [[["rc_model_1", ["这是Rust WebAssembly回答"]]]]
            ]
        ],
        null,
        "Rust WebAssembly 开发实战"
    ];

    const topPayload = [
        ["wrb.fr", "hNvQHb", JSON.stringify(mockDetailInner)]
    ];
    const rawText = `)]}'\n\n${JSON.stringify(topPayload)}`;

    const parsed = GeminiResponseParserClass.parseDetail(rawText, 'fallback_123');
    assert.strictEqual(parsed.id.replace(/^c_/, ''), 'fallback_123');
    assert.strictEqual(parsed.title, 'Rust WebAssembly 开发实战');
    assert.strictEqual(parsed.titleSource, 'rpc');
    assert.strictEqual(parsed.messages.length, 2);
});

test('gemini_parser - parseDetail with metadata-only payload returns empty messages and retains raw', () => {
    const mockMetaOnlyInner = [
        null,
        null,
        [["c_meta_only_456", "仅元数据标题", null, null, null, [1774139824, 809290000], null, null, null, 2]]
    ];
    const topPayload = [
        ["wrb.fr", "hNvQHb", JSON.stringify(mockMetaOnlyInner)]
    ];
    const rawText = `)]}'\n\n${JSON.stringify(topPayload)}`;

    const parsed = GeminiResponseParserClass.parseDetail(rawText, 'meta_only_456');
    assert.strictEqual(parsed.id.replace(/^c_/, ''), 'meta_only_456');
    assert.strictEqual(parsed.messages.length, 0);
    assert.ok(parsed._raw);
    assert.strictEqual(parsed._raw[2][0][0], 'c_meta_only_456');
});

test('gemini_parser - JSPB schema and candidate extraction filters telemetry and language code', () => {
    const { GEMINI_JSPB_SCHEMA, detectTurnSchemaDrift } = GeminiResponseParserClass;
    assert.ok(GEMINI_JSPB_SCHEMA, 'GEMINI_JSPB_SCHEMA should be exported');
    assert.strictEqual(typeof detectTurnSchemaDrift, 'function', 'detectTurnSchemaDrift should be function');

    // Simulate real Gemini response with Grounding search query, provider, and telemetry tokens
    const mockModelTurn = [
        [
            [
                "rc_024c7ad5d90f4db8",
                [
                    ["不能。如果你的CAS完全没有装备机枪，是无法夺取制空权的。"],
                    "zh" // Language code tag - MUST NOT leak into message body
                ]
            ]
        ],
        [["hoi4 air wing equipment filtering tags"]], // Grounding search query - MUST NOT become a message
        "google",                                    // Search provider - MUST NOT become a message
        "c",                                         // Status code - MUST NOT become a message
        "S",                                         // Status code - MUST NOT become a message
        6,                                           // Telemetry - MUST NOT become a message
        6,                                           // Telemetry - MUST NOT become a message
        "."                                          // Telemetry - MUST NOT become a message
    ];

    const turn = [
        ["c_024c7ad5d90f4db8", "r_turn_1"],
        [1717058840, 264000000],
        [["如果cas不带机枪的话能抢制空么"]],
        mockModelTurn
    ];

    const mockDetailInner = [[turn], null, "钢铁雄心4制空测试"];
    const topPayload = [["wrb.fr", "hNvQHb", JSON.stringify(mockDetailInner)]];
    const rawText = `)]}'\n\n${JSON.stringify(topPayload)}`;

    const parsed = GeminiResponseParserClass.parseDetail(rawText, '024c7ad5d90f4db8');

    // MUST be exactly 2 messages (1 user, 1 model), NOT 8 or 9!
    assert.strictEqual(parsed.messages.length, 2, `Expected exactly 2 messages, got ${parsed.messages.length}`);
    assert.strictEqual(parsed.messages[0].role, 'user');
    assert.strictEqual(parsed.messages[0].content, '如果cas不带机枪的话能抢制空么');

    assert.strictEqual(parsed.messages[1].role, 'model');
    // Content must be clean and NOT polluted with trailing 'zh'
    assert.strictEqual(parsed.messages[1].content, '不能。如果你的CAS完全没有装备机枪，是无法夺取制空权的。');
    assert.strictEqual(parsed.messages[1].content.endsWith('zh'), false, 'Content must not end with language tag zh');

    // None of the telemetry or grounding tokens should exist as messages
    const contents = parsed.messages.map((m: any) => m.content);
    assert.ok(!contents.includes('hoi4 air wing equipment filtering tags'));
    assert.ok(!contents.includes('google'));
    assert.ok(!contents.includes('c'));
    assert.ok(!contents.includes('S'));
    assert.ok(!contents.includes('6'));
    assert.ok(!contents.includes('.'));
});

test('gemini_parser - detectTurnSchemaDrift detects malformed and healthy turns', () => {
    const { detectTurnSchemaDrift } = GeminiResponseParserClass;

    // Healthy turn
    const healthyTurn = [
        ["c_valid_123", "r_turn_1"],
        [1717058840, 0],
        [["测试提问"]],
        [[["rc_cand_1", [["测试回答"]]]]]
    ];
    const healthyCheck = detectTurnSchemaDrift(healthyTurn, 'valid_123');
    assert.strictEqual(healthyCheck.isDrifted, false);
    assert.strictEqual(healthyCheck.warnings.length, 0);

    // Drifting turn: missing turn ID meta and corrupted model payload
    const driftedTurn = [
        ["corrupted_meta"],
        null
    ];
    const driftCheck = detectTurnSchemaDrift(driftedTurn, 'bad_conv');
    assert.strictEqual(driftCheck.isDrifted, true);
    assert.ok(driftCheck.warnings.length >= 1);
});

test('gemini_parser - sub-modules and unified deepWalk verification', () => {
    const extractors = require('../src/core/api/parser/extractors.js');
    const attachments = require('../src/core/api/parser/attachments.js');
    const parseListMod = require('../src/core/api/parser/parseList.js');
    const parseDetailMod = require('../src/core/api/parser/parseDetail.js');

    // 1. deepWalk unified tree walker
    const visited: string[] = [];
    const tree = { a: [1, { b: 2, c: [3, 4] }], d: 5 };
    extractors.deepWalk(tree, (node: any) => {
        if (typeof node === 'object' && !Array.isArray(node)) {
            visited.push(Object.keys(node).join(','));
        }
    });
    assert.ok(visited.includes('a,d'));
    assert.ok(visited.includes('b,c'));

    // Early termination in deepWalk
    let earlyCount = 0;
    extractors.deepWalk([1, 2, [3, 4, [5, 6]]], (node: any) => {
        earlyCount++;
        if (Array.isArray(node) && node.length === 3) {
            return false; // Stop descending
        }
    });
    assert.ok(earlyCount < 5, 'deepWalk should stop descending when visitor returns false');

    // 2. extractors: thoughts & citations
    const candBlock = [
        ["THOUGHT", "Thinking deeply about quantum physics..."],
        ["https://arxiv.org/abs/1234.5678", "Quantum Supremacy Paper"],
        ["https://googleusercontent.com/immersive_entry_chip/ignored", "Chip"]
    ];
    const thoughts = extractors.extractThoughts(candBlock);
    assert.strictEqual(thoughts, "Thinking deeply about quantum physics...");

    const citations = extractors.extractCitations(candBlock);
    assert.strictEqual(citations.length, 1);
    assert.strictEqual(citations[0].url, "https://arxiv.org/abs/1234.5678");
    assert.strictEqual(citations[0].title, "Quantum Supremacy Paper");

    // 3. attachments: highResVariant & isInternalChipUrl
    assert.strictEqual(attachments.highResVariant("https://lh3.googleusercontent.com/pic=w500-h300"), "https://lh3.googleusercontent.com/pic=s0");
    assert.strictEqual(attachments.isInternalChipUrl("https://googleusercontent.com/immersive_entry_chip/abc"), true);
    assert.strictEqual(attachments.isInternalChipUrl("https://example.com/normal.png"), false);

    // 4. parseList: timestamp extraction
    const mockItem = ["c_test", "Title", null, null, null, [1720000000, 500000000]];
    const ts = parseListMod.extractListItemTimestamp(mockItem);
    assert.strictEqual(ts, 1720000000500);

    // 5. Facade 26 methods presence
    const expectedMethods = [
        'GEMINI_JSPB_SCHEMA', 'detectTurnSchemaDrift', 'extractModelCandidates', 'extractCandidateText',
        'robustFirstPayload', 'extractTurnTimestamp', 'extractImageSelectionIndex', 'getImageDedupKey',
        'filterNewImages', 'highResVariant', 'extractImages', 'extractUserFiles', 'extractDocumentsMeta',
        'findDocContentById', 'parseDocSections', 'findDocMarkdownByClues', 'extractThoughts',
        'extractCitations', 'extractConversationId', 'extractConversationTitle', 'isRealTitle',
        'cleanTitle', 'normId', 'extractListItemTimestamp', 'parseList', 'parseDetail'
    ];
    for (const m of expectedMethods) {
        assert.ok(GeminiResponseParserClass[m] !== undefined, `Missing method on GeminiResponseParserClass: ${m}`);
    }
});

test('gemini_parser - isTurn accepts r_ prefixed turn IDs in addition to c_ prefixed turn IDs', () => {
    const parseDetailMod = require('../src/core/api/parser/parseDetail.js');
    const turnWithR = [
        ["r_testturn123", "rc_candidate1"],
        [1700000000, 0],
        [["User prompt text"]],
        [[["rc_response1", [["Model response text"]]]]]
    ];
    assert.strictEqual(
        parseDetailMod.isTurn(turnWithR),
        true,
        "isTurn must recognize turns with r_ prefix as valid turns"
    );
});

test('gemini_parser - detectTurnSchemaDrift returns structured drift diagnosis', () => {
    const corruptedTurn = [
        ["c_corrupt123"],
        [1700000000, 0],
        "not an array payload"
    ];
    const drift = GeminiResponseParserClass.detectTurnSchemaDrift(corruptedTurn, "test_conv");
    assert.strictEqual(typeof drift.isDrifted, "boolean");
    assert.strictEqual(drift.isDrifted, true);
    assert.ok(Array.isArray(drift.warnings) && drift.warnings.length > 0);
});

test('gemini_parser - robustFirstPayload parses nested JSON strings with brackets inside quotes', () => {
    const jsonWithBracketsInString = JSON.stringify([
        ["wrb.fr", "hNvQHb", JSON.stringify([["c_123", "Title with [brackets] inside", "data"]])]
    ]);
    const rpcText = `)]}'\n\n${jsonWithBracketsInString}`;
    const parsed = GeminiResponseParserClass.robustFirstPayload(rpcText) as any[][];
    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0][0], "wrb.fr");
    assert.strictEqual(parsed[0][1], "hNvQHb");
});

