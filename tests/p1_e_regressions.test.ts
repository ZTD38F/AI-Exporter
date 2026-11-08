/**
 * 每个用例均为 red-by-design：修复前失败、修复后通过，外加边界锁定用例。
 * P1-061a 注：rc_ 行首正则的 \\s*→\s* 在行为上被下游 .trim() 掩盖
 * （旧正则实际是死代码，匹配字面反斜杠+s），故用源码级断言锁定；
 * P1-061b/c 用真实行级清理的行为差异断言。
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const detailDecoder = require('../src/l1/parsers/gemini/rpc/detailDecoder.js');
const parseListMod = require('../src/l1/parsers/gemini/rpc/parseList.js');
const extractors = require('../src/l1/parsers/gemini/rpc/extractors.js');
const attachments = require('./helpers/recordFixture/attachments.js');
const { detailGen: geminiDetailGen } = require('./fixtures/providers/geminiDetail.js') as typeof import('./fixtures/providers/geminiDetail.js');
const { listGen: geminiListGen } = require('./fixtures/providers/gemini.js') as typeof import('./fixtures/providers/gemini.js');

function makeTurn(opts: {
    userPayload?: unknown; candText?: string; convId?: string; tsSec?: number; extraCand?: unknown[];
} = {}): unknown[] {
    const {
        userPayload = [["hello"]],
        candText = "world",
        convId = "c_abc123def456",
        tsSec = 1700000000,
        extraCand = []
    } = opts;
    const cand: unknown[] = ["rc_cand000001", [candText], "en", ...extraCand];
    return [
        [convId],
        [tsSec, 0],
        userPayload,
        [[cand]]
    ];
}

function modelMessageOf(res: any): any {
    return res.messages.find((m: any) => m.role === "model");
}
function userMessageOf(res: any): any {
    return res.messages.find((m: any) => m.role === "user");
}

test('P1-061a: rc_ 清洗正则使用真正的 \\s（源码级锁定，旧正则匹配字面反斜杠+s 是死代码）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/l1/parsers/gemini/rpc/turnResources.ts'), 'utf8');
    assert.ok(src.includes('/^rc_[a-z0-9_]{10,}\\s*/i'), 'rc_ 清洗正则必须使用单反斜杠 \\s');
    assert.ok(!src.includes('/^rc_[a-z0-9_]{10,}\\\\s*/i'), '不应残留双重转义 \\\\s');
});

test('P1-061b: chip URL 整行被清理（保留段落换行）', () => {
    const res = detailDecoder.decodeGeminiDetail(geminiDetailGen('G_P1E_DETAIL_01'));
    const model = modelMessageOf(res);
    assert.ok(model, '应产出 model 消息');
    assert.strictEqual(model.content, "第一行\n\n第三行");
});

test('P1-061c: 生成图片 URL 整行被清理（保留段落换行，有图片时）', () => {
    const res = detailDecoder.decodeGeminiDetail(geminiDetailGen('G_P1E_DETAIL_02'));
    const model = modelMessageOf(res);
    assert.ok(model, '应产出 model 消息');
    assert.strictEqual(model.content, "看这张图\n\n结束");
});

test('P1-062a: isTurn 对标准 turn 返回 true（快速路径，多次调用结果一致）', () => {
    const turn = makeTurn();
    assert.strictEqual(detailDecoder.isTurn(turn), true);
    assert.strictEqual(detailDecoder.isTurn(turn), true, '缓存命中结果应一致');
});

test('P1-062b: isTurn 经 candidate rc_ 前缀结构化识别（user payload 非数组时）', () => {
    const turn: unknown[] = [
        ["c_structonly1"],
        [1700000000, 0],
        "非数组形态的 user payload",
        [[["rc_resp0001", ["text"], "en"]]]
    ];
    assert.strictEqual(detailDecoder.isTurn(turn), true);
});

