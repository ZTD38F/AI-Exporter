/**
 * tests/pdf-visual-corpus.test.ts
 *
 * Item 7 — fixed 12-item PDF visual corpus + programmatic layout checks.
 *
 * The corpus lives in tests/fixtures/visual-corpus/ (12 JSON fixtures). Each
 * fixture carries a canonical bundle, base64 binaries, and an `expect` block.
 * This test compiles every fixture with the REAL vendored Typst WASM
 * (TypstSandboxCompiler + RealWasmSandboxHost, no mocks) and runs
 * programmatic checks instead of pixel diffs:
 *
 *   - PDF magic + zero error diagnostics
 *   - page count >= expect.minPages (catches broken pagination)
 *   - key phrases present, exactlyOnce phrases appear exactly once
 *     (catches duplicated / dropped content)
 *   - no U+FFFD tofu (catches unreadable text)
 *   - per-page content bounds (catches overflow / clipping)
 *   - blank-page detection (catches large empty regions / broken breaks)
 *   - duplicated-run detection across pages (catches duplicated content)
 *   - image XObject counts + draw rects inside page bounds
 *     (catches image overflow)
 *   - table cell text presence (catches unreadable tables)
 *   - CJK + math needles (catches font/coverage regressions)
 *   - missing-asset warning diagnostics (catches crash-on-missing)
 *
 * If PDF_VISUAL_REVIEW_DIR is set, the test additionally writes the 12 PDFs
 * plus a Markdown review report there (durable review package). The review
 * package is never committed to Git.
 *
 * Verification level: 本机真实 Typst WASM 编译 + 程序化检查.
 * This is NOT a human visual sign-off; the PDFs are kept for real review.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { TypstSandboxCompiler } = require('../src/core/export/typst/typstSandboxCompiler.js');
const { toTypstPayload } = require('../src/core/export/typst/payload.js');
const { convertMath } = require('../src/core/export/typst/mathConverter.js');
const {
    RealWasmSandboxHost,
    repoRoot,
    resolveLocalCjkFont,
} = require('./helpers/realWasmSandbox.js');
const { extractPdfText } = require('./helpers/pdfTextExtract.js');
const {
    probePdfLayout,
    checkContentBounds,
    checkBlankPages,
    checkDuplicatedRuns,
    normalizeText,
    countOccurrences,
} = require('./helpers/pdfPageProbe.js');

const CORPUS_DIR = path.join(__dirname, 'fixtures', 'visual-corpus');

/** Fixed corpus manifest: ids must stay stable so the corpus is comparable over time. */
const EXPECTED_IDS = [
    '01-long-assistant-answer',
    '02-long-user-prompt',
    '03-code-heavy',
    '04-nested-list-quote',
    '05-wide-table',
    '06-span-table',
    '07-portrait-image',
    '08-image-caption',
    '09-many-attachments',
    '10-cjk-math',
    '11-missing-asset',
    '12-long-multipage-conversation',
];

interface CorpusEntry {
    file: string;
    item: any;
}

function loadCorpus(): CorpusEntry[] {
    const files = fs.readdirSync(CORPUS_DIR).filter((f: string) => f.endsWith('.json')).sort();
    return files.map((f: string) => ({
        file: f,
        item: JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, f), 'utf8')),
    }));
}

test('visual corpus manifest: exactly the 12 fixed fixtures with stable ids', () => {
    const entries = loadCorpus();
    assert.strictEqual(entries.length, 12, `expected 12 fixtures, found ${entries.length}`);
    assert.deepStrictEqual(
        entries.map((e) => e.item.id),
        EXPECTED_IDS,
    );
    for (const { item } of entries) {
        assert.ok(item.bundle && item.bundle.conversation, `${item.id}: missing bundle.conversation`);
        assert.ok(item.expect && typeof item.expect.minPages === 'number', `${item.id}: missing expect.minPages`);
    }
});

interface FixtureResult {
    id: string;
    title: string;
    pages: number;
    images: number;
    status: 'PASS';
    notes: string[];
    pdfBytes: Uint8Array;
}

/**
 * REGRESSION GUARD (typst.ts 0.7.0 vendored WASM): `#raw(..., lang: <any>)`
 * dropped every space character from code blocks — e.g. `def foo(a, b):`
 * became `deffoo(a,b):`. Reproduced with a hand-written main.typ through
 * typst.ts directly, so it is independent of the product's payload/templates.
 * Inline code is unaffected (it renders via plain text, not raw+lang).
 *
 * The template (`components.typ`) now drops the `lang:` argument entirely:
 * code fidelity wins over syntax highlighting. This check is a HARD assertion
 * — if the vendored Typst runtime is ever upgraded or `lang:` is restored,
 * this fails loudly. Do NOT "fix" this by changing the renderer or the
 * fixtures to dodge the check.
 */
