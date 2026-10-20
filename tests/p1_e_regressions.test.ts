/**
 * P1-E 回归测试 —— 2026-09-15 代码审查 E 组「解析器：形态识别误判与静默丢数据」
 * P1-061 ~ P1-074，共 30 个用例。
 *
 * 每个用例均为 red-by-design：修复前失败、修复后通过，外加边界锁定用例。
 * P1-061a 注：rc_ 行首正则的 \\s*→\s* 在行为上被下游 .trim() 掩盖
 * （旧正则实际是死代码，匹配字面反斜杠+s），故用源码级断言锁定；
 * P1-061b/c 用真实行级清理的行为差异断言。
 *
 * 运行：node -r ./tests/ts_register.js --test tests/p1_e_regressions.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const parseDetailMod = require('../src/core/api/parser/parseDetail.js');
const parseListMod = require('../src/core/api/parser/parseList.js');
const extractors = require('../src/core/api/parser/extractors.js');
const attachments = require('../src/core/api/parser/attachments.js');

// ---------------------------------------------------------------- helpers
function makeDetailRpc(inner: unknown): string {
    const innerStr = JSON.stringify(inner);
    const outer = JSON.stringify([["wrb.fr", "hNvQHb", innerStr]]);
    return `)]}'\n\n${outer}`;
}

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

function makeListRpc(items: unknown[]): string {
    const innerStr = JSON.stringify([null, items, null]);
    const outer = JSON.stringify([["wrb.fr", "MaZiqc", innerStr]]);
    return `)]}'\n\n${outer}`;
}

function modelMessageOf(res: any): any {
    return res.messages.find((m: any) => m.role === "model");
}
function userMessageOf(res: any): any {
    return res.messages.find((m: any) => m.role === "user");
}

// ---------------------------------------------------------------- P1-061
test('P1-061a: rc_ 清洗正则使用真正的 \\s（源码级锁定，旧正则匹配字面反斜杠+s 是死代码）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/core/api/parser/parseDetail.ts'), 'utf8');
    assert.ok(src.includes('/^rc_[a-z0-9_]{10,}\\s*/i'), 'rc_ 清洗正则必须使用单反斜杠 \\s');
    assert.ok(!src.includes('/^rc_[a-z0-9_]{10,}\\\\s*/i'), '不应残留双重转义 \\\\s');
});

test('P1-061b: chip URL 整行被清理（保留段落换行）', () => {
    const turn = makeTurn({ candText: "第一行\nhttps://googleusercontent.com/immersive_entry_chip/abc123\n第三行" });
    const res = parseDetailMod.parseDetail(makeDetailRpc([[turn]]));
    const model = modelMessageOf(res);
    assert.ok(model, '应产出 model 消息');
    assert.strictEqual(model.content, "第一行\n\n第三行");
});

test('P1-061c: 生成图片 URL 整行被清理（保留段落换行，有图片时）', () => {
    const turn = makeTurn({
        candText: "看这张图\nhttps://googleusercontent.com/image_generation_content/tok999\n结束",
        extraCand: [["https://lh3.googleusercontent.com/img=w100", 100, 100]]
    });
    const res = parseDetailMod.parseDetail(makeDetailRpc([[turn]]));
    const model = modelMessageOf(res);
    assert.ok(model, '应产出 model 消息');
    assert.strictEqual(model.content, "看这张图\n\n结束");
});

// ---------------------------------------------------------------- P1-062
test('P1-062a: isTurn 对标准 turn 返回 true（快速路径，多次调用结果一致）', () => {
    const turn = makeTurn();
    assert.strictEqual(parseDetailMod.isTurn(turn), true);
    assert.strictEqual(parseDetailMod.isTurn(turn), true, '缓存命中结果应一致');
});

test('P1-062b: isTurn 经 candidate rc_ 前缀结构化识别（user payload 非数组时）', () => {
    const turn: unknown[] = [
        ["c_structonly1"],
        [1700000000, 0],
        "非数组形态的 user payload",
        [[["rc_resp0001", ["text"], "en"]]]
    ];
    assert.strictEqual(parseDetailMod.isTurn(turn), true);
});

