/**
 * tests/runner_isolation.test.ts
 *
 * Tier 1 unit test for Parser Migration Runner Lifecycle Isolation (Independence Invariant).
 *
 * Verifies all 8 failure isolation matrix combinations:
 * 1. Baseline Success / Candidate Success (both succeed, 0 diffs on identical AST)
 * 2. Baseline Fail / Candidate Success (candidate gain isolated, baseline failure recorded)
 * 3. Baseline Success / Candidate Fail (candidate failure isolated, baseline 0 failures)
 * 4. Baseline Throw / Candidate Success (baseline crash does not cancel candidate execution)
 * 5. Baseline Success / Candidate Throw (candidate crash does not increment baseline failures)
 * 6. Both Fail (independent failure counters, separate diagnostics)
 * 7. Both Throw (independent fatal exception counters, diff recorded, no unhandled rejection)
 * 8. Typst WASM Compile Gate Isolation (candidate compile failure does not bleed into baseline)
 */

export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { runCorpus } = require('../scripts/parser_migration/run_corpus.ts');

const ISOLATION_FIXTURE_PATH = path.join(__dirname, 'output/isolation_test_corpus.json');
const ISOLATION_REPORT_PATH = path.join(__dirname, 'output/isolation_test_report.json');

// Helper to write a controlled mini-corpus
function setupMiniCorpus(docText = 'Test input text', mathLatex = 'x^2') {
    fs.mkdirSync(path.dirname(ISOLATION_FIXTURE_PATH), { recursive: true });
    const miniCorpus = {
        admissionPolicy: { real_gemini_output: 'ONLY real Gemini' },
        corpusSets: {
            isolation: {
                documents: [{ id: 'doc-iso-1', text: docText, source: 'test' }],
                mathExpressions: [{ id: 'math-iso-1', latex: mathLatex, display: false, source: 'test' }],
            },
        },
    };
    fs.writeFileSync(ISOLATION_FIXTURE_PATH, JSON.stringify(miniCorpus, null, 2), 'utf-8');
}

test('Runner Isolation Matrix [1/8]: Baseline Success / Candidate Success', async () => {
    setupMiniCorpus();
    const report = await runCorpus({
        corpusPath: ISOLATION_FIXTURE_PATH,
        outputPath: ISOLATION_REPORT_PATH,
        corpusCategory: 'isolation' as any,
        compileTypst: false,
        baselineParser: async (text: string) => ({
            bundle: { conversation: { messages: [{ blocks: [{ type: 'paragraph', children: [{ type: 'text', text }] }] }] } },
            diagnostics: [],
        }),
        candidateParser: async (text: string) => ({
            bundle: { conversation: { messages: [{ blocks: [{ type: 'paragraph', children: [{ type: 'text', text }] }] }] } },
            diagnostics: [],
        }),
        baselineConverter: (latex: string) => ({ typst: latex }),
        candidateConverter: (latex: string) => ({ typst: latex }),
    });

    assert.strictEqual(report.markdown.baseline.parseFailures, 0);
    assert.strictEqual(report.markdown.candidate?.parseFailures, 0);
    assert.strictEqual(report.markdown.diffCount, 0, 'Identical AST must produce zero diffs');
    assert.strictEqual(report.math.baseline.conversionFailures, 0);
    assert.strictEqual(report.math.candidate?.conversionFailures, 0);
    assert.strictEqual(report.math.diffCount, 0);
});