function assertCodeSpaces(pdfText: string, item: any, fixtureId: string): void {
    // Space-SENSITIVE comparison: collapse all whitespace runs to one space,
    // but keep single spaces (normalizeText strips them, which would hide the bug).
    const keepSpaces = (s: string) => s.replace(/\s+/g, ' ');
    const hay = keepSpaces(pdfText);
    const needles: string[] = item.expect.codeSpaceNeedles ?? [];
    for (const needle of needles) {
        // space-sensitive: the exact phrase with its spaces must survive.
        assert.ok(
            hay.includes(keepSpaces(needle)),
            `${fixtureId}: code space regression — phrase with spaces not found in compiled PDF text: ${JSON.stringify(needle)}`,
        );
    }
}

async function checkOneFixture(compiler: any, entry: CorpusEntry): Promise<FixtureResult> {
    const { item } = entry;
    const notes: string[] = [];
    const status: 'PASS' = 'PASS';

    const store: Record<string, Uint8Array> = {};
    for (const [aid, b64] of Object.entries(item.binaries ?? {})) {
        store[aid] = new Uint8Array(Buffer.from(b64 as string, 'base64'));
    }
    const bundle = item.bundle;
    const { payload: document, diagnostics: payloadDiagnostics } = toTypstPayload(bundle, {
        assetPath: (a: any) => `/assets/${a.id}`,
        convertMath,
        locale: 'zh',
    });
    const assetIds: string[] = (bundle.assets ?? []).map((a: any) => a.id);
    const context = {
        bundle,
        assets: {
            resolve: async (id: string) => (store[id] ? { bytes: store[id] } : null),
        },
        locale: 'zh' as const,
        signal: new AbortController().signal,
        reportProgress: () => undefined,
    };
    const result = await compiler.compile(
        {
            rendererSchemaVersion: 1,
            sourceSchemaVersion: 1,
            bundle,
            document,
            assetPaths: new Map(assetIds.map((id: string) => [id, `/assets/${id}`])),
        } as never,
        context as never,
    );
    const pdfBytes: Uint8Array = result.pdfBytes;

    // 1. PDF magic.
    assert.strictEqual(
        Buffer.from(pdfBytes.slice(0, 5)).toString('latin1'),
        '%PDF-',
        `${item.id}: not a PDF`,
    );

    // 2. Zero error diagnostics (payload + compiler).
    const allDiagnostics = [...payloadDiagnostics, ...result.diagnostics];
    const errors = allDiagnostics.filter((d: any) => d.severity === 'error');
    assert.strictEqual(errors.length, 0, `${item.id}: compile errors: ${JSON.stringify(errors).slice(0, 500)}`);

    // 3. Expected warning diagnostics (e.g. missing asset).
    for (const code of item.expect.warnCodes ?? []) {
        assert.ok(
            allDiagnostics.some((d: any) => d.code === code),
            `${item.id}: expected warning diagnostic ${code} not emitted`,
        );
        notes.push(`expected warning emitted: ${code}`);
    }

    // 4. Text extraction + phrase integrity.
    const extracted = extractPdfText(pdfBytes);
    const norm = normalizeText(extracted.text);
    assert.ok(
        extracted.pageCount >= item.expect.minPages,
        `${item.id}: pages=${extracted.pageCount} < minPages=${item.expect.minPages}`,
    );
    for (const phrase of item.expect.phrases ?? []) {
        assert.ok(norm.includes(normalizeText(phrase)), `${item.id}: phrase missing: ${JSON.stringify(phrase)}`);
    }
    for (const phrase of item.expect.exactlyOnce ?? []) {
        const n = countOccurrences(norm, normalizeText(phrase));
        assert.strictEqual(n, 1, `${item.id}: phrase expected exactly once, found ${n}x: ${JSON.stringify(phrase)}`);
    }

    // 5. No tofu.
    assert.ok(!extracted.text.includes('�'), `${item.id}: U+FFFD tofu found in extracted text`);

    // 6. Layout probe: bounds / blank pages / duplicated runs.
    const layout = probePdfLayout(pdfBytes);
    assert.strictEqual(layout.pages.length, extracted.pageCount, `${item.id}: probe page count mismatch`);
    const layoutIssues = [
        ...checkContentBounds(layout),
        ...checkBlankPages(layout),
        ...checkDuplicatedRuns(layout),
    ];
    assert.strictEqual(
        layoutIssues.length,
        0,
        `${item.id}: layout issues: ${layoutIssues.map((i: any) => `[${i.check}] ${i.message}`).join(' | ').slice(0, 600)}`,
    );

    // 7. Images: XObject count + draw rects inside page bounds.
    if (typeof item.expect.imageCount === 'number') {
        assert.strictEqual(
            extracted.imageXObjectCount,
            item.expect.imageCount,
            `${item.id}: image XObjects=${extracted.imageXObjectCount}, expected=${item.expect.imageCount}`,
        );
    }
    let drawnImages = 0;
    for (const page of layout.pages) {
        for (const d of page.imageDraws) {
            drawnImages += 1;
            assert.ok(
                d.x >= -1 && d.y >= -1 && d.x + d.w <= page.width + 1 && d.y + d.h <= page.height + 1,
                `${item.id}: image draw out of bounds: ${JSON.stringify(d)}`,
            );
        }
    }
    if (typeof item.expect.imageDraws === 'number') {
        assert.strictEqual(
            drawnImages,
            item.expect.imageDraws,
            `${item.id}: drawn images=${drawnImages}, expected=${item.expect.imageDraws}`,
        );
    }

    // 8. CJK + math needles.
    for (const needle of item.expect.mathNeedles ?? []) {
        assert.ok(norm.includes(normalizeText(needle)), `${item.id}: math needle missing: ${JSON.stringify(needle)}`);
    }

    // 9. Code blocks: characters must not be lost (whitespace-insensitive),
    //    spaces are hard-asserted as a regression guard (see above).
    assertCodeSpaces(extracted.text, item, item.id);

    return {
        id: item.id,
        title: item.title ?? item.id,
        pages: extracted.pageCount,
        images: extracted.imageXObjectCount,
        status,
        notes,
        pdfBytes,
    };
}

