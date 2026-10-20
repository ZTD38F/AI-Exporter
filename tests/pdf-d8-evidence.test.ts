/**
 * tests/pdf-d8-evidence.test.ts
 *
 * D8 真编译证据套件 (Tier 1): six claims about the PDF pipeline, each proven
 * through the REAL, unmodified TypstSandboxCompiler driven by the
 * real-WASM test frame (tests/helpers/realWasmSandbox.ts):
 *
 *  D8-1  0 外部请求: full init + font install + compile inside withNetworkGate
 *  D8-2  selectable math: real convertMath -> PDF text extraction finds the
 *        formula as selectable text; zero image XObjects (no formula-as-image)
 *  D8-3  CJK: long Chinese session -> extracted text covers the input CJK
 *        characters, zero tofu (constructor fontPaths injection only; the
 *        production Local Font Access path is covered by
 *        tests/pdf-local-font-wiring.test.ts test D)
 *  D8-4  50 MiB metadata-only 附件: claimed 50 MiB file attachment compiles;
 *        the asset resolver spy records zero resolve calls (no read, no
 *        hash); the PDF carries the file card (name + "50.0 MB")
 *  D8-5  多会话压力: 20 sequential compiles on one reused frame; timing +
 *        Node heap peak reported, zero failures
 *  D8-6  dispose/leak 回归 (#594): repeated create -> compile -> dispose
 *        cycles leave frame/listener counters flat
 *
 * Text extraction uses the minimal self-contained tests/helpers/pdfTextExtract.ts
 * (subset fonts + ToUnicode CMaps, the exact shape Typst emits).
 */

export {};
const test = require('node:test');
const assert = require('node:assert');

const { TypstSandboxCompiler } = require('../src/core/export/typst/typstSandboxCompiler.js');
const { toTypstPayload } = require('../src/core/export/typst/payload.js');
const { convertMath: convertLatex } = require('../src/core/export/typst/mathConverter.js');
const convertMath = (source: string, display: boolean) => convertLatex(source, 'latex', display);
const { withNetworkGate, assertZeroExternalRequests } = require('./helpers/compileNetworkGate.js');
const { extractPdfText } = require('./helpers/pdfTextExtract.js');
const {
    RealWasmSandboxHost,
    repoRoot,
    resolveLocalCjkFont,
} = require('./helpers/realWasmSandbox.js');

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

let blockSeq = 0;
const bid = () => `b${(blockSeq += 1)}`;

function para(text: string) {
    return { id: bid(), type: 'paragraph', children: [{ type: 'text', text }] };
}

function mathBlock(source: string) {
    return { id: bid(), type: 'math', source };
}

function msg(id: string, role: 'user' | 'assistant', blocks: unknown[], extra: Record<string, unknown> = {}) {
    return { id, role, blocks, ...extra };
}

function makeBundle(
    messages: unknown[],
    opts: { title?: string; conversationId?: string; assets?: unknown[] } = {},
) {
    return {
        schemaVersion: 1,
        conversation: {
            key: { providerId: 'gemini', conversationId: opts.conversationId ?? 'd8-evidence' },
            title: opts.title ?? 'D8 evidence',
            createdAt: '2026-09-26T00:00:00Z',
            updatedAt: '2026-09-26T00:10:00Z',
            messages,
        },
        assets: opts.assets ?? [],
        citations: [],
    };
}

function makeContext(overrides: { assets?: Record<string, Uint8Array>; bundle?: unknown } = {}) {
    const store: Record<string, Uint8Array> = overrides.assets ?? {};
    const calls: string[] = [];
    return {
        context: {
            bundle: overrides.bundle ?? null,
            assets: {
                resolve: async (id: string) => {
                    calls.push(id);
                    const bytes = store[id];
                    return bytes ? { bytes } : null;
                },
            },
            locale: 'zh' as const,
            signal: new AbortController().signal,
            reportProgress: () => undefined,
        },
        calls,
    };
}

/** Build the converged compiler contract payload: prebuilt document + asset paths. */
function compilerPayload(
    bundle: unknown,
    convertMathFn?: (source: string, display: boolean) => string | undefined,
) {
    const assetPath = (a: any) => `/assets/${a.id}`;
    const { payload: document } = toTypstPayload(bundle as any, {
        assetPath,
        ...(convertMathFn ? { convertMath: convertMathFn } : {}),
    });
    return {
        rendererSchemaVersion: 1,
        sourceSchemaVersion: 1,
        bundle,
        document,
        assetPaths: new Map((((bundle as any).assets ?? []) as any[]).map((a: any) => [a.id, assetPath(a)])),
    };
}