test('Runner Isolation Matrix [2/8]: Baseline Fail (Fallback) / Candidate Success', async () => {
    setupMiniCorpus('Sample', '\\binom{n}{k}');
    const report = await runCorpus({
        corpusPath: ISOLATION_FIXTURE_PATH,
        outputPath: ISOLATION_REPORT_PATH,
        corpusCategory: 'isolation' as any,
        compileTypst: false,
        baselineConverter: () => ({ diagnostic: { code: 'UNSUPPORTED_MACRO', message: 'Unknown macro' } }),
        candidateConverter: () => ({ typst: 'binom(n, k)' }),
    });

    // Baseline records failure
    assert.strictEqual(report.math.baseline.converted, 0);
    assert.strictEqual(report.math.baseline.conversionFailures, 1);
    assert.strictEqual(report.math.conversionFailures, 1);

    // Candidate records success independently
    assert.strictEqual(report.math.candidate?.converted, 1);
    assert.strictEqual(report.math.candidate?.conversionFailures, 0);

    // Diff correctly flags candidate conversion gain
    assert.strictEqual(report.math.diffCount, 1);
    assert.strictEqual(report.math.diffsByCategory.D_CANNOT_DETERMINE, 1);
});

test('Runner Isolation Matrix [3/8]: Baseline Success / Candidate Fail (Fallback Block)', async () => {
    setupMiniCorpus('Valid markdown text');
    const report = await runCorpus({
        corpusPath: ISOLATION_FIXTURE_PATH,
        outputPath: ISOLATION_REPORT_PATH,
        corpusCategory: 'isolation' as any,
        compileTypst: false,
        baselineParser: async (text: string) => ({
            bundle: { conversation: { messages: [{ blocks: [{ type: 'paragraph', children: [{ type: 'text', text }] }] }] } },
            diagnostics: [],
        }),
        candidateParser: async () => ({
            bundle: { conversation: { messages: [{ blocks: [{ type: 'unknown', sourceType: 'unsupported', text: 'Unsupported content' }] }] } },
            diagnostics: [{ code: 'CANDIDATE_FALLBACK', message: 'Candidate fallback' }],
        }),
    });

    // Baseline remains completely clean
    assert.strictEqual(report.markdown.baseline.parseFailures, 0);
    assert.strictEqual(report.markdown.baseline.fallbacks, 0);
    assert.strictEqual(report.markdown.parseFailures, 0);
    assert.strictEqual(report.markdown.fallbacks, 0);

    // Candidate records fallback independently
    assert.strictEqual(report.markdown.candidate?.fallbacks, 1);
    assert.strictEqual(report.markdown.candidate?.parseFailures, 0);
    assert.strictEqual(report.markdown.diffCount, 1);
});

test('Runner Isolation Matrix [4/8]: Baseline Throw (Crash) / Candidate Success', async () => {
    setupMiniCorpus('Crash input');
    const report = await runCorpus({
        corpusPath: ISOLATION_FIXTURE_PATH,
        outputPath: ISOLATION_REPORT_PATH,
        corpusCategory: 'isolation' as any,
        compileTypst: false,
        baselineParser: async () => {
            throw new Error('Fatal crash in baseline parser');
        },
        candidateParser: async (text: string) => ({
            bundle: { conversation: { messages: [{ blocks: [{ type: 'paragraph', children: [{ type: 'text', text }] }] }] } },
            diagnostics: [],
        }),
    });

    // Baseline records parse crash
    assert.strictEqual(report.markdown.baseline.parseFailures, 1);
    assert.strictEqual(report.markdown.parseFailures, 1);

    // Candidate MUST STILL EXECUTE and succeed (not skipped due to baseline throw!)
    assert.strictEqual(report.markdown.candidate?.parseFailures, 0);
    assert.strictEqual(report.markdown.candidate?.blockDistribution['paragraph'], 1);

    // Diff recorded for candidate recovery observation
    assert.strictEqual(report.markdown.diffCount, 1);
    assert.strictEqual(report.markdown.diffsByCategory.D_CANNOT_DETERMINE, 1);
});

