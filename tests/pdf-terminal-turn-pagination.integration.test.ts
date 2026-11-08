/** Real Typst/WASM pagination regression; intentionally outside isolated L4 units. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DisplayBlock } from '../src/l3b/ast/ast.js';
import { compileDocumentPdf } from '../src/l4/format/pdf/compileDocumentPdf.js';
import { TypstSandboxCompiler } from '../src/l4/format/pdf/typst/typstSandboxCompiler.js';
import { v2Document } from './helpers/l4V2Fixtures.js';
import { probePdfLayout } from './helpers/pdfPageProbe.js';
import { RealWasmSandboxHost, repoRoot } from './helpers/realWasmSandbox.js';

const question = 'FINAL QUESTION: Summarize the drainage recommendation in one sentence.';
const answer = 'FINAL ANSWER: Buffer normal peaks and degrade safely when storage is full.';
const paragraph = (text: string): DisplayBlock => ({ type: 'paragraph', children: [{ type: 'text', text }] });

// Reduced from the observed last-turn shape in the Green Roof export: a short
// user bubble followed by one line of prose. Use normal document flow, the
// production page size and bundled fonts; no page breaks or template patches.
test('a short terminal question and answer stay together instead of creating a nearly empty final page', async t => {
    const compiler = new TypstSandboxCompiler({ host: new RealWasmSandboxHost(repoRoot()) });
    const output = join(repoRoot(), 'tests/output/pdf-terminal-turn-pagination');
    mkdirSync(output, { recursive: true });
    try {
        for (const count of [15, 16]) {
            await t.test(`${count} background paragraphs (${count === 15 ? 'control' : 'page-boundary regression'})`, async () => {
                const background = Array.from({ length: count }, (_, index) =>
                    `Background ${index + 1}. ` + 'Drainage capacity follows measured rainfall and retained storage. '.repeat(3));
                const document = v2Document(background.map(paragraph));
                document.messages.push(
                    { role: 'user', blocks: [paragraph(question)] },
                    { role: 'assistant', blocks: [paragraph(answer)] },
                );
                const result = await compileDocumentPdf(document, {}, new Map(), compiler, {
                    signal: new AbortController().signal, reportProgress() {},
                });
                // Preserve physical output even when the layout assertion fails.
                writeFileSync(join(output, `${count}-paragraphs.pdf`), result.pdfBytes);
                assert.equal(result.diagnostics.some(d => d.severity === 'error'), false);
                const pages = probePdfLayout(result.pdfBytes).pages;
                const text = pages.map(page => page.text).join('').replace(/\s/g, '');
                for (const expected of [...background, question, answer]) {
                    assert.ok(text.includes(expected.replace(/\s/g, '')), 'pagination must preserve all authored content');
                }
                const questionPage = pages.findIndex(page => page.text.includes('FINAL QUESTION'));
                const answerPage = pages.findIndex(page => page.text.includes('FINAL ANSWER'));
                assert.ok(questionPage >= 0 && answerPage >= 0, 'locate both terminal messages in physical PDF');
                const last = pages.at(-1);
                assert.ok(last);
                const bodyRuns = last.runs.filter(run => run.size > 7); // Exclude the 6.8pt page number.
                const baselines = new Set(bodyRuns.map(run => run.y.toFixed(1)));
                t.diagnostic(JSON.stringify({ pages: pages.length, questionPage: questionPage + 1,
                    answerPage: answerPage + 1, finalBodyLines: baselines.size,
                    finalBodyExtentPt: bodyRuns.length ? Math.max(...bodyRuns.map(run => run.y)) - Math.min(...bodyRuns.map(run => run.y)) : 0 }));
                // A one-line answer and its short question fit easily on a fresh
                // page. Moving the question with it avoids an answer-only tail
                // without forbidding legitimate sparse pages for other content.
                assert.equal(answerPage, questionPage,
                    `short terminal turn must share a page: question on page ${questionPage + 1}, answer on page ${answerPage + 1} (final page body: ${baselines.size} line(s))`);
            });
        }
    } finally { compiler.dispose(); }
});

// Keep-with-next must bind the boundary, never make whole conversations atomic.
test('question association preserves page filling and natural breaks in long questions and answers', async t => {
    const compiler = new TypstSandboxCompiler({ host: new RealWasmSandboxHost(repoRoot()) });
    try {
        for (const longRole of ['user', 'assistant'] as const) {
            await t.test(`long ${longRole} remains breakable`, async () => {
                const background = Array.from({ length: 8 }, (_, index) =>
                    `Background ${index + 1}. ` + 'Drainage capacity follows measured rainfall and retained storage. '.repeat(3));
                const long = Array.from({ length: 36 }, (_, index) =>
                    `Long ${longRole} section ${index + 1}. ` + 'Measured storage must retain the original evidence through each page boundary. '.repeat(3));
                const prompt = longRole === 'user' ? long : [question];
                const response = longRole === 'assistant' ? long : [answer];
                const document = v2Document(background.map(paragraph));
                document.messages.push({ role: 'user', blocks: prompt.map(paragraph) },
                    { role: 'assistant', blocks: response.map(paragraph) });
                const result = await compileDocumentPdf(document, {}, new Map(), compiler, {
                    signal: new AbortController().signal, reportProgress() {},
                });
                const output = join(repoRoot(), 'tests/output/pdf-terminal-turn-pagination');
                mkdirSync(output, { recursive: true });
                writeFileSync(join(output, `long-${longRole}.pdf`), result.pdfBytes);
                const pages = probePdfLayout(result.pdfBytes).pages;
                const compact = (text: string) => text.replace(/\s/g, '');
                const text = compact(pages.flatMap(page => page.runs.filter(run => run.size > 7).map(run => run.text)).join(''));
                for (const expected of [...background, ...prompt, ...response]) {
                    assert.ok(text.includes(compact(expected)), 'all long-form content remains present');
                }
                assert.ok(pages.length > 1, 'long message must still span pages');
                assert.ok(pages[0].text.includes(longRole === 'user' ? 'Long user section 1.' : 'FINAL QUESTION'),
                    'question must use the available first-page space, not move as one atomic block');
                if (longRole === 'assistant') {
                    assert.ok(pages[0].text.includes('Long assistant section 1.'),
                        'long answer must begin beside the question instead of moving wholesale');
                }
                for (const page of pages.slice(0, -1)) {
                    const bodyRuns = page.runs.filter(run => run.size > 7);
                    const lastBaseline = Math.min(...bodyRuns.map(run => run.y));
                    // A4's production body ends at 18mm (~51pt). Allow a quarter
                    // of the body for normal block boundaries; a half-empty page
                    // caused by keeping an entire long message together fails.
                    const bodyHeight = page.height - (18.5 + 18) * 72 / 25.4;
                    assert.ok(lastBaseline - 18 * 72 / 25.4 < bodyHeight / 4,
                        `page ${page.index + 1} has excessive unused space before a long ${longRole}`);
                }
            });
        }
    } finally { compiler.dispose(); }
});

test('a large image answer does not pull the question off a partially used page', async t => {
    const compiler = new TypstSandboxCompiler({ host: new RealWasmSandboxHost(repoRoot()) });
    try {
        for (const withIntro of [false, true]) {
            await t.test(withIntro ? 'paragraph attached to image' : 'image opening', async () => {
                const document = v2Document(Array.from({ length: 8 }, (_, index) => paragraph(
                    `Background ${index + 1}. ` + 'Drainage capacity follows measured rainfall and retained storage. '.repeat(3))));
                const blocks: DisplayBlock[] = [{ type: 'image', resourceId: 'figure', alt: 'Drainage diagram' }];
                if (withIntro) blocks.unshift(paragraph('The following diagram illustrates the drainage recommendation.'));
                document.messages.push({ role: 'user', blocks: [paragraph(question)] },
                    { role: 'assistant', blocks });
                const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
                const result = await compileDocumentPdf(document, { figure: 'assets/figure.png' },
                    new Map([['figure', { ok: true, resourceId: 'figure', value: { bytes } }]]), compiler, {
                        signal: new AbortController().signal, reportProgress() {},
                    });
                const output = join(repoRoot(), 'tests/output/pdf-terminal-turn-pagination');
                mkdirSync(output, { recursive: true });
                writeFileSync(join(output, withIntro ? 'image-with-intro-answer.pdf' : 'image-answer.pdf'), result.pdfBytes);
                const pages = probePdfLayout(result.pdfBytes).pages;
                assert.equal(pages.findIndex(page => page.text.includes('FINAL QUESTION')), 0,
                    'a figure that needs a new page must not drag the question with it');
                assert.ok(pages.some(page => page.index > 0 && page.imageDraws.length > 0), 'large figure is still delivered on a later page');
            });
        }
    } finally { compiler.dispose(); }
});
