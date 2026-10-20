/**
 * tests/pdf-stress-gates.test.ts
 * Phase F 压力/附件/内存门禁测试（Tier 1）。
 *
 * 背景：P0 正式实验（~/workspace/goals/gemini-exporter/hidden_files/p0-formal/REPORT.md）
 * 测得 121 消息长会话可编译、100 会话最慢 50.6s（含真编译）、300 次编译 0 失败、
 * 无内存泄漏信号。
 *
 * §1–§4 是预处理阶段门禁：normalizeGeminiConversation（F2b）+ toTypstPayload（F2c 前端），
 * 日常 CI 常开。§5（Item 4）是真编译器（Typst WASM sandbox，Phase D）落地后的端到端门禁：
 * 完整链路 PdfExporter → project → resources → payload → real Typst → delivery；
 * release-only——RELEASE_STRESS=1 时跑 100 会话 / 2000 消息全量，日常 CI 只跑 2 会话微型冒烟。
 *
 * 预算依据（实测于 2026-09-26 本机 VM，Node 24）：
 * - 单个 121 消息会话 normalize+payload：~1.1s → 预算 60s（约 55 倍余量）。
 *   P0 预处理阶段为秒级；10 分钟是整链路（含真编译）预算，这里只测预处理。
 * - 100 会话 batch（每会话 8 消息，共 800 消息）：~1.9s → 预算 120s。
 *   P0 的 50.6s 是含 WASM 真编译的 100 会话；此处不含编译，预算按实测数量级放大，
 *   余量主要防 CI 机器抖动。
 * - 内存：50 次循环 heapUsed 增长实测 3 轮分别为 1.0 / 0.0 / 0.1 MB → 断言 < 100MB。
 *   这是"无泄漏信号"门，不是精确泄漏证明（WASM 堆内内存无法从外部归因，见 P0 §3）。
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { normalizeGeminiConversation } = require('../src/core/export/canonical/index.js');
const { toTypstPayload } = require('../src/core/export/typst/payload.js');

// §5 全链路门禁的依赖（真编译器 + 文本提取）。§1–§4 不需要它们。
const { PdfExporter } = require('../src/core/export/pdf/index.js');
const { TypstSandboxCompiler } = require('../src/core/export/typst/typstSandboxCompiler.js');
const {
    RealWasmSandboxHost,
    repoRoot,
    resolveLocalCjkFont,
} = require('./helpers/realWasmSandbox.js');
const { extractPdfText } = require('./helpers/pdfTextExtract.js');

const BASE_TS = 1727000000000;
const TYPST_OPTS = { assetPath: (_a: any) => undefined };

// ---------------------------------------------------------------------------
// 合成器：照抄 P0 s4 样本构成（60 轮 / 121 消息；分页、思考、引用、图片、
// 缺失附件、未知角色），外加任务要求的混合内容：中文、公式、代码块、表格、
// 引用、附件占位。
//
// 注意：块级公式必须独占一行。P0 发现 F1 bug——`$$...$$` 同行后跟文本时整个
// 消息块被静默丢弃（REPORT.md §6）。样本构造主动规避该形状，bug 本体留给仓库修。
// ---------------------------------------------------------------------------

function mdFor(i: number, role: string): string {
    const parts: string[] = [];
    parts.push(`# 第 ${i} 轮讨论\n`);
    parts.push(`这是第 ${i} 个消息的中文正文，用于压力测试的混合内容。`);
    parts.push(`行内公式：$E=mc^2$ 与 $\\alpha + \\beta_{${i}}$，以及 $\\frac{x}{y}$。`);
    parts.push('');
    parts.push('$$');
    parts.push(`\\sum_{k=1}^{${i}} k^2 = \\frac{${i}(${i}+1)}{2}`);
    parts.push('$$');
    parts.push('');
    parts.push('```python');
    parts.push(`def fib_${i}(n):`);
    parts.push('    a, b = 0, 1');
    parts.push(`    return n * ${i}`);
    parts.push('```');
    parts.push('');
    parts.push('| 列 A | 列 B | 列 C |');
    parts.push('|:-----|-----:|:----:|');
    parts.push(`| a${i} | ${i * 2} | x |`);
    parts.push(`| b${i} | ${i * 3} | y |`);
    parts.push('');
    parts.push(`> 引用块 ${i}：关键结论见 [1]`);
    parts.push('>');
    parts.push(`> 第二行引用，另见 [2]`);
    if (role === 'model') {
        parts.push('');
        parts.push(`回答：结论如上，另附公式 $\\sqrt{${i}}$ 供参考。`);
    }
    return parts.join('\n');
}

function attachmentFor(i: number, kind: 'image' | 'pdf' | 'missing'): any {
    if (kind === 'image') {
        return {
            type: 'image', name: `img-${i}.png`, localName: `assets/img-${i}.png`,
            mimeType: 'image/png', size: 12345 + i, width: 800, height: 600,
        };
    }
    if (kind === 'pdf') {
        return {
            type: 'file', name: `doc-${i}.pdf`, localName: `assets/doc-${i}.pdf`,
            mimeType: 'application/pdf', size: 99999 + i * 7,
        };
    }
    // 缺失附件：只有名称，没有本地路径（s4 构成）
    return { type: 'file', name: `missing-${i}.zip`, mimeType: 'application/zip', size: 424242 };
}

function makeStressConversation(): any {
    const messages: any[] = [];
    for (let turn = 0; turn < 60; turn++) {
        const u = turn * 2;
        messages.push({
            id: `m-u${u}`, role: 'user', content: mdFor(u, 'user'),
            timestamp: BASE_TS + u * 1000,
            images: turn % 4 === 0 ? [attachmentFor(u, 'image')] : undefined,
        });
        const a = turn * 2 + 1;
        messages.push({
            id: `m-a${a}`, role: 'model', content: mdFor(a, 'model'),
            timestamp: BASE_TS + a * 1000 + 500,
            thoughts: turn % 3 === 0 ? `思考 ${turn}：需要结构化回答。` : undefined,
            citations: turn % 2 === 0
                ? [{ title: `来源 ${turn}A`, url: 'https://example.com/src-a' },
                   { title: `来源 ${turn}B`, url: 'https://example.com/src-b' }]
                : undefined,
            attachments: turn % 4 === 1 ? [attachmentFor(a, 'pdf')]
                : turn % 4 === 3 ? [attachmentFor(a, 'missing')] : undefined,
        });
    }
    // 第 121 条：未知角色（s4 构成含未知角色）
    messages.push({
        id: 'm-x121', role: 'weird-role', content: '未知角色的尾消息。',
        timestamp: BASE_TS + 999999,
    });
    return {
        id: 'c_stress_121', title: '压力测试长会话', titleSource: 'derived',
        createdAt: BASE_TS, updatedAt: BASE_TS + 200000, source: 'synthetic',
        messages,
    };
}

function makeBatchConversation(n: number): any {
    const messages: any[] = [];
    for (let i = 0; i < 8; i++) {
        messages.push({
            id: `b${n}-m${i}`, role: i % 2 === 0 ? 'user' : 'model',
            content: mdFor(i + n * 8, i % 2 === 0 ? 'user' : 'model'),
            timestamp: BASE_TS + n * 100000 + i * 1000,
            thoughts: i % 4 === 1 ? `batch ${n} 思考` : undefined,
            attachments: i === 3 ? [attachmentFor(i, 'pdf')] : undefined,
        });
    }
    return {
        id: `c_batch_${n}`, title: `batch ${n}`, titleSource: 'derived',
        createdAt: BASE_TS, source: 'synthetic', messages,
    };
}

// ---------------------------------------------------------------------------
// 1. 长会话压力：121 消息 normalize + payload
// 预算 60s 的依据：本机实测 ~1.1s（P0 预处理阶段秒级）；取约 55 倍余量，
// 防 CI 机器慢 + 未来 normalizer 增重。10 分钟是整链路（含真编译）预算，
// 真编译器落地后此处预算要收紧为端到端口径。
// ---------------------------------------------------------------------------

test('stress: 121-message conversation normalizes and converts well under budget', async () => {
    const raw = makeStressConversation();
    assert.strictEqual(raw.messages.length, 121, 'synthetic conversation must have 121 messages');

    const t0 = Date.now();
    const { bundle, diagnostics } = await normalizeGeminiConversation(raw);
    const { payload } = toTypstPayload(bundle, TYPST_OPTS);
    const elapsedMs = Date.now() - t0;

    assert.strictEqual(payload.messageCount, 121, 'payload must carry all 121 messages');
    assert.strictEqual(payload.messages.length, 121);
    assert.ok(
        payload.messages.every((m: any) => Array.isArray(m.blocks) && m.blocks.length > 0),
        'every message must produce at least one render block (guards against vacuous fast pass)',
    );
    assert.ok(
        elapsedMs < 60_000,
        `121-msg normalize+payload took ${elapsedMs}ms, over the 60s budget ` +
        `(measured ~1.1s on dev VM; diagnostics=${diagnostics.length})`,
    );
});

// ---------------------------------------------------------------------------
// 2. 100 会话 batch 压力：总耗时有明确上界
// 预算 120s 的依据：本机实测 100 会话 × 8 消息 = 800 消息共 ~1.9s；
// P0 的 50.6s 是含 WASM 真编译的口径，此处只测预处理。120s ≈ 60 倍余量，
// 留给 CI 机器抖动。真编译器落地后升级为端到端 batch 门。
// ---------------------------------------------------------------------------

test('stress: 100-conversation batch has bounded total preprocessing time', async () => {
    const batch = Array.from({ length: 100 }, (_, n) => makeBatchConversation(n));

    const t0 = Date.now();
    let totalMessages = 0;
    for (const raw of batch) {
        const { bundle } = await normalizeGeminiConversation(raw);
        const { payload } = toTypstPayload(bundle, TYPST_OPTS);
        totalMessages += payload.messageCount;
    }
    const elapsedMs = Date.now() - t0;

    assert.strictEqual(totalMessages, 800, 'batch must process 100 x 8 = 800 messages');
    assert.ok(
        elapsedMs < 120_000,
        `100-conversation batch took ${elapsedMs}ms, over the 120s budget (measured ~1.9s on dev VM)`,
    );
});

// ---------------------------------------------------------------------------
// 3. 内存无泄漏信号：50 次 normalize+payload 循环，heapUsed 增长有界
// 实测（本机，3 轮）：+1.0 / +0.0 / +0.1 MB → 断言 < 100MB。
// 诚实标注：这是"无泄漏信号"门，不是精确泄漏证明——WASM 堆内内存无法从
// 外部单独归因（P0 REPORT.md §3）；且本环境未暴露 gc，断言的是含惰性 GC 的
// 堆增长上界。
// ---------------------------------------------------------------------------

test('memory: repeated normalize+payload shows no leak signal', async () => {
    const raw = makeStressConversation();

    // 预热一次，让 JIT / 惰性初始化稳定
    {
        const { bundle } = await normalizeGeminiConversation(raw);
        toTypstPayload(bundle, TYPST_OPTS);
    }

    const before = process.memoryUsage().heapUsed;
    let lastMessageCount = 0;
    for (let i = 0; i < 50; i++) {
        const { bundle } = await normalizeGeminiConversation(raw);
        const { payload } = toTypstPayload(bundle, TYPST_OPTS);
        lastMessageCount = payload.messageCount;
    }
    const after = process.memoryUsage().heapUsed;
    const growthBytes = after - before;

    assert.strictEqual(lastMessageCount, 121, 'loop must do real work each iteration');
    assert.ok(
        growthBytes < 100 * 1024 * 1024,
        `heap grew ${(growthBytes / 1048576).toFixed(1)}MB over 50 cycles, ` +
        `over the 100MB bound (measured +1.0/+0.0/+0.1MB on dev VM)`,
    );
});

// ---------------------------------------------------------------------------
// 4. 50MiB 附件门：规格测试（占位）
//
// 规格测试——Phase D asset resolver 落地时把本节的本地 helper 换成 import 真模块，
// 下面的断言即为真模块必须满足的契约。
//
// 契约（待 resolver 落地时二选一收紧，此处取交集的最严口径）：
//   a) 单文件上限 50MiB = 52_428_800 字节；恰好 50MiB 通过，50MiB+1 拒绝。
//   b) 会话级去重后总和上限同样 50MiB：按 contentHash 去重，同一内容只计一次。
//   c) 0 字节 / 非法 size → 拒绝并告警。理由：0 字节文件无法携带任何内容进 PDF；
//      若按"可用"放行会产生空引用，违背"缺失资源不能静默消失"铁律；拒绝后走
//      missing-asset 可见路径（列出名称），保持非静默。
// ---------------------------------------------------------------------------

const ATTACHMENT_SIZE_LIMIT_BYTES = 50 * 1024 * 1024; // 52_428_800

interface GateAsset { id: string; sizeBytes: number; contentHash?: string }
interface GateVerdict { accepted: boolean; reason: string }

/** 本地占位：单文件门禁。Phase D 落地时替换为真 resolver 的等价入口。 */
function specGateSingleAsset(sizeBytes: number): GateVerdict {
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
        return { accepted: false, reason: 'zero-or-invalid-size: 0 字节文件无法携带内容，拒绝并告警，走 missing-asset 可见路径' };
    }
    if (sizeBytes > ATTACHMENT_SIZE_LIMIT_BYTES) {
        return { accepted: false, reason: `over-limit: ${sizeBytes} > ${ATTACHMENT_SIZE_LIMIT_BYTES}` };
    }
    return { accepted: true, reason: 'ok' };
}

