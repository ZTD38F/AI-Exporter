/**
 * Phase C 规格测试 —— 解析可观测 (P1-8 / P1-9)
 * red-by-design: 修复前失败、修复后通过。
 *
 * 运行：node -r ./tests/ts_register.js --test tests/parse_observability.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const parseDetailMod = require('../src/core/api/parser/parseDetail.js');
const attachments = require('../src/core/api/parser/attachments.js');
const pagination = require('../src/core/api/client/pagination.js');
const parseDrift = require('../src/core/engine/export/parseDrift.js');

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
function modelMessageOf(res: any): any {
    return res.messages.find((m: any) => m.role === "model");
}

// ---------------------------------------------------------------- P1-8: turnsRejected + schemaDrift
test('P1-8a: 漂移夹具产出 turnsRejected=1 且 schemaDrift 非空', () => {
    const junk = [["x_123"], [1, 0], [["u"]]]; // isTurn 拒绝
    const oddTurn = makeTurn({ userPayload: "非数组形态的 user payload", convId: "c_odd000000000001" });
    const res = parseDetailMod.parseDetail(makeDetailRpc([[makeTurn(), oddTurn, junk]]));
    assert.strictEqual(res.turnsRejected, 1, 'junk 元素应被计数为拒识');
    assert.ok(Array.isArray(res.schemaDrift) && res.schemaDrift.length > 0, 'schemaDrift 应非空');
});

test('P1-8b: 正常 payload 无拒识、无漂移', () => {
    const res = parseDetailMod.parseDetail(makeDetailRpc([[makeTurn(), makeTurn({ convId: "c_abc123def457" })]]));
    assert.strictEqual(res.turnsRejected || 0, 0, '正常 turn 不应被拒识');
    assert.ok(!res.schemaDrift || res.schemaDrift.length === 0, '正常 payload 不应有 schemaDrift');
});

test('P1-8c: extractChatParseDrift 抽取诊断，turnsRejected>0 判 partial', () => {
    const junk = [["x_123"], [1, 0], [["u"]]];
    const res = parseDetailMod.parseDetail(makeDetailRpc([[makeTurn(), junk]]));
    const drift = parseDrift.extractChatParseDrift(res);
    assert.strictEqual(drift.turnsRejected, 1);
    assert.ok(drift.schemaDrift.length >= 0);
    assert.strictEqual(drift.hasHeuristicDocs, false);
    assert.strictEqual(parseDrift.chatRecordStatusWithDrift('ok', drift), 'partial', 'turnsRejected>0 必须标 partial，不能是 ok');
});

test('P1-8d: 无漂移时状态保持 ok；heuristic 文档也判 partial', () => {
    const clean = { schemaDrift: [], turnsRejected: 0, hasHeuristicDocs: false };
    assert.strictEqual(parseDrift.chatRecordStatusWithDrift('ok', clean), 'ok');
    const heur = { schemaDrift: [], turnsRejected: 0, hasHeuristicDocs: true };
    assert.strictEqual(parseDrift.chatRecordStatusWithDrift('ok', heur), 'partial', 'heuristic 文档链必须标 partial');
});

test('P1-8e: pagination 跨页合并 turnsRejected 与 schemaDrift（去重）', async () => {
    const pages: any[] = [
        { id: "c_x", messages: [{ id: "m1" }], schemaDrift: ["drift-a"], turnsRejected: 1, nextPageToken: "t2" },
        { id: "c_x", messages: [{ id: "m2" }], schemaDrift: ["drift-b", "drift-a"], turnsRejected: 2, nextPageToken: null }
    ];
    let calls = 0;
    const client = { fetchConversationPage: async () => pages[calls++] };
    const res = await pagination.getConversationDetail(client, "c_x");
    assert.strictEqual(res.turnsRejected, 3, 'turnsRejected 应跨页累加');
    assert.deepStrictEqual([...res.schemaDrift].sort(), ["drift-a", "drift-b"], 'schemaDrift 应跨页合并去重');
});

// ---------------------------------------------------------------- P1-9: 文档元数据来源标记
const UUID = "123e4567-e89b-12d3-a456-426614174099";
function strictDocItem(title = "Adequate Strict Title Here"): unknown[] {
    // DEEP_RESEARCH_DOC: [CHIP_URL:0, ?:1, ID:2, TITLE:3, CONTENT_ID:4, TIMESTAMP:5]
    return [["https://x/immersive_entry_chip/abc"], "filler", UUID, title];
}
function flatDocItem(title = "Adequate Flat Title Here"): unknown[] {
    // 非严格形态：item[0] 不是数组，长度 < 4
    return ["https://y/immersive_entry_chip/def", UUID, title];
}

test('P1-9a: 严格路径命中的文档不标 heuristic', () => {
    const out = attachments.extractDocumentsMeta([strictDocItem()]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].source, undefined, '严格路径不应带 source 标记');
});

test('P1-9b: flat 兜底仅在严格路径产出为 0 时执行', () => {
    const out = attachments.extractDocumentsMeta([strictDocItem(), flatDocItem()]);
    assert.strictEqual(out.length, 1, '已有严格结果时 flat 兜底不应再产出');
    assert.strictEqual(out[0].source, undefined);
});

test('P1-9c: 纯 flat 形态产出标记 source=heuristic-flat', () => {
    const out = attachments.extractDocumentsMeta([flatDocItem()]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].source, 'heuristic-flat');
});

test('P1-9d: flat 标题至少 8 字符（短标题丢弃）', () => {
    const shortTitle = attachments.extractDocumentsMeta([["https://y/immersive_entry_chip/def", UUID, "shorty"]]);
    assert.strictEqual(shortTitle.length, 0, '6 字符标题不应被 flat 兜底采纳');
    const longTitle = attachments.extractDocumentsMeta([["https://y/immersive_entry_chip/def", UUID, "long enough title here"]]);
    assert.strictEqual(longTitle.length, 1);
    assert.strictEqual(longTitle[0].title, "long enough title here");
});

test('P1-9e: flat.length > 500 直接跳过', () => {
    const big: string[] = ["https://y/immersive_entry_chip/def", UUID, "Adequate Flat Title Here"];
    while (big.length <= 500) big.push("padding-" + big.length);
    const out = attachments.extractDocumentsMeta([big]);
    assert.strictEqual(out.length, 0, '超大 flat 数组应被跳过');
});

test('P1-9f: findDocContentById 全等路径不标 contentMatch', () => {
    const real = ["docExact1", "## 真实标题\n\n" + "正文".repeat(100)];
    const found: any = attachments.findDocContentById([real], "docExact1");
    assert.strictEqual(found, real);
    assert.strictEqual(found.contentMatch, undefined, '全等路径不应标记');
});

test('P1-9g: findDocContentById includes 长元素（>=80）不再命中', () => {
    const elem = "n".repeat(40) + "docLong1" + "m".repeat(40); // 88 字符，确实包含 docId
    assert.strictEqual(elem.length, 88);
    assert.ok(elem.includes("docLong1"));
    const found = attachments.findDocContentById([[elem]], "docLong1");
    assert.strictEqual(found, null, '>=80 字符的 includes 元素不应命中');
});

test('P1-9h: findDocContentById includes 短元素命中并标 substring', () => {
    const node = ["ab_docShort1_cd", "## 短文档标题\n\n" + "正文".repeat(100)];
    const found: any = attachments.findDocContentById([node], "docShort1");
    assert.strictEqual(found, node);
    assert.strictEqual(found.contentMatch, 'substring');
});

test('P1-9i: parseDocSections 透传上游 contentMatch 标记', () => {
    const arr: any = [["Section Title", "https://example.com/doc"]];
    arr.contentMatch = 'substring';
    const res = attachments.parseDocSections(arr);
    assert.strictEqual(res.contentMatch, 'substring', '应透传上游标记');
    const clean = attachments.parseDocSections([["Section Title", "https://example.com/doc"]]);
    assert.strictEqual(clean.contentMatch, undefined);
});

test('P1-9j: heuristic 链的文档最终标 hasFabricatedText=true', () => {
    const docId = UUID;
    const flatItem = ["https://y/immersive_entry_chip/e2e", docId, "End To End Heuristic Title"];
    const clueText = "## Doc Body\n\n" + "正文".repeat(100); // >200 字符，供 findDocMarkdownByClues
    assert.ok(clueText.length > 200);
    const turn = makeTurn({ extraCand: [[flatItem], clueText] });
    const res = parseDetailMod.parseDetail(makeDetailRpc([[turn]]));
    const model = modelMessageOf(res);
    assert.ok(model && model.documents && model.documents.length > 0, '应产出 documents');
    const doc = model.documents[0];
    assert.strictEqual(doc.hasFabricatedText, true, 'heuristic 链文档必须标 hasFabricatedText');
});

test('parseDetail: strips immersive_entry_chip from document contentMarkdown and extracts heading title', () => {
    const docId = UUID;
    const flatItem = ["https://y/immersive_entry_chip/0", docId, "Document"];
    const rawDocText = "http://googleusercontent.com/immersive_entry_chip/0\n# 虚构城市水力建模分析\n\n" + "正文详细内容".repeat(20);
    const docContent = [docId, [[rawDocText]]];
    const turn = makeTurn({ extraCand: [[flatItem], docContent] });
    const res = parseDetailMod.parseDetail(makeDetailRpc([[turn]]));
    const model = modelMessageOf(res);
    assert.ok(model && model.documents && model.documents.length > 0, '应产出 documents');
    const doc = model.documents[0];
    assert.strictEqual(doc.contentMarkdown.includes('immersive_entry_chip'), false, 'contentMarkdown 不应残留 internal chip url');
    assert.strictEqual(doc.title, '虚构城市水力建模分析', 'title 应提取 markdown 首行标题，而非 Document');
});

test('parseDetail: ignores document when contentMarkdown contains only chip URL', () => {
    const docId = UUID;
    const flatItem = ["https://y/immersive_entry_chip/0", docId, "Document"];
    const rawDocText = "http://googleusercontent.com/immersive_entry_chip/0\n";
    const docContent = [docId, [[rawDocText]]];
    const turn = makeTurn({ extraCand: [[flatItem], docContent] });
    const res = parseDetailMod.parseDetail(makeDetailRpc([[turn]]));
    const model = modelMessageOf(res);
    assert.ok(!model || !model.documents || model.documents.length === 0, '仅包含 chip 的空文档不应产出');
});