interface CompiledEvidence {
    pdfBytes: Uint8Array;
    diagnostics: Array<{ severity: string; code?: string; message: string }>;
    ms: number;
}

/** Build a compiler + host, compile one bundle, dispose, return evidence. */
async function compileOnce(
    bundle: unknown,
    opts: {
        fontPaths?: string[];
        assets?: Record<string, Uint8Array>;
        convertMathFn?: (source: string, display: boolean) => string | undefined;
    } = {},
): Promise<CompiledEvidence & { host: import('./helpers/realWasmSandbox.js').RealWasmSandboxHost }> {
    const host = new RealWasmSandboxHost(repoRoot());
    const compiler = new TypstSandboxCompiler({
        host,
        ...(opts.fontPaths ? { fontPaths: opts.fontPaths } : {}),
    });
    const { context } = makeContext({ assets: opts.assets, bundle });
    const t0 = Date.now();
    try {
        const result = await compiler.compile(
            compilerPayload(bundle, opts.convertMathFn ?? convertMath) as never,
            context as never,
        );
        return { pdfBytes: result.pdfBytes, diagnostics: result.diagnostics, ms: Date.now() - t0, host };
    } finally {
        compiler.dispose();
    }
}

function assertPdfMagic(pdfBytes: Uint8Array): void {
    assert.strictEqual(Buffer.from(pdfBytes.slice(0, 5)).toString('latin1'), '%PDF-');
}

// ---------------------------------------------------------------------------
// D8-1: 0 外部请求
// ---------------------------------------------------------------------------

test('D8-1: full WASM init + font install + compile makes 0 external requests', async () => {
    const bundle = makeBundle([
        msg('m1', 'user', [para('离线编译测试：请确认没有任何外部网络请求。')]),
        msg('m2', 'assistant', [para('本段由真实 Typst WASM 在完全离线状态下编译。')]),
    ]);
    const gated = await withNetworkGate(async () => {
        const host = new RealWasmSandboxHost(repoRoot());
        const compiler = new TypstSandboxCompiler({ host });
        const { context } = makeContext({ bundle });
        try {
            return await compiler.compile(
                compilerPayload(bundle, convertMath) as never,
                context as never,
            );
        } finally {
            compiler.dispose();
        }
    });
    assertZeroExternalRequests(gated, 'd8-1-typst-wasm-compile');
    assertPdfMagic(gated.result.pdfBytes);
});

// ---------------------------------------------------------------------------
// D8-2: selectable math (real convertMath, no formula-as-image)
// ---------------------------------------------------------------------------

test('D8-2: formulas compile to selectable text, not images', async () => {
    const bundle = makeBundle(
        [
            msg('m1', 'user', [para('Please show the mass-energy equivalence and the Pythagorean theorem.')]),
            msg('m2', 'assistant', [
                para('The mass-energy equivalence in inline form E=mc^2 is shown below.'),
                mathBlock('E=mc^2'),
                mathBlock('a^2 + b^2 = c^2'),
                para('These formulas must be selectable and copyable, never images.'),
            ]),
        ],
        { title: 'math selectability' },
    );
    const { pdfBytes, diagnostics } = await compileOnce(bundle);
    assertPdfMagic(pdfBytes);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    assert.deepStrictEqual(errors, [], `compile errors: ${JSON.stringify(errors)}`);

    const extracted = extractPdfText(pdfBytes);
    // The pipeline's red line: formulas must never degrade to images.
    assert.strictEqual(
        extracted.imageXObjectCount, 0,
        'no image XObjects: formulas are vector text, not rasterized images',
    );
    // Selectable math: Typst sets variables in mathematical alphanumeric
    // symbols (NewCMMath), which extract as real Unicode text, e.g.
    // E=mc^2 -> "𝐸=𝑚𝑐2", a^2+b^2=c^2 -> "𝑎2+𝑏2=𝑐2".
    for (const needle of ['𝐸', '𝑚', '𝑐', '𝑎', '𝑏', '=', '2']) {
        assert.ok(extracted.text.includes(needle), `extracted text contains ${JSON.stringify(needle)}`);
    }
    assert.ok(!extracted.text.includes('�'), 'no tofu in math runs');
    // Surrounding prose extracts intact alongside the math.
    assert.ok(extracted.text.includes('mass-energy'), 'prose survives alongside math');
});

// ---------------------------------------------------------------------------
// D8-3: CJK 文本提取 / 无 tofu
// ---------------------------------------------------------------------------