/** 本地占位：会话级门禁（去重后总和）。Phase D 落地时替换为真 resolver 的等价入口。 */
function specGateAssetSet(assets: GateAsset[]): { accepted: boolean; billedBytes: number; reason: string } {
    const seen = new Map<string, number>();
    for (const a of assets) {
        const v = specGateSingleAsset(a.sizeBytes);
        if (!v.accepted) return { accepted: false, billedBytes: 0, reason: `asset ${a.id}: ${v.reason}` };
        const key = a.contentHash ?? `id:${a.id}`;
        if (!seen.has(key)) seen.set(key, a.sizeBytes);
    }
    const billedBytes = [...seen.values()].reduce((s, n) => s + n, 0);
    if (billedBytes > ATTACHMENT_SIZE_LIMIT_BYTES) {
        return { accepted: false, billedBytes, reason: `deduped total ${billedBytes} > ${ATTACHMENT_SIZE_LIMIT_BYTES}` };
    }
    return { accepted: true, billedBytes, reason: 'ok' };
}

test('attachment gate spec: 50MiB boundary', async () => {
    assert.strictEqual(ATTACHMENT_SIZE_LIMIT_BYTES, 52428800, '50MiB must be exactly 52428800 bytes');
    assert.deepStrictEqual(specGateSingleAsset(52428800).accepted, true, 'exactly 50MiB passes');
    const over = specGateSingleAsset(52428801);
    assert.strictEqual(over.accepted, false, '50MiB+1 is rejected');
    assert.ok(over.reason.includes('over-limit'));
});