test('Runner Isolation Matrix [5/8]: Baseline Success / Candidate Throw (Crash)', async () => {
    setupMiniCorpus('Valid input');
    const report = await runCorpus({
        corpusPath: ISOLATION_FIXTURE_PATH,
        outputPath: ISOLATION_REPORT_PATH,
        corpusCategory: 'isolation' as any,
        compileTypst: false,
        baselineParser: async (text: string) => ({
            bundle: { conversation: { messages: [{ blocks: [{ type: 'paragraph', children: [{ type: 'text', text }] }] }] } },
            diagnostics: [],
        }),
        candidateParser: async () => {
            throw new Error('Fatal crash in candidate parser');
        },
    });

    // Baseline failure count MUST REMAIN ZERO! Candidate crash must not pollute baseline.
    assert.strictEqual(report.markdown.baseline.parseFailures, 0, 'Baseline parseFailures must remain 0 when candidate crashes');
    assert.strictEqual(report.markdown.parseFailures, 0);

    // Candidate records failure independently
    assert.strictEqual(report.markdown.candidate?.parseFailures, 1);
    assert.strictEqual(report.markdown.diffCount, 1);
    assert.strictEqual(report.markdown.diffsByCategory.D_CANNOT_DETERMINE, 1);
});

test('Runner Isolation Matrix [6/8]: Both Fail (Independent Conversion Fallbacks)', async () => {
    setupMiniCorpus('Math', 'some invalid latex');
    const report = await runCorpus({
        corpusPath: ISOLATION_FIXTURE_PATH,
        outputPath: ISOLATION_REPORT_PATH,
        corpusCategory: 'isolation' as any,
        compileTypst: false,
        baselineConverter: () => ({ diagnostic: { code: 'BASE_ERR', message: 'Baseline fallback' } }),
        candidateConverter: () => ({ diagnostic: { code: 'CAND_ERR', message: 'Candidate fallback' } }),
    });

    assert.strictEqual(report.math.baseline.conversionFailures, 1);
    assert.strictEqual(report.math.candidate?.conversionFailures, 1);
    assert.ok(report.diagnostics.some((d: any) => d.domain === 'math_baseline'));
    assert.ok(report.diagnostics.some((d: any) => d.domain === 'math_candidate'));
});

test('Runner Isolation Matrix [7/8]: Both Throw (Fatal Crashes)', async () => {
    setupMiniCorpus('Both crash doc', 'Both crash math');
    const report = await runCorpus({
        corpusPath: ISOLATION_FIXTURE_PATH,
        outputPath: ISOLATION_REPORT_PATH,
        corpusCategory: 'isolation' as any,
        compileTypst: false,
        baselineParser: async () => { throw new Error('Base parser boom'); },
        candidateParser: async () => { throw new Error('Cand parser boom'); },
        baselineConverter: () => { throw new Error('Base math boom'); },
        candidateConverter: () => { throw new Error('Cand math boom'); },
    });

    assert.strictEqual(report.markdown.baseline.parseFailures, 1);
    assert.strictEqual(report.markdown.candidate?.parseFailures, 1);
    assert.strictEqual(report.math.baseline.conversionFailures, 1);
    assert.strictEqual(report.math.candidate?.conversionFailures, 1);
    assert.strictEqual(report.markdown.diffCount, 1);
    assert.strictEqual(report.math.diffCount, 1);
});

test('Runner Isolation Matrix [8/8]: Typst WASM Compile Gate Isolation', async () => {
    setupMiniCorpus('Text', 'x^2');
    const report = await runCorpus({
        corpusPath: ISOLATION_FIXTURE_PATH,
        outputPath: ISOLATION_REPORT_PATH,
        corpusCategory: 'isolation' as any,
        compileTypst: true,
        baselineConverter: () => ({ typst: 'x^2' }),
        // Candidate produces invalid Typst syntax that will fail WASM compilation
        candidateConverter: () => ({ typst: '#sys.nonexistent_unknown_func()' }),
    });

    // Baseline compiles cleanly in real Typst WASM compiler
    assert.strictEqual(report.math.baseline.compileFailures, 0, 'Baseline compile failures must be 0');
    assert.strictEqual(report.math.compileFailures, 0, 'Top-level baseline alias must be 0');

    // Candidate fails WASM compilation independently
    assert.ok(
        (report.math.candidate?.compileFailures ?? 0) >= 1,
        'Candidate compile failures must be recorded without polluting baseline'
    );
});