test('P1-062c/d: 非 turn（坏 id 前缀；仅靠 "r_" 子串的假 turn）返回 false', () => {
    assert.strictEqual(parseDetailMod.isTurn([["x_123"], [1, 0], [["u"]]]), false, 'id 无 c_/r_ 前缀');
    // 旧代码 s.includes("r_") 近乎恒真，会把这种假 turn 判为真
    const fake: unknown[] = [["c_r_123", [1, 2], "music_tv", ["error_r_broken"]]];
    assert.strictEqual(parseDetailMod.isTurn(fake), false, '仅含 "r_" 子串、无真实形态标记');
});

// ---------------------------------------------------------------- P1-063
test('P1-063: metadata-only 载荷产出可见的 schemaDrift 警告（非 dev 也不静默）', () => {
    const inner = [null, null, [["c_meta1234567890", "元数据标题", "x"]]];
    const res = parseDetailMod.parseDetail(makeDetailRpc(inner));
    assert.strictEqual(res.messages.length, 0, '无 turns 时消息为空');
    assert.ok(Array.isArray(res.schemaDrift), 'schemaDrift 不应缺席');
    assert.ok(res.schemaDrift.some((w: string) => /metadata-only/i.test(w)), '应包含 metadata-only 警告');
});

// ---------------------------------------------------------------- P1-064
test('P1-064a: user payload[0] 为字符串时提取全文而非首字符', () => {
    const turn = makeTurn({ userPayload: ["hello world from user"] });
    const res = parseDetailMod.parseDetail(makeDetailRpc([[turn]]));
    const user = userMessageOf(res);
    assert.ok(user, '应产出 user 消息');
    assert.strictEqual(user.content, "hello world from user");
});

test('P1-064b: 标准 [[text]] 形态的用户文本提取不变', () => {
    const turn = makeTurn({ userPayload: [["标准形态文本"]] });
    const res = parseDetailMod.parseDetail(makeDetailRpc([[turn]]));
    assert.strictEqual(userMessageOf(res).content, "标准形态文本");
});

// ---------------------------------------------------------------- P1-065
test('P1-065a: 启发式跳过仅含 "c_" 子串的错误 chunk（parseDetail）', () => {
    // 触发条件：无标准 WRB 信封；错误 chunk 排在正确 chunk 之前；
    // 错误 chunk 含 "c_" 子串（music_）但无完整会话 ID 格式，且内藏假 turn。
    const junkStr = JSON.stringify({ data: [[["c_r_12345", [1, 2], "music_tv talk", null]]] });
    const goodInnerStr = JSON.stringify([[makeTurn()]]);
    const outer = JSON.stringify([
        ["x.fr", "junk", junkStr],
        ["y.fr", "data", goodInnerStr]
    ]);
    const res = parseDetailMod.parseDetail(`)]}'\n\n${outer}`);
    assert.strictEqual(res.messages.length, 2, '应解析出正确 chunk 的 user+model 两条消息');
    assert.strictEqual(userMessageOf(res).content, "hello");
    assert.strictEqual(modelMessageOf(res).content, "world");
});

test('P1-065b: 启发式跳过仅含 "c_" 子串的错误 chunk（parseList）', () => {
    const junkStr = JSON.stringify("just public_wifi talk");
    const listInnerStr = JSON.stringify([null, [["c_list0012345678", "ListTitle", null, null, 5]], null]);
    const outer = JSON.stringify([
        ["x.fr", "junk", junkStr],
        ["y.fr", "data", listInnerStr]
    ]);
    const res = parseListMod.parseList(`)]}'\n\n${outer}`);
    assert.strictEqual(res.conversations.length, 1);
    assert.strictEqual(res.conversations[0].id, "list0012345678");
});

// ---------------------------------------------------------------- P1-066
test('P1-066a: messageCount 不把 item[5] 的 epoch 秒误判成消息数', () => {
    const res = parseListMod.parseList(makeListRpc([["c_cnt1234567890", "T", null, null, null, 1757839234]]));
    assert.strictEqual(res.conversations[0].messageCount, 0, '无有效 count 位时应为 0 而非十亿级数字');
    assert.strictEqual(res.conversations[0].updatedAt, 1757839234000, '时间戳本身仍应正确解析');
});