test('attachment gate spec: zero and invalid sizes are rejected with a warning', async () => {
    for (const bad of [0, -1, NaN, Infinity]) {
        const v = specGateSingleAsset(bad);
        assert.strictEqual(v.accepted, false, `size ${String(bad)} must be rejected`);
        assert.ok(v.reason.startsWith('zero-or-invalid-size'), `size ${String(bad)} must carry a warning reason`);
    }
});

test('attachment gate spec: duplicate content is billed once (contentHash dedup)', async () => {
    const thirtyMiB = 30 * 1024 * 1024;
    const dup = specGateAssetSet([
        { id: 'a1', sizeBytes: thirtyMiB, contentHash: 'sha256:abc' },
        { id: 'a2', sizeBytes: thirtyMiB, contentHash: 'sha256:abc' },
    ]);
    assert.strictEqual(dup.accepted, true, 'same content twice must not be billed twice');
    assert.strictEqual(dup.billedBytes, thirtyMiB, 'deduped total must count the content once');

    const distinct = specGateAssetSet([
        { id: 'a1', sizeBytes: thirtyMiB, contentHash: 'sha256:abc' },
        { id: 'a2', sizeBytes: thirtyMiB, contentHash: 'sha256:def' },
    ]);
    assert.strictEqual(distinct.accepted, false, 'two distinct 30MiB assets exceed the 50MiB set budget');
});