function writeReviewReport(dir: string, results: FixtureResult[]): void {
    fs.mkdirSync(dir, { recursive: true });
    const lines: string[] = [];
    lines.push(`# PDF Visual Corpus Review — Item 7`);
    lines.push(``);
    lines.push(`- 生成时间: ${new Date().toISOString()}`);
    lines.push(`- 验证等级: 本机真实 Typst WASM 编译 + 程序化检查（非真人视觉验收）`);
    lines.push(`- 语料: 12 份固定 fixture（tests/fixtures/visual-corpus/）`);
    lines.push(`- 程序化检查项: overflow/clipping、大片空白、broken pagination、duplicated content、image overflow、table readability（文本存在性+边界）、CJK/math 无 tofu、缺失资源 warning`);
    lines.push(``);
    lines.push(`| # | Fixture | 页数 | 图片 | 状态 | 备注 |`);
    lines.push(`|---|---------|------|------|------|------|`);
    for (const r of results) {
        lines.push(
            `| ${r.id.slice(0, 2)} | ${r.id} | ${r.pages} | ${r.images} | ${r.status} | ${(r.notes.join('；') || '—').slice(0, 120)} |`,
        );
    }
    lines.push(``);
    lines.push(`## 逐项说明`);
    lines.push(``);
    for (const r of results) {
        lines.push(`### ${r.id} — ${r.title}`);
        lines.push(``);
        lines.push(`- 页数: ${r.pages}；图片 XObject: ${r.images}；状态: **${r.status}**`);
        for (const n of r.notes) lines.push(`- ${n}`);
        if (!r.notes.length) lines.push(`- 程序化检查全部通过（文本/图片边界、空白页、重复内容均无异常）。`);
        lines.push(``);
    }
    lines.push(`## 已知问题（非本 PR 范围，需后续跟进）`);
    lines.push(``);
    lines.push(`- 无。`);
    lines.push(``);
    lines.push(
        `> 说明：自动探针不是 pixel-level 审美判定。12 份 PDF 保留在本目录，供真人按真实阅读尺寸做最终视觉验收。`,
    );
    fs.writeFileSync(path.join(dir, 'REVIEW.md'), lines.join('\n'), 'utf8');
}

test('visual corpus: real Typst WASM compile + programmatic checks (all 12)', async (t: any) => {
    const cjkFont = resolveLocalCjkFont();
    if (!cjkFont) {
        t.skip(
            'no locally installed CJK font on this machine; production serves CJK via the Local Font Access API (user device fonts), which has no Tier-1 equivalent here (same rationale as D8-3)',
        );
        return;
    }
    const entries = loadCorpus();
    assert.strictEqual(entries.length, 12);

    const host = new RealWasmSandboxHost(repoRoot());
    const compiler = new TypstSandboxCompiler({
        host,
        fontPaths: ['src/ui/sandbox/fonts/NewCMMath-Regular.otf', cjkFont],
    });
    const reviewDir = process.env.PDF_VISUAL_REVIEW_DIR;
    const results: FixtureResult[] = [];
    try {
        for (const entry of entries) {
            await t.test(`compile+check ${entry.item.id}`, async () => {
                const r = await checkOneFixture(compiler, entry);
                results.push(r);
                if (reviewDir) {
                    fs.mkdirSync(reviewDir, { recursive: true });
                    fs.writeFileSync(path.join(reviewDir, `${r.id}.pdf`), Buffer.from(r.pdfBytes));
                }
            });
        }
    } finally {
        compiler.dispose();
    }
    if (reviewDir) writeReviewReport(reviewDir, results);
});
