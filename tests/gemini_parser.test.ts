import { parseGeminiRequest } from '../src/l1/parsers/gemini/rpc/request.js';
import { geminiListPage, GEMINI_LIST_CAPTURE } from './fixtures/providers/geminiListCapture.js';
const { decodeGeminiDetail } = require('../src/l1/parsers/gemini/rpc/detailDecoder.js');
const { detailGen: geminiDetailGen } = require('./fixtures/providers/geminiDetail.js') as typeof import('./fixtures/providers/geminiDetail.js');
const { parseList } = require('../src/l1/parsers/gemini/rpc/parseList.js');
const { isRealTitle, detectTurnSchemaDrift, robustFirstPayload } = require('../src/l1/parsers/gemini/rpc/extractors.js');
export {};
const test = require('node:test');
const assert = require('node:assert');
const { cleanTitle } = require('../src/shared/utils/titleText.js');

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



test('gemini_parser - parseList with valid batchexecute RPC text', () => {
    const mockRpc = geminiListPage().responseBody;
    const res = parseList(mockRpc);
    assert.strictEqual(res.conversations.length, GEMINI_LIST_CAPTURE.firstPageRows);
    assert.strictEqual(res.conversations[0].id, GEMINI_LIST_CAPTURE.first.id);
    assert.strictEqual(res.conversations[0].title, GEMINI_LIST_CAPTURE.first.title);
    assert.strictEqual(res.nextPageToken, parseGeminiRequest(geminiListPage(1).requestBody).list!.requestCursor);
});

test('gemini_parser - decodeGeminiDetail with bundled MaZiqc metadata RPC extracts official RPC title', () => {
    const rawText = geminiDetailGen('G_GEMINI_PARSER_MIXED_TITLE_01');
    const parsed = decodeGeminiDetail(rawText, 'd3226d9a046c1116');
    assert.strictEqual(parsed.id.replace(/^c_/, ''), 'd3226d9a046c1116');
    assert.strictEqual(parsed.title, '杀戮尖塔存档删除Mod风险');
    assert.strictEqual(parsed.titleSource, 'rpc');
    assert.equal(Object.hasOwn(parsed, 'titles'), false);
    assert.strictEqual(parsed.messages.length, 2);
});

test('gemini_parser - decodeGeminiDetail with hNvQHb only falls back gracefully', () => {
    const rawText = geminiDetailGen('G_DETAIL_PARSER_FALLBACK_01');

    const parsed = decodeGeminiDetail(rawText, 'fallback_123');
    assert.strictEqual(parsed.id.replace(/^c_/, ''), 'fallback_123');
    assert.strictEqual(parsed.title, 'Rust WebAssembly 开发实战');
    assert.strictEqual(parsed.titleSource, 'rpc');
    assert.strictEqual(parsed.messages.length, 2);
});

test('gemini_parser - decodeGeminiDetail with metadata-only payload returns empty messages and retains raw', () => {
    const rawText = geminiDetailGen('G_DETAIL_PARSER_META_ONLY_01');

    const parsed = decodeGeminiDetail(rawText, 'meta_only_456');
    assert.strictEqual(parsed.id.replace(/^c_/, ''), 'meta_only_456');
    assert.strictEqual(parsed.messages.length, 0);
    assert.ok(parsed._raw);
    assert.strictEqual(parsed._raw[2][0][0], 'c_meta_only_456');
});