test('attachment gate spec: set budget boundary at exactly 50MiB', async () => {
    const tenMiB = 10 * 1024 * 1024;
    const fortyMiB = 40 * 1024 * 1024;
    const ok = specGateAssetSet([
        { id: 'a1', sizeBytes: tenMiB, contentHash: 'sha256:1' },
        { id: 'a2', sizeBytes: fortyMiB, contentHash: 'sha256:2' },
    ]);
    assert.strictEqual(ok.accepted, true, 'deduped total of exactly 50MiB passes');
    assert.strictEqual(ok.billedBytes, 52428800);

    const over = specGateAssetSet([
        { id: 'a1', sizeBytes: tenMiB, contentHash: 'sha256:1' },
        { id: 'a2', sizeBytes: fortyMiB + 1, contentHash: 'sha256:2' },
    ]);
    assert.strictEqual(over.accepted, false, 'one byte over the set budget is rejected');
});

// ---------------------------------------------------------------------------
// 5. Item 4 (P0)：100 会话 full-pipeline release stress（含真编译）
//
// 完整链路：PdfExporter → normalize → project → resources → payload →
// real Typst (WASM sandbox) → delivery（in-memory writer 落盘断言）。
//
// release-only：RELEASE_STRESS=1 时跑全量（100 会话 / 2000 消息）；
// 日常 CI（无环境变量）只跑微型冒烟（2 会话 / 40 消息），验证端到端接线
// 不腐化，但不吃掉 CI 时间（约数秒）。
//
// 门（全量口径）：
//   a) 0 crash：exporter.run() 不抛异常；
//   b) 0 blank PDF：每份 PDF 有 %PDF- 魔数、pageCount ≥ 1、可提取文本非空；
//   c) 0 false success：failed 列表为空；每条 exported 记录 status=ok 且
//      1:1 对应一份已写入的非空 PDF（fileName / bytesWritten 对得上）；
//   d) all conversations accounted for：succeeded + failed == N，输入 id
//      在 exported + failed 中恰好出现一次；
//   e) 全量 < 10 分钟。
//
// 字体说明：与 D8-3 同策略——本机有 Noto CJK 时经构造函数注入（constructor
// fontPaths injection only），中文可提取；没有时退回 bundled 字体，中文走
// 已知降级（提取文本只剩 ASCII/公式/代码部分），blank 门依然有效
// （页数 + 非空文本）。生产环境的 Local Font Access 路径由
// tests/pdf-local-font-wiring.test.ts 覆盖。
//
// 内存说明：rough peak 只是 Node 堆采样（onItemExported 回调处）；WASM 堆内
// 内存无法从外部单独归因（P0 REPORT.md §3）。fake writer 为断言而持有全部
// PDF 字节，peak 天然包含约 100 份 PDF 的体量。
// ---------------------------------------------------------------------------

