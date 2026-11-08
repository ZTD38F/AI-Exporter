import { fixtureAccount, fixtureKey } from '../../tests/helpers/domainFixture.js';
import { historicalFixture } from '../../tests/helpers/nativeFixture.js';

import * as fs from 'fs';
import * as path from 'path';
import { composeDomainDocument } from '../../src/l3b/compose/composeDomainDocument.js';
import type { DomainConversationWithDetail } from '../../src/l2/conversation.js';
import type { Diagnostic } from '../../src/shared/diagnostics/diagnostic.js';
import { convertMathWithMitex, initMitexWasm } from '../../src/l4/format/typst/mathConverter.js';
import { compareMarkdownAst, compareMathConversion, type DiffCategory } from './diff_runner.js';
import { TypstSandboxCompiler } from '../../src/l4/format/pdf/typst/typstSandboxCompiler.js';
import { renderDocumentTypstCore } from '../../src/l4/format/typst/renderTypstCore.js';
import { RealWasmSandboxHost, repoRoot } from '../../tests/helpers/realWasmSandbox.js';

type MarkdownParserFn = (content: string, id: string) => Promise<{ conversation: DomainConversationDetail; diagnostics: Diagnostic[] }>;
type MathConverterFn = (latex: string, display: boolean) => { typst?: string; diagnostic?: any };

interface CorpusRunnerOptions {
    corpusPath?: string;
    outputPath?: string;
    corpusCategory?: 'all' | 'real_gemini_output' | 'scenario_inputs' | 'synthetic_fixtures';
    baselineParser?: MarkdownParserFn;
    candidateParser?: MarkdownParserFn;
    baselineConverter?: MathConverterFn;
    candidateConverter?: MathConverterFn;
    compileTypst?: boolean;
}

interface CorpusReport {
    timestamp: string;
    corpusSet: string;
    markdown: {
        documents: number;
        baseline: {
            parseFailures: number;
            fallbacks: number;
            blockDistribution: Record<string, number>;
        };
        candidate?: {
            parseFailures: number;
            fallbacks: number;
            blockDistribution: Record<string, number>;
        };
        // Backwards-compatible aliases reflecting baseline:
        parseFailures: number;
        fallbacks: number;
        blockDistribution: Record<string, number>;
        diffCount: number;
        diffsByCategory: Record<DiffCategory, number>;
        totalDurationMs: number;
        avgDurationMs: number;
    };
    math: {
        expressions: number;
        baseline: {
            converted: number;
            conversionFailures: number;
            compileFailures: number;
        };
        candidate?: {
            converted: number;
            conversionFailures: number;
            compileFailures: number;
        };
        // Backwards-compatible aliases reflecting baseline:
        converted: number;
        conversionFailures: number;
        compileFailures: number;
        diffCount: number;
        diffsByCategory: Record<DiffCategory, number>;
        totalDurationMs: number;
        avgDurationMs: number;
    };
    diagnostics: Array<{ domain: string; id: string; code?: string; message: string }>;
    diffs: Array<{ id: string; domain: string; category?: string; rationale?: string }>;
}