test('P1-066b: COUNT_ALT1 的正常 count 位仍生效', () => {
    const res = parseListMod.parseList(makeListRpc([["c_cnt2234567890", "T2", null, null, 7]]));
    assert.strictEqual(res.conversations[0].messageCount, 7);
});

// ---------------------------------------------------------------- P1-067
test('P1-067a: extractTurnTimestamp 优先读 schema 声明的下标 1', () => {
    const turn: unknown[] = [["c_x"], [1700000000, 500000000], [["u"]], [[["rc_1", ["t"]]]], "tail"];
    assert.strictEqual(extractors.extractTurnTimestamp(turn), 1700000000500);
});

test('P1-067b: 下标 1 缺失时兼容旧位置（下标 4）', () => {
    const turn: unknown[] = [["c_x"], null, [["u"]], [[["rc_1", ["t"]]]], [1700000001, 0]];
    assert.strictEqual(extractors.extractTurnTimestamp(turn), 1700000001000);
});

// ---------------------------------------------------------------- P1-068
test('P1-068a: 图片选择 token 非纯数字时返回 undefined（不虚构序号）', () => {
    assert.strictEqual(
        attachments.extractImageSelectionIndex("https://googleusercontent.com/image_generation_content/4ZxAbC123"),
        undefined
    );
});

test('P1-068b: 纯数字 token 仍返回序号', () => {
    assert.strictEqual(
        attachments.extractImageSelectionIndex("https://googleusercontent.com/image_generation_content/12"),
        12
    );
});

// ---------------------------------------------------------------- P1-069
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

// ---------------------------------------------------------------- P1-070
test('P1-070a: highResVariant 保留 query 参数（鉴权参数不被吞掉）', () => {
    assert.strictEqual(
        attachments.highResVariant("https://lh3.googleusercontent.com/abc=w1024?authuser=0&sz=1"),
        "https://lh3.googleusercontent.com/abc=s0?authuser=0&sz=1"
    );
});

test('P1-070b: highResVariant 仍归一化末尾尺寸参数', () => {
    assert.strictEqual(
        attachments.highResVariant("https://lh3.googleusercontent.com/pic=w500-h300"),
        "https://lh3.googleusercontent.com/pic=s0"
    );
});

// ---------------------------------------------------------------- P1-071
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

// ---------------------------------------------------------------- P1-072
test('P1-072a: findDocContentById 不命中正文里仅"提到" ID 的节点', () => {
    const decoy = ["note", "本文引用了 doc99999 的观点\n\n" + "y".repeat(250)];
    const real = ["c_doc99999", "## 真实文档正文\n\n" + "正文".repeat(150)];
    const found = attachments.findDocContentById([decoy, real], "c_doc99999");
    assert.strictEqual(found, real, '应返回精确匹配的节点而非提及 ID 的 decoy');
});

test('P1-072b: findDocContentById 无匹配时返回 null', () => {
    assert.strictEqual(attachments.findDocContentById([["a", "b"]], "c_nope123456"), null);
});

// ---------------------------------------------------------------- P1-073
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

// ---------------------------------------------------------------- P1-074
test('P1-074a: 无时间戳的会话返回 null 而非伪造 Date.now()', () => {
    const res = parseListMod.parseList(makeListRpc([["c_nots1234567890", "NoTime"]]));
    const c = res.conversations[0];
    assert.strictEqual(c.createdAt, null);
    assert.strictEqual(c.updatedAt, null);
    assert.strictEqual(c.chatTime, null);
    assert.strictEqual(c.timestamp, null);
});

test('P1-074b: 有真实时间戳的会话仍正确解析', () => {
    const res = parseListMod.parseList(makeListRpc([["c_hasts1234567890", "HasTime", null, null, null, [1700000000, 0]]]));
    const c = res.conversations[0];
    assert.strictEqual(c.createdAt, 1700000000000);
    assert.strictEqual(c.updatedAt, 1700000000000);
});