test('D8-3: long Chinese session extracts with full CJK coverage, zero tofu', async (t: { skip: (msg?: string) => void }) => {
    const cjkFont = resolveLocalCjkFont();
    if (!cjkFont) {
        t.skip('no locally installed CJK font on this machine; production serves CJK via the Local Font Access API (user device fonts), which has no Tier-1 equivalent here');
        return;
    }
    const sentences = [
        '天地玄黄，宇宙洪荒。日月盈昃，辰宿列张。',
        '人工智能正在改变软件开发的方式，代码生成只是起点。',
        '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。',
        '量子计算与经典计算的本质区别在于叠加态与纠缠。',
        '床前明月光，疑是地上霜。举头望明月，低头思故乡。',
    ];
    const messages: unknown[] = [];
    for (let i = 0; i < 30; i += 1) {
        messages.push(
            msg(`u${i}`, 'user', [para(`第${i + 1}问：${sentences[i % sentences.length]}`)]),
            msg(`a${i}`, 'assistant', [
                para(`第${i + 1}答：${sentences[(i + 2) % sentences.length]}`),
                mathBlock('x^2 + y^2 = r^2'),
            ]),
        );
    }
    const bundle = makeBundle(messages, { title: '中文长会话提取测试', conversationId: 'd8-cjk' });
    const fontPaths = ['src/ui/sandbox/fonts/NewCMMath-Regular.otf', cjkFont];
    const { pdfBytes, diagnostics } = await compileOnce(bundle, { fontPaths });
    assertPdfMagic(pdfBytes);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    assert.deepStrictEqual(errors, [], `compile errors: ${JSON.stringify(errors)}`);

    const extracted = extractPdfText(pdfBytes);
    assert.ok(!extracted.text.includes('�'), 'zero tofu (U+FFFD) in extracted text');

    // Character coverage: every distinct CJK char in the input must extract.
    const cjkRe = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
    const inputChars = new Set<string>();
    for (const s of sentences) {
        for (const m of s.matchAll(cjkRe)) inputChars.add(m[0]);
    }
    const missing = [...inputChars].filter((ch) => !extracted.text.includes(ch));
    const coverage = (inputChars.size - missing.length) / inputChars.size;
    console.log(
        `  D8-3: ${inputChars.size} distinct CJK chars in input, ` +
        `${inputChars.size - missing.length} extracted (coverage ${(coverage * 100).toFixed(1)}%)` +
        (missing.length ? `, missing: ${missing.slice(0, 10).join('')}` : ''),
    );
    assert.ok(missing.length === 0, `all input CJK chars extractable; missing: ${missing.slice(0, 20).join('')}`);
});

// ---------------------------------------------------------------------------
// D8-4: 50 MiB metadata-only 附件
// ---------------------------------------------------------------------------

test('D8-4: 50 MiB file attachment stays metadata-only (no read, no hash, no OOM)', async () => {
    const FIFTY_MIB = 50 * 1024 * 1024;
    // The asset claims 50 MiB but carries no bytes: status 'notFetched' is
    // honest -- bytes were never fetched. Nothing here allocates 50 MiB.
    const bigFile = {
        id: 'big-file',
        kind: 'file',
        name: 'dataset.zip',
        mimeType: 'application/zip',
        sizeBytes: FIFTY_MIB,
        status: 'notFetched',
    };
    const bundle = makeBundle(
        [
            msg('m1', 'user', [
                para('请看附件里的 50MB 数据集。'),
                { type: 'file', assetId: 'big-file', label: 'dataset.zip' },
            ]),
            msg('m2', 'assistant', [para('已收到附件信息，文件卡片如下。')]),
        ],
        { title: '大附件元数据测试', conversationId: 'd8-50mib', assets: [bigFile] },
    );
    const heapBefore = process.memoryUsage().heapUsed;
    const cjkFont = resolveLocalCjkFont();
    const host = new RealWasmSandboxHost(repoRoot());
    const compiler = new TypstSandboxCompiler({
        host,
        ...(cjkFont ? { fontPaths: [cjkFont] } : {}),
    });
    const { context, calls } = makeContext({ bundle });
    let result: { pdfBytes: Uint8Array; diagnostics: Array<{ severity: string; message: string }> };
    try {
        result = await compiler.compile(
            compilerPayload(bundle, convertMath) as never,
            context as never,
        );
    } finally {
        compiler.dispose();
    }
    const heapAfter = process.memoryUsage().heapUsed;
    assertPdfMagic(result!.pdfBytes);

    // No read: the resolver spy saw zero calls -- the 50 MiB was never
    // opened, never hashed, never mounted as a binary shadow.
    assert.deepStrictEqual(calls, [], 'asset resolver never called for the metadata-only attachment');

    // The file card still renders from metadata alone.
    const extracted = extractPdfText(result!.pdfBytes);
    assert.ok(extracted.text.includes('dataset.zip'), 'PDF carries the attachment file card (name)');
    assert.ok(extracted.text.includes('50.0 MB'), 'PDF carries the attachment size (50.0 MB)');

    console.log(
        `  D8-4: heap delta ${(heapAfter - heapBefore) / 1024 / 1024} MiB ` +
        `(no 50 MiB buffer ever allocated), resolve calls: ${calls.length}`,
    );
});