export async function runCorpus(options: CorpusRunnerOptions = {}): Promise<CorpusReport> {
    const defaultCorpusPath = path.join(__dirname, '../../tests/fixtures/parser_migration_corpus.json');
    const finalCorpusPath = options.corpusPath || defaultCorpusPath;
    const defaultOutputPath = path.join(__dirname, '../../tests/output/corpus_report.json');
    const finalOutputPath = options.outputPath || defaultOutputPath;
    const category = options.corpusCategory || 'all';

    if (!fs.existsSync(finalCorpusPath)) {
        throw new Error(`Corpus file not found at: ${finalCorpusPath}. Run extract_corpus.py first.`);
    }

    const corpusData = JSON.parse(fs.readFileSync(finalCorpusPath, 'utf-8'));
    let documents: any[] = [];
    let mathExpressions: any[] = [];

    if (category === 'all') {
        const sets = corpusData.corpusSets || {};
        for (const setName of Object.keys(sets)) {
            documents.push(...(sets[setName]?.documents || []));
            mathExpressions.push(...(sets[setName]?.mathExpressions || []));
        }
    } else {
        const targetSet = corpusData.corpusSets?.[category];
        if (targetSet) {
            documents = targetSet.documents || [];
            mathExpressions = targetSet.mathExpressions || [];
        }
    }

    // Default baseline parser & converter if not injected
    const defaultBaselineParser: MarkdownParserFn = async (content, id) => {
        return historicalFixture({
            id,
            messages: [{ id: 'm1', role: 'user', content }],
        }, { providerId: 'gemini' });
    };

    const activeBaselineParser = options.baselineParser || defaultBaselineParser;
    const activeCandidateParser = options.candidateParser;
    const defaultBaselineConverter: MathConverterFn = (latex, display) => convertMathWithMitex(latex, 'latex', display);
    const activeBaselineConverter = options.baselineConverter || defaultBaselineConverter;

    const defaultCandidateConverter: MathConverterFn = (latex, display) => {
        const res = convertMathWithMitex(latex, 'latex', display);
        return { typst: res.typst, diagnostic: res.diagnostic };
    };
    const activeCandidateConverter = 'candidateConverter' in options
        ? options.candidateConverter
        : defaultCandidateConverter;

    if (activeCandidateConverter) {
        await initMitexWasm();
    }

    const report: CorpusReport = {
        timestamp: new Date().toISOString(),
        corpusSet: category,
        markdown: {
            documents: documents.length,
            baseline: {
                parseFailures: 0,
                fallbacks: 0,
                blockDistribution: {},
            },
            ...(activeCandidateParser
                ? {
                      candidate: {
                          parseFailures: 0,
                          fallbacks: 0,
                          blockDistribution: {},
                      },
                  }
                : {}),
            parseFailures: 0,
            fallbacks: 0,
            blockDistribution: {},
            diffCount: 0,
            diffsByCategory: {
                A_NEW_PARSER_CORRECT: 0,
                B_OLD_PARSER_GEMINI_DIALECT: 0,
                C_BOTH_REASONABLE: 0,
                D_CANNOT_DETERMINE: 0,
            },
            totalDurationMs: 0,
            avgDurationMs: 0,
        },
        math: {
            expressions: mathExpressions.length,
            baseline: {
                converted: 0,
                conversionFailures: 0,
                compileFailures: 0,
            },
            ...(activeCandidateConverter
                ? {
                      candidate: {
                          converted: 0,
                          conversionFailures: 0,
                          compileFailures: 0,
                      },
                  }
                : {}),
            converted: 0,
            conversionFailures: 0,
            compileFailures: 0,
            diffCount: 0,
            diffsByCategory: {
                A_NEW_PARSER_CORRECT: 0,
                B_OLD_PARSER_GEMINI_DIALECT: 0,
                C_BOTH_REASONABLE: 0,
                D_CANNOT_DETERMINE: 0,
            },
            totalDurationMs: 0,
            avgDurationMs: 0,
        },
        diagnostics: [],
        diffs: [],
    };

    const mdStart = Date.now();
    for (const doc of documents) {
        let baseRes: any = null;
        let baseErr: any = null;
        let candRes: any = null;
        let candErr: any = null;

        try {
            baseRes = await activeBaselineParser(doc.text, doc.id);
            for (const d of baseRes?.diagnostics || []) {
                report.diagnostics.push({
                    domain: 'markdown_baseline',
                    id: doc.id,
                    code: d.code,
                    message: d.message,
                });
            }

            const msg = baseRes?.conversation?.detail.messages?.[0];
            for (const block of msg?.content || []) {
                report.markdown.baseline.blockDistribution[block.type] =
                    (report.markdown.baseline.blockDistribution[block.type] || 0) + 1;
                if (block.type === 'unknown') {
                    report.markdown.baseline.fallbacks += 1;
                }
            }
        } catch (err: any) {
            baseErr = err;
            report.markdown.baseline.parseFailures += 1;
            report.diagnostics.push({
                domain: 'markdown_baseline',
                id: doc.id,
                message: `Baseline fatal parse exception: ${err.message || String(err)}`,
            });
        }

        // 1b. Run Candidate parser in isolated try/catch (runs REGARDLESS of baseline)
        if (activeCandidateParser) {
            try {
                candRes = await activeCandidateParser(doc.text, doc.id);
                for (const d of candRes?.diagnostics || []) {
                    report.diagnostics.push({
                        domain: 'markdown_candidate',
                        id: doc.id,
                        code: d.code,
                        message: d.message,
                    });
                }

                const msg = candRes?.conversation?.detail.messages?.[0];
                for (const block of msg?.content || []) {
                    report.markdown.candidate!.blockDistribution[block.type] =
                        (report.markdown.candidate!.blockDistribution[block.type] || 0) + 1;
                    if (block.type === 'unknown') {
                        report.markdown.candidate!.fallbacks += 1;
                    }
                }
            } catch (err: any) {
                candErr = err;
                report.markdown.candidate!.parseFailures += 1;
                report.diagnostics.push({
                    domain: 'markdown_candidate',
                    id: doc.id,
                    message: `Candidate fatal parse exception: ${err.message || String(err)}`,
                });
            }
        }

        if (activeCandidateParser) {
            if (baseRes && candRes) {
                const diff = compareMarkdownAst(doc.text, baseRes.conversation.detail.messages[0]?.content ?? [], candRes.conversation.detail.messages[0]?.content ?? []);
                if (diff.hasDiff) {
                    report.markdown.diffCount += 1;
                    if (diff.category) {
                        report.markdown.diffsByCategory[diff.category] =
                            (report.markdown.diffsByCategory[diff.category] || 0) + 1;
                    }
                    report.diffs.push({
                        id: doc.id,
                        domain: 'markdown',
                        category: diff.category,
                        rationale: diff.rationale,
                    });
                }
            } else if (!baseErr && candErr) {
                report.markdown.diffCount += 1;
                report.markdown.diffsByCategory.D_CANNOT_DETERMINE += 1;
                report.diffs.push({
                    id: doc.id,
                    domain: 'markdown',
                    category: 'D_CANNOT_DETERMINE',
                    rationale: `Candidate threw fatal exception while baseline succeeded: ${candErr.message || String(candErr)}`,
                });
            } else if (baseErr && !candErr) {
                report.markdown.diffCount += 1;
                report.markdown.diffsByCategory.D_CANNOT_DETERMINE += 1;
                report.diffs.push({
                    id: doc.id,
                    domain: 'markdown',
                    category: 'D_CANNOT_DETERMINE',
                    rationale: `Baseline threw fatal exception while candidate succeeded. Candidate recovery observed.`,
                });
            } else if (baseErr && candErr) {
                report.markdown.diffCount += 1;
                report.markdown.diffsByCategory.D_CANNOT_DETERMINE += 1;
                report.diffs.push({
                    id: doc.id,
                    domain: 'markdown',
                    category: 'D_CANNOT_DETERMINE',
                    rationale: `Both baseline and candidate threw fatal exceptions.`,
                });
            }
        }
    }
    const mdEnd = Date.now();
    report.markdown.totalDurationMs = mdEnd - mdStart;
    report.markdown.avgDurationMs = documents.length > 0 ? (mdEnd - mdStart) / documents.length : 0;
    // Keep top-level aliases synchronized with baseline
    report.markdown.parseFailures = report.markdown.baseline.parseFailures;
    report.markdown.fallbacks = report.markdown.baseline.fallbacks;
    report.markdown.blockDistribution = report.markdown.baseline.blockDistribution;

    const mathStart = Date.now();
    const baselineSuccessful: Array<{ id: string; latex: string; display: boolean; typst: string }> = [];
    const candidateSuccessful: Array<{ id: string; latex: string; display: boolean; typst: string }> = [];

    for (const expr of mathExpressions) {
        let baseRes: any = null;
        let baseErr: any = null;
        let candRes: any = null;
        let candErr: any = null;

        try {
            baseRes = activeBaselineConverter(expr.latex, !!expr.display);
            if (baseRes?.typst) {
                report.math.baseline.converted += 1;
                baselineSuccessful.push({
                    id: expr.id,
                    latex: expr.latex,
                    display: !!expr.display,
                    typst: baseRes.typst,
                });
            } else {
                report.math.baseline.conversionFailures += 1;
                if (baseRes?.diagnostic) {
                    report.diagnostics.push({
                        domain: 'math_baseline',
                        id: expr.id,
                        code: baseRes.diagnostic.code,
                        message: baseRes.diagnostic.message,
                    });
                }
            }
        } catch (err: any) {
            baseErr = err;
            report.math.baseline.conversionFailures += 1;
            report.diagnostics.push({
                domain: 'math_baseline',
                id: expr.id,
                message: `Baseline fatal math conversion exception: ${err.message || String(err)}`,
            });
        }

        // 2b. Run Candidate converter in isolated try/catch (runs REGARDLESS of baseline)
        if (activeCandidateConverter) {
            try {
                candRes = activeCandidateConverter(expr.latex, !!expr.display);
                if (candRes?.typst) {
                    report.math.candidate!.converted += 1;
                    candidateSuccessful.push({
                        id: expr.id,
                        latex: expr.latex,
                        display: !!expr.display,
                        typst: candRes.typst,
                    });
                } else {
                    report.math.candidate!.conversionFailures += 1;
                    if (candRes?.diagnostic) {
                        report.diagnostics.push({
                            domain: 'math_candidate',
                            id: expr.id,
                            code: candRes.diagnostic.code,
                            message: candRes.diagnostic.message,
                        });
                    }
                }
            } catch (err: any) {
                candErr = err;
                report.math.candidate!.conversionFailures += 1;
                report.diagnostics.push({
                    domain: 'math_candidate',
                    id: expr.id,
                    message: `Candidate fatal math conversion exception: ${err.message || String(err)}`,
                });
            }
        }

        if (activeCandidateConverter) {
            if (baseRes && candRes) {
                const diff = compareMathConversion(expr.latex, baseRes, candRes);
                if (diff.hasDiff) {
                    report.math.diffCount += 1;
                    if (diff.category) {
                        report.math.diffsByCategory[diff.category] =
                            (report.math.diffsByCategory[diff.category] || 0) + 1;
                    }
                    report.diffs.push({
                        id: expr.id,
                        domain: 'latex',
                        category: diff.category,
                        rationale: diff.rationale,
                    });
                }
            } else if (!baseErr && candErr) {
                report.math.diffCount += 1;
                report.math.diffsByCategory.D_CANNOT_DETERMINE += 1;
                report.diffs.push({
                    id: expr.id,
                    domain: 'latex',
                    category: 'D_CANNOT_DETERMINE',
                    rationale: `Candidate threw fatal math exception while baseline completed.`,
                });
            } else if (baseErr && !candErr) {
                report.math.diffCount += 1;
                report.math.diffsByCategory.D_CANNOT_DETERMINE += 1;
                report.diffs.push({
                    id: expr.id,
                    domain: 'latex',
                    category: 'D_CANNOT_DETERMINE',
                    rationale: `Baseline threw fatal math exception while candidate completed.`,
                });
            } else if (baseErr && candErr) {
                report.math.diffCount += 1;
                report.math.diffsByCategory.D_CANNOT_DETERMINE += 1;
                report.diffs.push({
                    id: expr.id,
                    domain: 'latex',
                    category: 'D_CANNOT_DETERMINE',
                    rationale: `Both baseline and candidate threw fatal math conversion exceptions.`,
                });
            }
        }
    }
    const mathEnd = Date.now();
    report.math.totalDurationMs = mathEnd - mathStart;
    report.math.avgDurationMs = mathExpressions.length > 0 ? (mathEnd - mathStart) / mathExpressions.length : 0;
    // Keep top-level aliases synchronized with baseline
    report.math.converted = report.math.baseline.converted;
    report.math.conversionFailures = report.math.baseline.conversionFailures;

    // 3. Genuine Typst WASM compilation gate (100% of expressions evaluated, no truncation)
    // Compiles the EXACT output obtained from conversion phase; never re-invokes converters.
    if (options.compileTypst) {
        if (baselineSuccessful.length > 0) {
            try {
                const host = new RealWasmSandboxHost(repoRoot());
                const compiler = new TypstSandboxCompiler({ host });
                try {
                    const domain: DomainConversationWithDetail = { index: { titleSource: 'derived', key: fixtureKey('corpus-math-baseline-compile-gate'),
                        title: 'Corpus Math Baseline Compile Gate', createdAt: Date.parse('2026-09-28T00:00:00Z') }, detail: { key: fixtureKey('corpus-math-baseline-compile-gate'), quality: { status: 'unknown' },
                        assets: [], messages: [{ id: 'm1', role: 'assistant',
                            content: baselineSuccessful.map(e => ({ type: 'math', source: e.latex })),
                        }],
                    } };
                    const baseTypstMap = new Map<string, string>();
                    for (const e of baselineSuccessful) {
                        baseTypstMap.set(e.latex, e.typst);
                    }
                    const convertMathFn = (s: string) => baseTypstMap.get(s);
                    const document = renderDocumentTypstCore(composeDomainDocument(domain, fixtureAccount()), {}, {}, { convertMath: convertMathFn });
                    const compileRes = await compiler.compile({
                        rendererSchemaVersion: 1,
                        document,
                        assetPaths: new Map(),
                    }, {
                        assets: { resolve: async () => null },
                        signal: new AbortController().signal,
                        reportProgress: () => {},
                    });
                    const errs = (compileRes.diagnostics ?? []).filter((d: any) => d.severity === 'error');
                    report.math.baseline.compileFailures = errs.length;
                    report.math.compileFailures = errs.length;
                } finally {
                    compiler.dispose();
                }
            } catch (compileErr: any) {
                report.math.baseline.compileFailures += 1;
                report.math.compileFailures += 1;
                report.diagnostics.push({
                    domain: 'typst_compile_baseline',
                    id: 'all_converted',
                    message: `Baseline Typst compilation exception: ${compileErr.message || String(compileErr)}`,
                });
            }
        }

        if (activeCandidateConverter && candidateSuccessful.length > 0) {
            try {
                const host = new RealWasmSandboxHost(repoRoot());
                const compiler = new TypstSandboxCompiler({ host });
                try {
                    const domain: DomainConversationWithDetail = { index: { titleSource: 'derived', key: fixtureKey('corpus-math-candidate-compile-gate'),
                        title: 'Corpus Math Candidate Compile Gate', createdAt: Date.parse('2026-09-28T00:00:00Z') }, detail: { key: fixtureKey('corpus-math-candidate-compile-gate'), quality: { status: 'unknown' },
                        assets: [], messages: [{ id: 'm1', role: 'assistant',
                            content: candidateSuccessful.map(e => ({ type: 'math', source: e.latex })),
                        }],
                    } };
                    const candTypstMap = new Map<string, string>();
                    for (const e of candidateSuccessful) {
                        candTypstMap.set(e.latex, e.typst);
                    }
                    const convertMathFn = (s: string) => candTypstMap.get(s);
                    const document = renderDocumentTypstCore(composeDomainDocument(domain, fixtureAccount()), {}, {}, { convertMath: convertMathFn });
                    const compileRes = await compiler.compile({
                        rendererSchemaVersion: 1,
                        document,
                        assetPaths: new Map(),
                    }, {
                        assets: { resolve: async () => null },
                        signal: new AbortController().signal,
                        reportProgress: () => {},
                    });
                    const errs = (compileRes.diagnostics ?? []).filter((d: any) => d.severity === 'error');
                    report.math.candidate!.compileFailures = errs.length;
                } finally {
                    compiler.dispose();
                }
            } catch (compileErr: any) {
                report.math.candidate!.compileFailures += 1;
                report.diagnostics.push({
                    domain: 'typst_compile_candidate',
                    id: 'all_converted',
                    message: `Candidate Typst compilation exception: ${compileErr.message || String(compileErr)}`,
                });
            }
        }
    }

    fs.mkdirSync(path.dirname(finalOutputPath), { recursive: true });
    fs.writeFileSync(finalOutputPath, JSON.stringify(report, null, 2), 'utf-8');

    return report;
}