test('P1-062c/d: 非 turn（坏 id 前缀；仅靠 "r_" 子串的假 turn）返回 false', () => {
    assert.strictEqual(detailDecoder.isTurn([["x_123"], [1, 0], [["u"]]]), false, 'id 无 c_/r_ 前缀');
    // 旧代码 s.includes("r_") 近乎恒真，会把这种假 turn 判为真
    const fake: unknown[] = [["c_r_123", [1, 2], "music_tv", ["error_r_broken"]]];
    assert.strictEqual(detailDecoder.isTurn(fake), false, '仅含 "r_" 子串、无真实形态标记');
});

test('P1-063: metadata-only 载荷产出可见的 schemaDrift 警告（非 dev 也不静默）', () => {
    const res = detailDecoder.decodeGeminiDetail(geminiDetailGen('G_P1E_DETAIL_03'));
    assert.strictEqual(res.messages.length, 0, '无 turns 时消息为空');
    assert.ok(Array.isArray(res.schemaDrift), 'schemaDrift 不应缺席');
    assert.ok(res.schemaDrift.some((w: string) => /metadata-only/i.test(w)), '应包含 metadata-only 警告');
});

test('P1-064a: user payload[0] 为字符串时提取全文而非首字符', () => {
    const res = detailDecoder.decodeGeminiDetail(geminiDetailGen('G_P1E_DETAIL_04'));
    const user = userMessageOf(res);
    assert.ok(user, '应产出 user 消息');
    assert.strictEqual(user.content, "hello world from user");
});

test('P1-064b: 标准 [[text]] 形态的用户文本提取不变', () => {
    const res = detailDecoder.decodeGeminiDetail(geminiDetailGen('G_P1E_DETAIL_05'));
    assert.strictEqual(userMessageOf(res).content, "标准形态文本");
});

test('P1-065a: 启发式跳过仅含 "c_" 子串的错误 chunk（decodeGeminiDetail）', () => {
    // 触发条件：无标准 WRB 信封；错误 chunk 排在正确 chunk 之前；
    // 错误 chunk 含 "c_" 子串（music_）但无完整会话 ID 格式，且内藏假 turn。
    const res = detailDecoder.decodeGeminiDetail(geminiDetailGen('G_P1E_LEADING_DECOY_DETAIL_01'));
    assert.strictEqual(res.messages.length, 2, '应解析出正确 chunk 的 user+model 两条消息');
    assert.strictEqual(userMessageOf(res).content, "hello");
    assert.strictEqual(modelMessageOf(res).content, "world");
});

test('P1-065b: bogus chunks preceding a genuine LIST envelope cannot take precedence (parseList)', () => {
    const res = parseListMod.parseList(geminiListGen('G_P1E_LEADING_DECOY_LIST_01'));
    assert.strictEqual(res.conversations.length, 1);
    assert.strictEqual(res.conversations[0].id, "list0012345678");
});

test('P1-066a: messageCount 不把 item[5] 的 epoch 秒误判成消息数', () => {
    const res = parseListMod.parseList(geminiListGen('G_P1E_LIST_01'));
    assert.strictEqual(res.conversations[0].messageCount, undefined, '无有效 count 位时应为 0 而非十亿级数字');
    assert.strictEqual(res.conversations[0].updatedAt, 1757839234000, '时间戳本身仍应正确解析');
});

test('P1-066b: COUNT_ALT1 的正常 count 位仍生效', () => {
    const res = parseListMod.parseList(geminiListGen('G_P1E_LIST_02'));
    assert.strictEqual(res.conversations[0].messageCount, undefined);
});

test('P1-067a: extractTurnTimestamp 优先读 schema 声明的下标 1', () => {
    const turn: unknown[] = [["c_x"], [1700000000, 500000000], [["u"]], [[["rc_1", ["t"]]]], "tail"];
    assert.strictEqual(extractors.extractTurnTimestamp(turn), 1700000000500);
});

test('P1-067b: 下标 1 缺失时兼容旧位置（下标 4）', () => {
    const turn: unknown[] = [["c_x"], null, [["u"]], [[["rc_1", ["t"]]]], [1700000001, 0]];
    assert.strictEqual(extractors.extractTurnTimestamp(turn), 1700000001000);
});