const RELEASE_STRESS = process.env.RELEASE_STRESS === '1';

function makeFullConversation(n: number, msgCount: number): any {
    const messages: any[] = [];
    for (let i = 0; i < msgCount; i++) {
        const role = i % 2 === 0 ? 'user' : 'model';
        const msg: any = {
            id: `s${n}-m${i}`,
            role,
            content: mdFor(i + n * msgCount, role),
            timestamp: BASE_TS + n * 100000 + i * 1000,
        };
        if (role === 'model') {
            if (i % 4 === 1) msg.thoughts = `思考 ${n}-${i}：需要结构化回答。`;
            // 缺失附件：走 resource stage 的 missing-asset 可见路径（P0 s4 同款构成）
            if (i % 4 === 3) msg.attachments = [attachmentFor(i, 'missing')];
            if (i % 3 === 0) {
                msg.citations = [{ title: `来源 ${n}-${i}`, url: 'https://example.com/src' }];
            }
        } else if (i % 5 === 0) {
            msg.images = [attachmentFor(i, 'image')];
        }
        messages.push(msg);
    }
    return {
        id: `c_stress_full_${n}`,
        title: `全链路压力会话 ${n}`,
        titleSource: 'derived',
        createdAt: BASE_TS,
        updatedAt: BASE_TS + msgCount * 1000,
        source: 'synthetic',
        messages,
    };
}