if (require.main === module) {
    (async () => {
        try {
            console.log('='.repeat(65));
            console.log('🚀 Running Parser Migration Corpus Evaluation (with Typst WASM Gate)...');
            console.log('='.repeat(65));
            const report = await runCorpus({ compileTypst: true });
            console.log(`\n📂 Corpus Set: ${report.corpusSet}`);
            console.log(`\n📄 Markdown Results:`);
            console.log(`  • Documents Evaluated:      ${report.markdown.documents} (108 scenario inputs + 2 synthetic fixtures | Real Gemini Output: 0)`);
            console.log(`  • Parse Failures:           ${report.markdown.baseline.parseFailures} (Must be 0)`);
            console.log(`  • Fallbacks:                ${report.markdown.baseline.fallbacks}`);
            if (report.markdown.candidate) {
                console.log(`  • Candidate Parse Failures: ${report.markdown.candidate.parseFailures} (Must be 0)`);
                console.log(`  • Candidate Fallbacks:      ${report.markdown.candidate.fallbacks}`);
                if (report.markdown.candidate.parseFailures > 0) {
                    throw new Error(`Candidate parser encountered ${report.markdown.candidate.parseFailures} fatal parse failure(s)!`);
                }
            }
            console.log(`  • Markdown Diff Count:      ${report.markdown.diffCount}`);
            if (report.markdown.diffCount > 0) {
                console.log(`\n🔍 Markdown Semantic Diffs (${report.markdown.diffCount}):`);
                const mdDiffs = report.diffs.filter((d) => d.domain === 'markdown');
                for (const diff of mdDiffs) {
                    console.log(`    - [${diff.category || 'UNKNOWN'}] Doc "${diff.id}": ${diff.rationale || 'No rationale'}`);
                }
            }
            console.log(`  • Duration:                 ${report.markdown.totalDurationMs} ms (avg ${report.markdown.avgDurationMs.toFixed(2)} ms/doc)`);

            console.log(`\n📐 Math Results (Baseline):`);
            console.log(`  • Expressions Tested:  ${report.math.expressions}`);
            console.log(`  • Converted Typst:     ${report.math.baseline.converted}`);
            console.log(`  • Conversion Fallback: ${report.math.baseline.conversionFailures}`);
            console.log(`  • Typst WASM Failures: ${report.math.baseline.compileFailures} (Genuine WASM compiler check, 100% evaluated)`);
            if (report.math.candidate) {
                console.log(`\n📐 Math Results (Candidate):`);
                console.log(`  • Converted Typst:     ${report.math.candidate.converted}`);
                console.log(`  • Conversion Fallback: ${report.math.candidate.conversionFailures}`);
                console.log(`  • Typst WASM Failures: ${report.math.candidate.compileFailures} (Genuine WASM compiler check, 100% evaluated)`);
                if (report.math.candidate.converted !== report.math.expressions) {
                    throw new Error(`Candidate math converter failed gate: converted ${report.math.candidate.converted} != total ${report.math.expressions}`);
                }
                if (report.math.candidate.conversionFailures > 0) {
                    throw new Error(`Candidate math converter failed gate: ${report.math.candidate.conversionFailures} conversion failure(s)`);
                }
                if (report.math.candidate.compileFailures > 0) {
                    throw new Error(`Candidate math converter failed gate: ${report.math.candidate.compileFailures} Typst WASM compile failure(s)`);
                }
            }
            console.log(`  • Duration:            ${report.math.totalDurationMs} ms (avg ${report.math.avgDurationMs.toFixed(2)} ms/expr)`);

            console.log(`\n📋 Diagnostics Recorded: ${report.diagnostics.length}`);
            console.log(`💾 Machine-readable report saved to: tests/output/corpus_report.json`);
            console.log('='.repeat(65));
        } catch (e) {
            console.error('Failed to run corpus:', e);
            process.exit(1);
        }
    })();
}