test('gemini_parser - JSPB schema and candidate extraction filters telemetry and language code', () => {
    const { GEMINI_JSPB_SCHEMA, detectTurnSchemaDrift } = require('../src/l1/parsers/gemini/rpc/extractors.js');
    assert.ok(GEMINI_JSPB_SCHEMA, 'GEMINI_JSPB_SCHEMA should be exported');
    assert.strictEqual(typeof detectTurnSchemaDrift, 'function', 'detectTurnSchemaDrift should be function');

    const rawText = geminiDetailGen('G_GEMINI_PARSER_DETAIL_01');

    const parsed = decodeGeminiDetail(rawText, '024c7ad5d90f4db8');

    // MUST be exactly 2 messages (1 user, 1 model), NOT 8 or 9!
    assert.strictEqual(parsed.messages.length, 2, `Expected exactly 2 messages, got ${parsed.messages.length}`);
    assert.strictEqual(parsed.messages[0].role, 'user');
    assert.strictEqual(parsed.messages[0].content, '如果cas不带机枪的话能抢制空么');

    assert.strictEqual(parsed.messages[1].role, 'model');
    assert.strictEqual(parsed.messages[1].content, '不能。如果你的CAS完全没有装备机枪，是无法夺取制空权的。');
    assert.strictEqual(parsed.messages[1].content.endsWith('zh'), false, 'Content must not end with language tag zh');

    const contents = parsed.messages.map((m: any) => m.content);
    assert.ok(!contents.includes('hoi4 air wing equipment filtering tags'));
    assert.ok(!contents.includes('google'));
    assert.ok(!contents.includes('c'));
    assert.ok(!contents.includes('S'));
    assert.ok(!contents.includes('6'));
    assert.ok(!contents.includes('.'));
});

test('gemini_parser - detectTurnSchemaDrift detects malformed and healthy turns', () => {
    const { detectTurnSchemaDrift } = require('../src/l1/parsers/gemini/rpc/extractors.js');

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
    const extractors = require('../src/l1/parsers/gemini/rpc/extractors.js');
    const attachments = require('./helpers/recordFixture/attachments.js');
    const parseListMod = require('../src/l1/parsers/gemini/rpc/parseList.js');

    const visited: string[] = [];
    const tree = { a: [1, { b: 2, c: [3, 4] }], d: 5 };
    extractors.deepWalk(tree, (node: object) => {
        assert.equal(typeof node, 'object', 'the walker only visits non-null object nodes');
        if (!Array.isArray(node)) visited.push(Object.keys(node).join(','));
    });
    assert.deepStrictEqual(visited, ['a,d', 'b,c']);

    let earlyCount = 0;
    extractors.deepWalk([1, 2, [3, 4, [5, 6]]], (node: object) => {
        earlyCount++;
        if (Array.isArray(node) && node.length === 3) {
            return false; // Stop descending
        }
    });
    assert.ok(earlyCount < 5, 'deepWalk should stop descending when visitor returns false');

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

    assert.strictEqual(attachments.isInternalChipUrl("https://googleusercontent.com/immersive_entry_chip/abc"), true);
    assert.strictEqual(attachments.isInternalChipUrl("https://example.com/normal.png"), false);

    // 4. The production LIST row decoder owns timestamp interpretation.
    const mockItem = ["c_test", "Title", null, null, null, [1720000000, 500000000]];
    const decoded = parseListMod.decodeGeminiListRow(mockItem);
    assert.strictEqual(decoded?.id, 'test');
    assert.strictEqual(decoded?.updatedAt, 1720000000500);
    assert.strictEqual(decoded?.orderTime, 1720000000500);


});

test('gemini_parser - isTurn accepts r_ prefixed turn IDs in addition to c_ prefixed turn IDs', () => {
    const detailDecoder = require('../src/l1/parsers/gemini/rpc/detailDecoder.js');
    const turnWithR = [
        ["r_testturn123", "rc_candidate1"],
        [1700000000, 0],
        [["User prompt text"]],
        [[["rc_response1", [["Model response text"]]]]]
    ];
    assert.strictEqual(
        detailDecoder.isTurn(turnWithR),
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
    const drift = detectTurnSchemaDrift(corruptedTurn, "test_conv");
    assert.strictEqual(typeof drift.isDrifted, "boolean");
    assert.strictEqual(drift.isDrifted, true);
    assert.ok(Array.isArray(drift.warnings) && drift.warnings.length > 0);
});

test('gemini_parser - robustFirstPayload parses nested JSON strings with brackets inside quotes', () => {
    const rpcText = geminiDetailGen('G_GEMINI_PARSER_DETAIL_02');
    const parsed = robustFirstPayload(rpcText) as any[][];
    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0][0], "wrb.fr");
    assert.strictEqual(parsed[0][1], "hNvQHb");
});