// ---------------------------------------------------------------------------
// D8-5: 多会话压力
// ---------------------------------------------------------------------------

test('D8-5: 20 sequential compiles on one reused frame: timing + heap', async () => {
    const host = new RealWasmSandboxHost(repoRoot());
    const compiler = new TypstSandboxCompiler({ host });
    const heapStart = process.memoryUsage().heapUsed;
    let heapPeak = heapStart;
    const times: number[] = [];
    let failures = 0;
    try {
        for (let i = 0; i < 20; i += 1) {
            const bundle = makeBundle(
                [
                    msg(`u${i}`, 'user', [para(`压力会话 ${i + 1}：混合内容测试，中文与 English mixed。`)]),
                    msg(`a${i}`, 'assistant', [
                        para(`回复 ${i + 1}：包含公式与列表。`),
                        mathBlock('\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}'),
                        {
                            id: bid(), type: 'list', ordered: false,
                            items: [
                                { blocks: [para(`要点一：会话 ${i + 1}`)] },
                                { blocks: [para('要点二：separate check')] },
                            ],
                        },
                    ]),
                ],
                { title: `压力会话 ${i + 1}`, conversationId: `d8-stress-${i}` },
            );
            const { context } = makeContext({ bundle });
            const t0 = Date.now();
            try {
                const r = await compiler.compile(
                    compilerPayload(bundle, convertMath) as never,
                    context as never,
                );
                assertPdfMagic(r.pdfBytes);
                times.push(Date.now() - t0);
            } catch {
                failures += 1;
            }
            const heap = process.memoryUsage().heapUsed;
            if (heap > heapPeak) heapPeak = heap;
        }
    } finally {
        compiler.dispose();
    }
    const heapEnd = process.memoryUsage().heapUsed;
    assert.strictEqual(failures, 0, 'zero compile failures across 20 sessions');
    // One frame for all 20 compiles, like production frame reuse.
    assert.strictEqual(host.stats.framesCreated, 1, 'single sandbox frame reused');
    const sorted = [...times].sort((a, b) => a - b);
    console.log(
        `  D8-5: 20 compiles, failures=${failures}, ` +
        `min=${sorted[0]}ms p50=${sorted[10]}ms p95=${sorted[18]}ms max=${sorted[19]}ms, ` +
        `heap start=${(heapStart / 1024 / 1024).toFixed(1)}MiB ` +
        `peak=${(heapPeak / 1024 / 1024).toFixed(1)}MiB ` +
        `end=${(heapEnd / 1024 / 1024).toFixed(1)}MiB`,
    );
});

// ---------------------------------------------------------------------------
// D8-6: 连续导出 dispose / leak 回归 (#594)
// ---------------------------------------------------------------------------

test('D8-6: repeated create -> compile -> dispose leaves no frame/listener growth', async () => {
    const CYCLES = 5;
    const host = new RealWasmSandboxHost(repoRoot());
    for (let i = 0; i < CYCLES; i += 1) {
        const compiler = new TypstSandboxCompiler({ host });
        const bundle = makeBundle(
            [msg('m1', 'user', [para(`第 ${i + 1} 次导出`)])],
            { conversationId: `d8-dispose-${i}` },
        );
        const { context } = makeContext({ bundle });
        const result = await compiler.compile(
            compilerPayload(bundle, convertMath) as never,
            context as never,
        );
        assertPdfMagic(result.pdfBytes);
        compiler.dispose();
        // dispose() is idempotent (#594): a second call must not throw.
        compiler.dispose();
    }
    assert.strictEqual(host.stats.framesCreated, CYCLES, 'one frame per cycle');
    assert.strictEqual(host.stats.framesDestroyed, CYCLES, 'every frame destroyed');
    assert.strictEqual(
        host.stats.listenersAttached, host.stats.listenersDetached,
        `listeners attached (${host.stats.listenersAttached}) == detached (${host.stats.listenersDetached})`,
    );
    console.log(`  D8-6: ${CYCLES} cycles, stats=${JSON.stringify(host.stats)}`);
});