test('P1-069a: extractImages 拒绝非 Google 媒体 host 的 URL', () => {
    const imgs = attachments.extractImages([["https://evil-tracker.com/pixel.png", 100, 100]]);
    assert.strictEqual(imgs.length, 0);
});

test('P1-069b: extractImages 保留 googleusercontent host 的 URL', () => {
    const imgs = attachments.extractImages([["https://lh3.googleusercontent.com/photo=w100", 100, 100]]);
    assert.strictEqual(imgs.length, 1);
});

test('P1-069c: extractUserFiles 拒绝非 Google 媒体 host 的 URL', () => {
    const files = attachments.extractUserFiles([["https://evil.com/doc.pdf", "doc.pdf", "id9"]]);
    assert.strictEqual(files.length, 0);
});





test('P1-071a: inferExt 识别 .svg 并给出正确 MIME（不再强制 .jpg）', () => {
    const imgs = attachments.extractImages([["https://lh3.googleusercontent.com/pic.svg", 100, 100]]);
    assert.strictEqual(imgs.length, 1);
    assert.ok(imgs[0].fileName.endsWith(".svg"), `fileName=${imgs[0].fileName}`);
    assert.strictEqual(imgs[0].mimeType, "image/svg+xml");
});

test('P1-071b: Pattern 2 的 rawFileName 扩展名与 MIME 一致（.avif）', () => {
    const node = [null, 1, "report.avif", "https://lh3.googleusercontent.com/genimg1", null, "tok123",
        null, null, null, null, null, null, null, null, null, [800, 600, 456]];
    const imgs = attachments.extractImages([node]);
    assert.strictEqual(imgs.length, 1);
    assert.strictEqual(imgs[0].fileName, "report.avif");
    assert.strictEqual(imgs[0].mimeType, "image/avif");
});

test('P1-072a: findDocContentById 不命中正文里仅"提到" ID 的节点', () => {
    const decoy = ["note", "本文引用了 doc99999 的观点\n\n" + "y".repeat(250)];
    const real = ["c_doc99999", "## 真实文档正文\n\n" + "正文".repeat(150)];
    const found = attachments.createDocumentReader([decoy, real]).byId("c_doc99999");
    assert.ok(found);
    assert.equal(found?.contentMatch, undefined);
});

test('P1-072b: findDocContentById 无匹配时返回 null', () => {
    assert.strictEqual(attachments.createDocumentReader([["a", "b"]]).byId("c_nope123456"), null);
});

test('P1-073a: extractConversationId 深搜找 ID，全程不做 JSON.stringify', () => {
    const inner = [[[[["c_deepfind1234567890"]]]]];
    const origStringify = JSON.stringify;
    (JSON as any).stringify = () => { throw new Error("must not stringify"); };
    try {
        assert.strictEqual(extractors.extractConversationId(inner), "c_deepfind1234567890");
    } finally {
        (JSON as any).stringify = origStringify;
    }
});

test('P1-073b: 找不到 ID 时返回 c_unknown', () => {
    assert.strictEqual(extractors.extractConversationId([["nothing", "here"]]), "c_unknown");
});

test('P1-074a: 无时间戳的会话返回 null 而非伪造 Date.now()', () => {
    const res = parseListMod.parseList(geminiListGen('G_P1E_LIST_03'));
    const c = res.conversations[0];
    assert.strictEqual(c.createdAt, undefined);
    assert.strictEqual(c.updatedAt, undefined);
    assert.strictEqual(c.chatTime, undefined);
    assert.strictEqual(c.timestamp, undefined);
});

test('P1-074b: 有真实时间戳的会话仍正确解析', () => {
    const res = parseListMod.parseList(geminiListGen('G_P1E_LIST_04'));
    const c = res.conversations[0];
    assert.strictEqual(c.createdAt, undefined);
    assert.strictEqual(c.updatedAt, 1700000000000);
});
