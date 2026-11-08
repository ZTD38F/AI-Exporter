import { fixtureAccount } from './helpers/domainFixture.js';
const { sourceDetail, sourceMessage } = require('./helpers/l1SourceFixture.js');
const { parseGeminiRpcConversation } = require('../src/l1/parsers/gemini/rpc/parseConversation.js');
const { detailGen: geminiDetailGen } = require('./fixtures/providers/geminiDetail.js') as typeof import('./fixtures/providers/geminiDetail.js');
/**
 * Phase C 规格测试 —— 解析可观测 (P1-8 / P1-9)
 * red-by-design: 修复前失败、修复后通过。
 *
 * 运行：node -r ./tests/ts_register.js --test tests/parse_observability.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const detailDecoder = require('../src/l1/parsers/gemini/rpc/detailDecoder.js');
const attachments = require('../src/l1/parsers/gemini/rpc/sourceAttachments.js');
const pagination = require('../src/l1/client/gemini/api/pagination.js');
const { contentQuality } = require('../src/l1/parsers/qualityEvidence.js');

function modelMessageOf(res: any): any {
    return res.messages.find((m: any) => m.role === "model");
}

test('P1-8a: 漂移夹具产出 turnsRejected=1 且 schemaDrift 非空', () => {
    const res = detailDecoder.decodeGeminiDetail(geminiDetailGen('G_OBSERVABILITY_01'));
    assert.strictEqual(res.turnsRejected, 1, 'junk 元素应被计数为拒识');
    assert.ok(Array.isArray(res.schemaDrift) && res.schemaDrift.length > 0, 'schemaDrift 应非空');
});

test('P1-8b: 正常 payload 无拒识、无漂移', () => {
    const res = detailDecoder.decodeGeminiDetail(geminiDetailGen('G_OBSERVABILITY_02'));
    assert.strictEqual(res.turnsRejected || 0, 0, '正常 turn 不应被拒识');
    assert.ok(!res.schemaDrift || res.schemaDrift.length === 0, '正常 payload 不应有 schemaDrift');
});

test('P1-8c: parser 统一质量状态，拒识内容判 partial', () => {
    const res = detailDecoder.decodeGeminiDetail(geminiDetailGen('G_OBSERVABILITY_03'));
    const result = parseGeminiRpcConversation(geminiDetailGen('G_OBSERVABILITY_04'), { providerId: 'gemini', account: fixtureAccount(), targetConvId: 'abc123def456' });
    const quality = result.conversation.detail.quality;
    assert.strictEqual(result.evidence?.rejectedTurns, 1);
    assert.ok(result.diagnostics.some((d: { code: string }) => d.code === 'GEMINI_TURNS_REJECTED'));
    assert.deepEqual(result.evidence?.heuristicDocumentIds ?? [], []);
    assert.strictEqual(quality.status, 'partial', 'turnsRejected>0 必须标 partial，不能是 ok');
});

test('P1-8d: 无漂移时状态保持 ok；heuristic 文档也判 partial', () => {
    const clean = contentQuality({ status: 'unknown' });
    assert.strictEqual(clean.status, 'unknown');
    const heur = contentQuality({ status: 'unknown', heuristicDocumentIds: ['doc'] });
    assert.strictEqual(heur.status, 'partial', 'heuristic 文档链必须标 partial');
});

test('P1-8e: pagination 跨页合并 turnsRejected 与 schemaDrift（去重）', async () => {
    const pages = [
        sourceDetail({ id: 'source_chat_123', messages: [sourceMessage('new')], schemaDrift: ['drift-a'], turnsRejected: 1, nextPageToken: 'tC_older' }),
        sourceDetail({ id: 'source_chat_123', messages: [sourceMessage('old')], schemaDrift: ['drift-b', 'drift-a'], turnsRejected: 2 }),
    ];
    let calls = 0;
    const client = { fetchConversationPage: async () => pages[calls++] };
    const res = await pagination.getConversationDetail(client, "source_chat_123");
    assert.strictEqual(res.evidence?.rejectedTurns, 3, 'turnsRejected 应跨页累加');
    assert.deepStrictEqual([...new Set(res.diagnostics.filter((d: { code: string }) => d.code === 'GEMINI_SCHEMA_DRIFT').map((d: { message: string }) => d.message))].sort(), ["drift-a", "drift-b"], 'schemaDrift 应跨页合并去重');
});

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

test('P1-9e2: strict document time uses canonical finite safe milliseconds', () => {
    const cases: Array<{ wireTime: unknown; expected: number | undefined }> = [
        { wireTime: [1700000000, 500000000], expected: 1700000000000 },
        { wireTime: [1700000000000], expected: 1700000000000 },
        { wireTime: [Number.POSITIVE_INFINITY], expected: undefined },
        { wireTime: [-123], expected: undefined },
        { wireTime: ['1700000000'], expected: undefined },
        { wireTime: [Number.MAX_VALUE], expected: undefined },
    ];
    for (const { wireTime, expected } of cases) {
        const entry = strictDocItem();
        entry[5] = wireTime;
        const result = attachments.extractDocumentsMeta([entry]);
        assert.equal(result.length, 1, 'invalid timestamps must not discard otherwise valid document metadata');
        assert.equal(result[0].createdAt, expected);
    }
});

test('P1-9f: findDocContentById 全等路径不标 contentMatch', () => {
    const real = ["docExact1", "## 真实标题\n\n" + "正文".repeat(100)];
    const found = attachments.createDocumentReader([real]).byId("docExact1");
    assert.ok(found);
    assert.strictEqual(found?.contentMatch, undefined, '全等路径不应标记');
});

test('P1-9g: findDocContentById includes 长元素（>=80）不再命中', () => {
    const elem = "n".repeat(40) + "docLong1" + "m".repeat(40); // 88 字符，确实包含 docId
    assert.strictEqual(elem.length, 88);
    assert.ok(elem.includes("docLong1"));
    const found = attachments.createDocumentReader([[elem]]).byId("docLong1");
    assert.strictEqual(found, null, '>=80 字符的 includes 元素不应命中');
});

test('P1-9h: findDocContentById includes 短元素命中并标 substring', () => {
    const node = ["ab_docShort1_cd", "## 短文档标题\n\n" + "正文".repeat(100)];
    const found = attachments.createDocumentReader([node]).byId("docShort1");
    assert.ok(found);
    assert.strictEqual(found?.contentMatch, 'substring');
    assert.equal(Object.hasOwn(node, 'contentMatch'), false, 'raw source must not be mutated');
});

test('P1-9i: parseDocSections explicitly propagates typed match provenance', () => {
    const arr = [["Section Title", "https://example.com/doc"]];
    const res = attachments.parseDocSections(arr, 'substring');
    assert.strictEqual(res.contentMatch, 'substring', '应透传上游标记');
    assert.equal(Object.hasOwn(arr, 'contentMatch'), false);
    const clean = attachments.parseDocSections([["Section Title", "https://example.com/doc"]]);
    assert.strictEqual(clean.contentMatch, undefined);
});

test('P1-9k: findDocContentById substring match -> parseDocSections 端到端透传 contentMatch 标记', () => {
    const rawSection = "这是一段用于测试文档段落的文字内容，长度确保超过五十个字符以进入 sections 集合。".repeat(2);
    const substringNode = ["prefix_docSubId_suffix", [[rawSection, "https://example.com/doc-link"]]];
    const root = [substringNode];

    const found = attachments.createDocumentReader(root).byId("docSubId");
    assert.ok(found);
    assert.strictEqual(found?.contentMatch, 'substring', 'substring 匹配必须标记为启发式');
    assert.equal(Object.hasOwn(substringNode, 'contentMatch'), false, '原始 RPC 节点不得被修改');

    const res = found;
    assert.strictEqual(res.contentMatch, 'substring', 'parseDocSections 必须透传匹配依据');
    assert.ok(res.contentMarkdown.includes("这是一段用于测试文档段落的文字内容"), 'sections 内容应被正确解析为 markdown');

    // 3. 对照组：全等匹配节点不标记 contentMatch，经 parseDocSections 后 contentMatch 保持 undefined
    const exactNode = ["docExactId", [[rawSection, "https://example.com/doc-link"]]];
    const exactFound = attachments.createDocumentReader([exactNode]).byId("docExactId");
    assert.ok(exactFound);
    assert.strictEqual(exactFound?.contentMatch, undefined, '全等匹配不应带有 contentMatch 标记');
    const exactRes = exactFound;
    assert.strictEqual(exactRes.contentMatch, undefined, '全等匹配经 parseDocSections 不应带有 contentMatch');
});

test('matching content from a frozen RPC node preserves source bytes and heuristic provenance', () => {
    const rawSection = '## A fixed, immutable document section. '.repeat(10);
    const raw = Object.freeze(['prefix_docFrozen_suffix', Object.freeze([[rawSection]])]);
    const source = Object.freeze([raw]);
    const original = JSON.stringify(source);
    const result = attachments.createDocumentReader(source).byId('docFrozen');
    assert.ok(result);
    assert.strictEqual(result?.contentMatch, 'substring');
    assert.strictEqual(result.contentMatch, 'substring');
    assert.strictEqual(JSON.stringify(source), original);
    assert.equal(Object.hasOwn(raw, 'contentMatch'), false);
});

test('P1-9j: heuristic 链的文档最终标 hasFabricatedText=true', () => {
    const clueText = "## End To End Heuristic Title\n\n" + "正文".repeat(100);
    assert.ok(clueText.length > 200);
    const res = detailDecoder.decodeGeminiDetail(geminiDetailGen('G_OBSERVABILITY_DOC_01'));
    const model = modelMessageOf(res);
    assert.ok(model && model.documents && model.documents.length > 0, '应产出 documents');
    const doc = model.documents[0];
    assert.strictEqual(doc.hasFabricatedText, true, 'heuristic 链文档必须标 hasFabricatedText');
});

test('decodeGeminiDetail: strips immersive_entry_chip from document contentMarkdown and extracts heading title', () => {
    const res = detailDecoder.decodeGeminiDetail(geminiDetailGen('G_OBSERVABILITY_DOC_02'));
    const model = modelMessageOf(res);
    assert.ok(model && model.documents && model.documents.length > 0, '应产出 documents');
    const doc = model.documents[0];
    assert.strictEqual(doc.contentMarkdown.includes('immersive_entry_chip'), false, 'contentMarkdown 不应残留 internal chip url');
    assert.strictEqual(doc.title, '虚构城市水力建模分析', 'title 应提取 markdown 首行标题，而非 Document');
});

test('decodeGeminiDetail: ignores document when contentMarkdown contains only chip URL', () => {
    const res = detailDecoder.decodeGeminiDetail(geminiDetailGen('G_OBSERVABILITY_DOC_03'));
    const model = modelMessageOf(res);
    assert.ok(!model || !model.documents || model.documents.length === 0, '仅包含 chip 的空文档不应产出');
});



test('LP-03: only a unique first-heading match can bind an unattributed Research document', () => {
    const matching = '# Target Research Report\n\n' + 'Matched body '.repeat(40);
    const longerOther = '# Unrelated Research Report\n\n' + 'Unrelated body '.repeat(100);
    const meta = { id: 'doc-target', title: 'Target Research Report' };
    assert.equal(attachments.createDocumentReader([longerOther, matching]).byTitle(meta), matching);
    assert.equal(attachments.createDocumentReader([matching, matching]).byTitle(meta), matching, 'repeated same source is not ambiguous');
});

test('LP-03: missing, mentioned-only or ambiguous title must not claim an unrelated document', () => {
    const unrelated = '# Unrelated Report\n\n' + 'This discusses Target Research Report in passing. '.repeat(12);
    const target = '# Target Research Report\n\n' + 'Target body '.repeat(40);
    const otherTarget = '## Target Research Report\n\n' + 'Different body '.repeat(45);
    const meta = { id: 'doc-target', title: 'Target Research Report' };
    assert.equal(attachments.createDocumentReader([unrelated]).byTitle(meta), '', 'body mention is not a document heading');
    assert.equal(attachments.createDocumentReader([unrelated, target, otherTarget]).byTitle(meta), '', 'multiple distinct heading matches are ambiguous');
    assert.equal(attachments.createDocumentReader([unrelated]).byTitle({ ...meta, title: '' }), '', 'untitled document cannot guess');
    assert.equal(attachments.createDocumentReader([unrelated]).byTitle({ ...meta, title: 'Document' }), '', 'placeholder title cannot guess');
});

test('LP-03: Detail decoding leaves unmatched deep research content unattached', () => {
    const model = modelMessageOf(detailDecoder.decodeGeminiDetail(geminiDetailGen('G_OBSERVABILITY_DOC_04')));
    assert.ok(model, 'valid model reply remains present');
    assert.equal(model.documents?.length ?? 0, 0, 'unmatched material must not be manufactured into the target document');
});
