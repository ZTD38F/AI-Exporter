export {};
const test = require('node:test');
const assert = require('node:assert');

// Regression tests (audit follow-up to #414): server-authoritative timestamps
// must never be fabricated with Date.now(). #414 fixed the session-level
// takeout record; these cover the turn/message level that it missed:
//   - parseDetail.ts:328  `extractTurnTimestamp(turn) || Date.now()`
//   - takeoutHtmlParser.ts:258 `timestamp: ts || Date.now()` (user turn)
//   - takeoutHtmlParser.ts:283 `timestamp: (ts ? ts + 2000 : Date.now())` (model turn)
// A missing server timestamp stays null ("missing stays missing"). Downstream
// readers (getEffectiveTimestamp, checkIsUpdated, pagination) already treat
// null as unknown via toTimestampMs(...) ?? 0.

const { parseDetail } = require('../src/core/api/parser/parseDetail.js');
const { parseTakeoutHtmlBlocks, correlateGeneratedImages } = require('../src/core/engine/takeout/takeoutHtmlParser.js');

// --- parseDetail: a turn whose payload carries NO timestamp candidates ---
// extractTurnTimestamp reads turn[1], turn[4], turn[5], turn[last]; all are
// null/absent here, so it returns null.
const mockDetailInner = [
    [
        [
            ["c_noTsTurn_1", "r_turn_1"],
            null,
            [["用户问题：什么是光合作用？"]],
            [[["rc_model_1", ["光合作用是植物利用光能的过程。"]]]]
        ]
    ],
    null,
    null
];
const detailRawText = `)]}'\n\n${JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify(mockDetailInner)]])}`;

test('timestamp_honesty - parseDetail messages keep timestamp null when the turn has no server timestamp', () => {
    const parsed = parseDetail(detailRawText, 'noTsTurn_1');
    assert.ok(parsed.messages.length >= 1, 'fixture should yield user + model messages');
    for (const m of parsed.messages) {
        // Old behavior: `extractTurnTimestamp(turn) || Date.now()` fabricated "now" here.
        assert.strictEqual(m.timestamp, null, `message timestamp must stay null, never Date.now() (role=${m.role})`);
    }
});

// --- takeout: a block with NO timestamp text anywhere (no en/zh/iso date match) ---

const htmlNoTimestamp = `
<html><body>
  <div class="outer-cell">
    <a href="https://gemini.google.com/app/c_NoTimestamp_4242">Link</a>
    Prompted 什么是光合作用？<br>
    <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1"><p>光合作用是植物利用光能的过程。</p></div>
  </div>
</body></html>
`;

test('timestamp_honesty - takeout turn messages keep timestamp null when the block has no timestamp', async () => {
    // parseTakeoutHtmlBlocks returns the internal localConvCache where the
    // per-turn messages live (parseTakeoutZip's public result omits them).
    const { localConvCache } = await parseTakeoutHtmlBlocks({ htmlText: htmlNoTimestamp, zipFiles: {} });
    const ids = Object.keys(localConvCache);
    assert.strictEqual(ids.length, 1);
    const cached = localConvCache[ids[0]];
    assert.ok(cached.messages.length >= 1, 'fixture should yield user + model turn messages');
    for (const m of cached.messages) {
        // Old behavior: `timestamp: ts || Date.now()` / `(ts ? ts + 2000 : Date.now())`.
        assert.strictEqual(m.timestamp, null, `takeout message timestamp must stay null, never Date.now() (role=${m.role})`);
    }
});

test('timestamp_honesty - correlateGeneratedImages model turn keeps timestamp null when no server timestamp exists', () => {
    const localMediaMap: Record<string, any[]> = {};
    const localConvCache: Record<string, any> = {
        'test_cid': {
            id: 'test_cid',
            timestamp: null,
            messages: []
        }
    };
    const extractedMap: Record<string, any> = {};
    const watermarkedImages = [{ filename: 'gen_1.png', time: null, fileObj: {} }];
    const genBlocks = [{ chatId: 'test_cid', time: 0, prompt: 'draw a cat' }];

    correlateGeneratedImages(watermarkedImages, genBlocks, localMediaMap, localConvCache, extractedMap);

    const cached = localConvCache['test_cid'];
    assert.ok(cached.messages.length === 1, 'should synthesize model turn');
    const modelTurn = cached.messages[0];
    assert.strictEqual(modelTurn.role, 'model');
    // Old behavior: line 482 fell back to Date.now() when neither img.time nor cached.timestamp was set!
    assert.strictEqual(modelTurn.timestamp, null, 'synthesized model turn timestamp must stay null, never Date.now()');
});