test('stress: full-pipeline release stress with real Typst compile (Item 4)', async () => {
    const N = RELEASE_STRESS ? 100 : 2;
    const MSG_PER_CONV = 20;
    const totalMessages = N * MSG_PER_CONV;
    const conversations = Array.from({ length: N }, (_, n) => makeFullConversation(n, MSG_PER_CONV));
    assert.strictEqual(
        conversations.reduce((s, c) => s + c.messages.length, 0),
        totalMessages,
        'synthetic input must carry the expected message count',
    );

    const cjkFont = resolveLocalCjkFont();
    const fontPaths = cjkFont
        ? ['src/ui/sandbox/fonts/NewCMMath-Regular.otf', cjkFont]
        : undefined;

    const host = new RealWasmSandboxHost(repoRoot());
    const compiler = new TypstSandboxCompiler({ host, ...(fontPaths ? { fontPaths } : {}) });

    // in-memory writer：delivery stage 的落盘断言目标（useZip: false 只走 writeFile）。
    const files: Array<{ name: string; bytes: Uint8Array }> = [];
    const writer = {
        async writeFile(relativePath: string, content: any) {
            const bytes =
                content instanceof Uint8Array ? content : new TextEncoder().encode(String(content));
            files.push({ name: relativePath, bytes });
            return relativePath;
        },
    };

    const exported: Array<{ id: string; record: any }> = [];
    const errorLogs: string[] = [];
    const exporter = new PdfExporter(compiler); // 真编译器（非 stub）

    const heapStart = process.memoryUsage().heapUsed;
    let heapPeak = heapStart;
    const sampleHeap = () => {
        const h = process.memoryUsage().heapUsed;
        if (h > heapPeak) heapPeak = h;
    };

    let crash: unknown = null;
    let result: any = null;
    const t0 = Date.now();
    try {
        result = await exporter.run(
            {
                selected: conversations.map((c) => ({ id: c.id, title: c.title })),
                conversations,
                useZip: false,
                writer,
            },
            {
                onItemExported: (id: string, record: any) => {
                    exported.push({ id, record });
                    sampleHeap();
                },
                onLog: (msg: string, level?: string) => {
                    if (level === 'error') errorLogs.push(msg);
                },
            },
        );
    } catch (e) {
        crash = e;
    } finally {
        // compiler 是外部注入的（PdfExporter 不拥有），这里负责 dispose。
        compiler.dispose();
    }
    const elapsedMs = Date.now() - t0;
    const heapEnd = process.memoryUsage().heapUsed;
    sampleHeap();

    const mib = (b: number) => (b / 1048576).toFixed(1);
    console.log(
        `  Item4 stress: mode=${RELEASE_STRESS ? 'FULL' : 'smoke'}, N=${N}, ` +
        `messages=${totalMessages}, cjkFont=${cjkFont ? 'injected' : 'absent (known degradation)'}, ` +
        `succeeded=${result?.succeeded ?? 'CRASH'}, failed=${result?.failed?.length ?? 'CRASH'}, ` +
        `elapsed=${(elapsedMs / 1000).toFixed(1)}s, ` +
        `heap start=${mib(heapStart)}MiB peak=${mib(heapPeak)}MiB end=${mib(heapEnd)}MiB` +
        (errorLogs.length ? `, errorLogs=${errorLogs.length}` : ''),
    );

    // Gate a) 0 crash
    assert.strictEqual(
        crash, null,
        `exporter.run threw: ${(crash as Error)?.stack ?? String(crash)}`,
    );
    assert.ok(result, 'result must be present when nothing crashed');
    assert.strictEqual(result.aborted, false, 'run must not report aborted');
    assert.strictEqual(result.total, N, 'result.total must equal the input conversation count');

    // Gate d) all conversations accounted for —— 先算账，再谈别的
    const inputIds = new Set(conversations.map((c) => c.id));
    const exportedIds = exported.map((e) => e.id);
    const failedIds = result.failed.map((f: any) => f.id);
    assert.strictEqual(
        result.succeeded + result.failed.length, N,
        'succeeded + failed must equal N',
    );
    assert.strictEqual(
        new Set([...exportedIds, ...failedIds]).size, N,
        'every input id must appear exactly once across exported + failed',
    );
    for (const id of inputIds) {
        assert.ok(
            exportedIds.includes(id) || failedIds.includes(id),
            `conversation ${id} is unaccounted for`,
        );
    }

    // Gate c) 0 false success：failed 必须为空；每条成功记录 1:1 对应真实落盘字节
    assert.deepStrictEqual(
        result.failed.map((f: any) => ({ id: f.id, error: f.error })),
        [],
        `stress gate allows 0 failures; got ${result.failed.length}`,
    );
    assert.strictEqual(exported.length, result.succeeded, 'onItemExported count must match succeeded');
    assert.strictEqual(
        files.length, exported.length,
        'written files must match exported records 1:1 (no orphan file, no missing file)',
    );
    const filesByName = new Map(files.map((f) => [f.name, f.bytes]));
    for (const { id, record } of exported) {
        assert.strictEqual(record.status, 'ok', `record ${id} must be ok`);
        const bytes = filesByName.get(record.fileName);
        if (bytes === undefined) {
            // assert.ok 在此仓库的 @types/node 下不收窄类型，用 throw 保证类型安全；
            // node:test 中 throw 即测试失败，信息同样明确。
            throw new Error(
                `record ${id} points at ${record.fileName} which was never written (false success)`,
            );
        }
        assert.ok(bytes.length > 0, `record ${id}: written PDF is empty (false success)`);
        assert.strictEqual(
            bytes.length, record.bytesWritten,
            `record ${id}: bytesWritten mismatch (false success)`,
        );
        assert.strictEqual(
            Buffer.from(bytes.slice(0, 5)).toString('latin1'), '%PDF-',
            `record ${id}: missing %PDF- magic (false success)`,
        );
    }

    // Gate b) 0 blank PDF：每份 PDF 至少 1 页且可提取文本非空
    const blank: string[] = [];
    for (const f of files) {
        const ex = extractPdfText(f.bytes);
        if (!(ex.pageCount >= 1 && ex.text.trim().length > 0)) blank.push(f.name);
    }
    assert.deepStrictEqual(blank, [], `blank PDFs detected: ${blank.slice(0, 5).join(', ')}`);

    // Gate e) < 10 分钟（全量口径；冒烟天然远小于此）
    assert.ok(
        elapsedMs < 600_000,
        `full-pipeline stress took ${(elapsedMs / 1000).toFixed(1)}s, over the 10-minute budget`,
    );
});