// ---------------------------------------------------------------------------
// extractor self-check (guards the test helper itself)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// extractor unit tests (guard the test helper itself)
// ---------------------------------------------------------------------------

test('pdfTextExtract: literal strings with raw balanced parens (Typst CID bytes)', () => {
    // Typst emits 2-byte CID bytes 0x28/0x29 as RAW '(' / ')' inside literal
    // strings (balanced, legal per PDF 7.3.4.2). A flat regex tokenizer
    // fragments such strings; the scanner must depth-count.
    // CIDs here are octal: \027(oct)=0x17->春, raw ( =0x28->眠, raw )=0x29->不.
    const cmap = `1 0 obj
<< /Length 10 >>
stream
1 begincodespacerange <0000> <FFFF> endcodespacerange
4 beginbfchar
<0013> <95EE>
<0017> <6625>
<0028> <7720>
<0029> <4E0D>
endbfchar
endstream
endobj`;
    const contentSrc = 'BT /f0 12 Tf 72 720 Td ' +
        '[(' + '\\000\\023\\000\\027\\000' + '(' + '\\000' + ')' + ')] TJ ET';
    const content = `2 0 obj\n<< /Length ${Buffer.byteLength(contentSrc)} >>\nstream\n${contentSrc}\nendstream\nendobj`;
    const font = '3 0 obj\n<< /Type /Font /Subtype /Type0 /BaseFont /T /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 1 0 R >>\nendobj';
    const cidfont = '4 0 obj\n<< /Type /Font /Subtype /CIDFontType2 /BaseFont /T >>\nendobj';
    const page = '5 0 obj\n<< /Type /Page /Parent 6 0 R /MediaBox [0 0 612 792] /Contents 2 0 R /Resources << /Font << /f0 3 0 R >> >> >>\nendobj';
    const pages = '6 0 obj\n<< /Type /Pages /Kids [5 0 R] /Count 1 >>\nendobj';
    const catalog = '7 0 obj\n<< /Type /Catalog /Pages 6 0 R >>\nendobj';
    let pdf = '%PDF-1.7\n';
    for (const p of [cmap, content, font, cidfont, page, pages, catalog]) pdf += p + '\n';
    pdf += 'trailer\n<< /Size 8 /Root 7 0 R >>\nstartxref\n0\n%%EOF';
    const extracted = extractPdfText(Buffer.from(pdf, 'latin1'));
    // 0x13->问, 0x17->春, 0x28->眠, 0x29->不
    assert.strictEqual(extracted.text, '问春眠不');
});

test('pdfTextExtract: known content round-trips through a real compiled PDF', async () => {
    const bundle = makeBundle(
        [
            msg('m1', 'user', [para('提取器自检：hello world 123')]),
            msg('m2', 'assistant', [mathBlock('x^2 + 1 = 0')]),
        ],
        { title: 'extractor-selfcheck' },
    );
    const { pdfBytes } = await compileOnce(bundle);
    const extracted = extractPdfText(pdfBytes);
    assert.ok(extracted.pageCount >= 1, 'at least one page');
    assert.ok(extracted.text.includes('hello world 123'), 'latin prose extracts');
    assert.ok(extracted.text.includes('x'), 'math symbol extracts as text');
    assert.ok(!extracted.text.includes('�'), 'no tofu without CJK content');
});
test("pdfTextExtract: marked content /ActualText replaces composite glyphs without tofu", () => {
    // Composite glyph pieces (e.g. Typst matrix tall parentheses) have no individual ToUnicode entries,
    // but Typst wraps them in /Span << /ActualText (\() >> BDC ... EMC per ISO 32000.
    const contentSrc = "BT /Span << /ActualText (\\() >> BDC <0099> Tj EMC /Span << /ActualText (\\)) >> BDC <0099> Tj EMC ET";
    const content = `1 0 obj\n<< /Length ${Buffer.byteLength(contentSrc)} >>\nstream\n${contentSrc}\nendstream\nendobj`;
    const page = `2 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Contents 1 0 R >>\nendobj`;
    const pages = `3 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count 1 >>\nendobj`;
    const catalog = `4 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj`;
    let pdf = "%PDF-1.7\n";
    for (const p of [content, page, pages, catalog]) pdf += p + "\n";
    pdf += "trailer\n<< /Size 5 /Root 4 0 R >>\nstartxref\n0\n%%EOF";
    const extracted = extractPdfText(Buffer.from(pdf, "latin1"));
    assert.strictEqual(extracted.text, "()");
    assert.ok(!extracted.text.includes(String.fromCharCode(0xfffd)), "no tofu");
});
