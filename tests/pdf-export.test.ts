/**
 * tests/pdf-export.test.ts
 *
 * Tier 1 tests for the P3 PDF export feature (UI + batch orchestration).
 *
 * Covers the user's iron rules:
 * - success is ONLY marked after the Writer actually wrote the file
 * - a failed item is never marked successful and stays retryable
 * - one failure never blocks the rest of the batch
 * - cancel really stops: no partial writes, no finalize
 * - errors/diagnostics surface through onLog (Error page channel) and the result
 * - the stub compiler returns a parseable PDF
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { PdfExporter } = require('../src/core/export/pdf/index.js');
const { StubPdfCompiler, buildMinimalValidPdf } = require('./helpers/stubPdfCompiler.js');

const fixtureDir = path.join(__dirname, 'fixtures', 'canonical');
const sample = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'gemini-normalizer-sample.json'), 'utf8'));

function makeSample(idSuffix: string, title: string) {
    const c = JSON.parse(JSON.stringify(sample));
    c.id = `pdf-test-${idSuffix}`;
    c.title = title;
    return c;
}

function makeFakeWriter(opts?: { failOn?: (name: string) => boolean }) {
    const files: Array<{ name: string; bytes: Uint8Array }> = [];
    const writer = {
        files,
        written: 0,
        async writeFile(relativePath: string, content: any) {
            if (opts && opts.failOn && opts.failOn(relativePath)) {
                throw new Error('boom: simulated write failure');
            }
            const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(String(content));
            files.push({ name: relativePath, bytes });
            writer.written++;
            return relativePath;
        },
        async generateBlob() {
            return new Blob(files.map((f) => f.bytes as any), { type: 'application/zip' });
        },
    };
    return writer;
}

/**
 * Build a structurally valid minimal PDF with a real xref table.
 *
 * #587's verifier requires: %PDF- magic, at least one `endobj`, a `trailer`
 * (or /Root), and `startxref <offset> %%EOF` in the tail — and the startxref
 * offset is being tightened into a real pointer check, so the offsets here
 * are computed for real, never hardcoded. The size knob is the padding
 * inside a legal stream object, so different `padBytes` values yield
 * different-sized but equally valid PDFs.
 */
function makeValidPdf(padBytes: number): Uint8Array {
    const enc = new TextEncoder();
    const parts: string[] = [];
    let pos = 0;
    const push = (s: string): void => {
        parts.push(s);
        pos += enc.encode(s).length;
    };
    push('%PDF-1.4\n');
    const streamData = 'x'.repeat(padBytes);
    const objects: string[] = [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n',
        `4 0 obj\n<< /Length ${streamData.length} >>\nstream\n${streamData}\nendstream\nendobj\n`,
    ];
    const objOffsets: number[] = [];
    for (const obj of objects) {
        objOffsets.push(pos);
        push(obj);
    }
    const xrefPos = pos;
    push('xref\n');
    push(`0 ${objects.length + 1}\n`);
    push('0000000000 65535 f \n');
    for (const off of objOffsets) {
        push(`${String(off).padStart(10, '0')} 00000 n \n`);
    }
    push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`);
    push(`startxref\n${xrefPos}\n%%EOF`);
    return enc.encode(parts.join(''));
}

test('stub compiler returns a parseable minimal PDF', async () => {
    const compiler = new StubPdfCompiler();
    const { bundle } = await require('../src/core/export/canonical/index.js').normalizeGeminiConversation(sample);
    const ctx: any = {
        bundle,
        assets: { resolve: async () => null },
        locale: 'zh',
        signal: new AbortController().signal,
        reportProgress: () => {},
    };
    const { pdfBytes, diagnostics } = await compiler.compile(
        { rendererSchemaVersion: 1, sourceSchemaVersion: 1, bundle } as never,
        ctx
    );
    const text = new TextDecoder().decode(pdfBytes);
    assert.ok(text.startsWith('%PDF-'), 'starts with PDF magic');
    assert.ok(text.includes('trailer'), 'has a trailer');
    assert.ok(text.includes('%%EOF'), 'has EOF marker');
    assert.ok(diagnostics.some((d: any) => d.code === 'STUB_COMPILER_PLACEHOLDER'), 'stub marks its placeholder output');
});

test('success is only marked after the Writer actually wrote the file', async () => {
    const writer = makeFakeWriter();
    const exporter = new PdfExporter(new StubPdfCompiler());
    const exported: any[] = [];
    const logs: any[] = [];
    const result = await exporter.run(
        {
            selected: [{ id: sample.id, title: sample.title }],
            conversations: [sample],
            useZip: false,
            writer,
        },
        {
            onItemExported: (id: string, record: any) => exported.push({ id, record }),
            onLog: (msg: string, level?: string) => logs.push({ msg, level }),
        }
    );
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.succeeded, 1);
    assert.strictEqual(result.failed.length, 0);
    assert.strictEqual(result.aborted, false);
    // The one hard proof: a file landed in the writer.
    assert.strictEqual(writer.files.length, 1, 'exactly one file written');
    assert.ok(writer.files[0].name.endsWith('.pdf'), 'file is a .pdf');
    assert.ok(writer.files[0].bytes.length > 0, 'bytes are non-empty');
    // Exported record only exists because the write resolved.
    assert.strictEqual(exported.length, 1);
    assert.strictEqual(exported[0].record.status, 'ok');
    assert.strictEqual(exported[0].record.fileName, writer.files[0].name);
    assert.strictEqual(exported[0].record.bytesWritten, writer.files[0].bytes.length);
});

test('writer failure marks the item failed, never successful, and stays retryable', async () => {
    const writer = makeFakeWriter({ failOn: () => true });
    const exporter = new PdfExporter(new StubPdfCompiler());
    const exported: any[] = [];
    const logs: any[] = [];
    const result = await exporter.run(
        {
            selected: [{ id: sample.id, title: sample.title }],
            conversations: [sample],
            useZip: false,
            writer,
        },
        {
            onItemExported: (id: string, record: any) => exported.push({ id, record }),
            onLog: (msg: string, level?: string) => logs.push({ msg, level }),
        }
    );
    assert.strictEqual(result.succeeded, 0, 'nothing marked successful');
    assert.strictEqual(result.failed.length, 1, 'failure recorded');
    assert.strictEqual(result.failed[0].ok, false);
    assert.ok(result.failed[0].error, 'error reason present');
    assert.strictEqual(exported.length, 0, 'no export record for failed item');
    assert.ok(
        logs.some((l) => l.level === 'error' && l.msg.includes('失败')),
        'failure is visible on the onLog (Error page) channel'
    );
    // Retry: same item, healthy writer -> succeeds. Nothing about the failure is sticky.
    const retryWriter = makeFakeWriter();
    const retryExporter = new PdfExporter(new StubPdfCompiler());
    const retry = await retryExporter.run(
        {
            selected: [{ id: result.failed[0].id, title: result.failed[0].title }],
            conversations: [sample],
            useZip: false,
            writer: retryWriter,
        },
        {}
    );
    assert.strictEqual(retry.succeeded, 1, 'failed item is retryable');
    assert.strictEqual(retryWriter.files.length, 1);
});

test('one failed item does not block the rest of the batch', async () => {
    const bad = makeSample('bad', 'bad-title-will-fail');
    const good1 = makeSample('good1', 'good one');
    const good2 = makeSample('good2', 'good two');
    const writer = makeFakeWriter({ failOn: (name) => name.includes('bad-title-will-fail') });
    const exporter = new PdfExporter(new StubPdfCompiler());
    const result = await exporter.run(
        {
            selected: [bad, good1, good2].map((c) => ({ id: c.id, title: c.title })),
            conversations: [bad, good1, good2],
            useZip: false,
            writer,
        },
        {}
    );
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.succeeded, 2, 'other items still exported');
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].title, 'bad-title-will-fail');
    assert.strictEqual(writer.files.length, 2);
});

test('cancel stops the batch: no further compiles, no writes, no finalize', async () => {
    const slowCompiler = new StubPdfCompiler({ delayMs: 300 });
    const writer = makeFakeWriter();
    const exporter = new PdfExporter(new StubPdfCompiler());
    let downloads = 0;
    const progress: any[] = [];
    const convs = [1, 2, 3].map((n) => makeSample(`cancel-${n}`, `cancel ${n}`));
    const runPromise = exporter.run(
        {
            selected: convs.map((c) => ({ id: c.id, title: c.title })),
            conversations: convs,
            useZip: true,
            writer,
            compiler: slowCompiler,
            downloadHandler: async () => {
                downloads++;
            },
        },
        { onProgress: (p: any) => progress.push(p) }
    );
    // Cancel while the first compile is still in its artificial delay.
    await new Promise((r) => setTimeout(r, 50));
    exporter.abort();
    const result = await runPromise;
    assert.strictEqual(result.aborted, true, 'result reports aborted');
    assert.strictEqual(writer.files.length, 0, 'no partial file was written');
    assert.strictEqual(downloads, 0, 'no zip packaged/downloaded after cancel');
    assert.ok(progress.length > 0, 'progress was reported before cancel');
});

test('deterministic compile failure surfaces with diagnostics and stays retryable', async () => {
    const failing = new StubPdfCompiler({ failWith: 'typst error: unknown function `foo`' });
    const writer = makeFakeWriter();
    const exporter = new PdfExporter(new StubPdfCompiler());
    const logs: any[] = [];
    const result = await exporter.run(
        {
            selected: [{ id: sample.id, title: sample.title }],
            conversations: [sample],
            useZip: false,
            writer,
            compiler: failing,
        },
        { onLog: (msg: string, level?: string) => logs.push({ msg, level }) }
    );
    assert.strictEqual(result.succeeded, 0);
    assert.strictEqual(result.failed.length, 1);
    assert.ok(result.failed[0].error!.includes('unknown function'), 'compile error message preserved');
    assert.ok(logs.some((l) => l.level === 'error'), 'compile error logged, not swallowed');
    assert.strictEqual(writer.files.length, 0, 'failed compile writes nothing');
});

test('zip mode packages only after successful writes', async () => {
    const writer = makeFakeWriter();
    const exporter = new PdfExporter(new StubPdfCompiler());
    let downloaded: { name: string } | null = null;
    const result = await exporter.run(
        {
            selected: [{ id: sample.id, title: sample.title }],
            conversations: [sample],
            useZip: true,
            writer,
            downloadHandler: async (_blob: Blob, filename: string) => {
                downloaded = { name: filename };
            },
        },
        {}
    );
    assert.strictEqual(result.succeeded, 1);
    assert.ok(downloaded, 'zip download handler invoked');
    assert.ok((downloaded as any).name.endsWith('.zip'));
    assert.strictEqual(writer.files.length, 1, 'the pdf itself was written to the zip writer');
});

test('zip: generateBlob failure never reports success and commits no records (§1)', async () => {
    const writer = makeFakeWriter();
    (writer as any).generateBlob = async () => {
        throw new Error('boom: simulated blob failure');
    };
    const exporter = new PdfExporter(new StubPdfCompiler());
    const exported: any[] = [];
    const logs: any[] = [];
    let downloads = 0;
    const result = await exporter.run(
        {
            selected: [{ id: sample.id, title: sample.title }],
            conversations: [sample],
            useZip: true,
            writer,
            downloadHandler: async () => {
                downloads++;
            },
        },
        {
            onItemExported: (id: string, record: any) => exported.push({ id, record }),
            onLog: (msg: string, level?: string) => logs.push({ msg, level }),
        }
    );
    assert.strictEqual(result.succeeded, 0, 'no success without ZIP delivery');
    assert.strictEqual(result.failed.length, 1, 'staged item reported as failed, retryable');
    assert.ok(
        result.failed[0].error!.includes('zip finalize/delivery failed'),
        'failure reason names the finalize step'
    );
    assert.strictEqual(exported.length, 0, 'no success records committed');
    assert.strictEqual(downloads, 0, 'nothing delivered to the user');
    assert.strictEqual(writer.files.length, 1, 'the pdf was staged before finalize failed');
    assert.ok(logs.some((l) => l.level === 'error'), 'finalize failure logged, not swallowed');
});

test('zip: downloadHandler failure never reports success and commits no records (§1)', async () => {
    const writer = makeFakeWriter();
    const exporter = new PdfExporter(new StubPdfCompiler());
    const exported: any[] = [];
    const result = await exporter.run(
        {
            selected: [{ id: sample.id, title: sample.title }],
            conversations: [sample],
            useZip: true,
            writer,
            downloadHandler: async () => {
                throw new Error('boom: simulated download failure');
            },
        },
        {
            onItemExported: (id: string, record: any) => exported.push({ id, record }),
        }
    );
    assert.strictEqual(result.succeeded, 0, 'no success without ZIP delivery');
    assert.strictEqual(result.failed.length, 1);
    assert.ok(result.failed[0].error!.includes('zip finalize/delivery failed'));
    assert.strictEqual(exported.length, 0, 'no success records committed');
});

test('zip: success records are committed only after delivery, in item order (§1)', async () => {
    const writer = makeFakeWriter();
    const exporter = new PdfExporter(new StubPdfCompiler());
    const events: string[] = [];
    const convs = [1, 2].map((n) => makeSample(`ord-${n}`, `ord ${n}`));
    const result = await exporter.run(
        {
            selected: convs.map((c) => ({ id: c.id, title: c.title })),
            conversations: convs,
            useZip: true,
            writer,
            downloadHandler: async () => {
                events.push('delivered');
            },
        },
        {
            onItemExported: (id: string) => events.push(`record:${id}`),
        }
    );
    assert.strictEqual(result.succeeded, 2);
    assert.strictEqual(result.failed.length, 0);
    assert.deepStrictEqual(
        events,
        ['delivered', 'record:pdf-test-ord-1', 'record:pdf-test-ord-2'],
        'records committed after delivery, in item order'
    );
});

test('zip: missing generateBlob on the writer fails closed, never reports success (§1)', async () => {
    const writer = makeFakeWriter();
    delete (writer as any).generateBlob;
    const exporter = new PdfExporter(new StubPdfCompiler());
    const exported: any[] = [];
    const result = await exporter.run(
        {
            selected: [{ id: sample.id, title: sample.title }],
            conversations: [sample],
            useZip: true,
            writer,
            downloadHandler: async () => {},
        },
        {
            onItemExported: (id: string, record: any) => exported.push({ id, record }),
        }
    );
    assert.strictEqual(result.succeeded, 0, 'cannot finalize => cannot succeed');
    assert.strictEqual(result.failed.length, 1);
    assert.ok(result.failed[0].error!.includes('generateBlob is not available'));
    assert.strictEqual(exported.length, 0, 'no success records committed');
});

test('zip: missing downloadHandler fails closed, never counts staged as delivered', async () => {
    const writer = makeFakeWriter();
    const exporter = new PdfExporter(new StubPdfCompiler());
    const exported: any[] = [];
    const logs: any[] = [];
    const result = await exporter.run(
        {
            selected: [{ id: sample.id, title: sample.title }],
            conversations: [sample],
            useZip: true,
            writer,
            // NOTE: no downloadHandler — the ZIP could never reach the user.
        },
        {
            onItemExported: (id: string, record: any) => exported.push({ id, record }),
            onLog: (msg: string, level?: string) => logs.push({ msg, level }),
        }
    );
    assert.strictEqual(result.succeeded, 0, 'no delivery possible => no success');
    assert.strictEqual(result.failed.length, 1, 'item reported as failed, retryable');
    assert.ok(result.failed[0].error!.includes('requires downloadHandler'), 'failure names the missing handler');
    assert.strictEqual(exported.length, 0, 'no success records committed');
    assert.strictEqual(writer.files.length, 0, 'fails fast: nothing staged, nothing wasted');
    assert.ok(logs.some((l) => l.level === 'error'), 'configuration error logged, not swallowed');
});

test('§11: export-record persistence failure keeps the artifact successful but warns loudly', async () => {
    const writer = makeFakeWriter();
    const exporter = new PdfExporter(new StubPdfCompiler());
    const logs: any[] = [];
    const result = await exporter.run(
        {
            selected: [{ id: sample.id, title: sample.title }],
            conversations: [sample],
            useZip: false,
            writer,
        },
        {
            onItemExported: () => {
                throw new Error('boom: simulated record-store failure');
            },
            onLog: (msg: string, level?: string) => logs.push({ msg, level }),
        }
    );
    assert.strictEqual(result.succeeded, 1, 'artifact success is NOT flipped by a record-write failure');
    assert.strictEqual(result.failed.length, 0);
    assert.ok(
        logs.some((l) => l.level === 'warn' && l.msg.includes('EXPORT_RECORD_WRITE_FAILED')),
        'EXPORT_RECORD_WRITE_FAILED warning is visible, not swallowed'
    );
});

test('§11 (zip): record failure during delivery commit keeps staged items delivered', async () => {
    const writer = makeFakeWriter();
    const exporter = new PdfExporter(new StubPdfCompiler());
    const logs: any[] = [];
    const result = await exporter.run(
        {
            selected: [{ id: sample.id, title: sample.title }],
            conversations: [sample],
            useZip: true,
            writer,
            downloadHandler: async () => {},
        },
        {
            onItemExported: () => {
                throw new Error('boom: simulated record-store failure');
            },
            onLog: (msg: string, level?: string) => logs.push({ msg, level }),
        }
    );
    assert.strictEqual(result.succeeded, 1, 'delivered items stay successful');
    assert.strictEqual(result.failed.length, 0);
    assert.ok(
        logs.some((l) => l.level === 'warn' && l.msg.includes('EXPORT_RECORD_WRITE_FAILED')),
        'EXPORT_RECORD_WRITE_FAILED warning is visible on the zip path too'
    );
});

test('warning diagnostics propagate to the visible log channel, not swallowed', async () => {
    const writer = makeFakeWriter();
    const warningCompiler = {
        name: 'warning-test-compiler',
        async compile(_payload: any, _context: any) {
            return {
                // Must pass the pipeline's structural PDF verification
                // (real xref table + startxref pointer, built not hand-written).
                pdfBytes: buildMinimalValidPdf(),
                diagnostics: [{ severity: 'warning', code: 'TEST_COMPILE_WARN', message: 'synthetic warning' }],
            };
        },
    };
    const exporter = new PdfExporter(new StubPdfCompiler());
    const logs: any[] = [];
    const result = await exporter.run(
        {
            selected: [{ id: sample.id, title: sample.title }],
            conversations: [sample],
            useZip: false,
            writer,
            compiler: warningCompiler,
        },
        { onLog: (msg: string, level?: string) => logs.push({ msg, level }) }
    );
    assert.strictEqual(result.succeeded, 1);
    assert.ok(
        logs.some((l) => l.level === 'warn' && l.msg.includes('TEST_COMPILE_WARN')),
        'compile warning surfaced through onLog (Error page channel)'
    );
});

test('result carries UI-contract aliases so failures are visible to the summary/banner/retry flow', async () => {
    const failing = new StubPdfCompiler({ failWith: 'boom: conv fail' });
    const writer = makeFakeWriter();
    const exporter = new PdfExporter(new StubPdfCompiler());
    const result = await exporter.run(
        {
            selected: [{ id: sample.id, title: sample.title }],
            conversations: [sample],
            useZip: false,
            writer,
            compiler: failing,
        },
        {}
    );
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failedChats!.length, 1, 'failedChats alias present');
    assert.strictEqual(result.failedChats![0].id, sample.id, 'banner/retry can reselect by id');
    assert.strictEqual(result.landedChats, 0);
    assert.strictEqual(result.exportedCount, 0);
});

test('abort marks unfinished items as failed/retryable instead of silently dropping them', async () => {
    const slowCompiler = new StubPdfCompiler({ delayMs: 300 });
    const writer = makeFakeWriter();
    const exporter = new PdfExporter(new StubPdfCompiler());
    const convs = [1, 2, 3].map((n) => makeSample(`abort-${n}`, `abort ${n}`));
    const runPromise = exporter.run(
        {
            selected: convs.map((c) => ({ id: c.id, title: c.title })),
            conversations: convs,
            useZip: false,
            writer,
            compiler: slowCompiler,
        },
        {}
    );
    await new Promise((r) => setTimeout(r, 50));
    exporter.abort();
    const result = await runPromise;
    assert.strictEqual(result.aborted, true);
    assert.strictEqual(result.succeeded, 0);
    assert.strictEqual(result.failed.length, 3, 'every unfinished item reported, none silently dropped');
    assert.ok(
        result.failed.every((f: any) => f.error!.includes('aborted before completion')),
        'abort reason is explicit and retryable'
    );
    assert.strictEqual(result.failedChats!.length, 3, 'UI aliases stay consistent on abort');
});

test('zip: per-item records carry each PDF\'s own size, never the ZIP size (#585)', async () => {
    const writer = makeFakeWriter();
    const exporter = new PdfExporter(new StubPdfCompiler());
    const exported: any[] = [];
    let delivered: { blob: Blob; filename: string } | null = null;
    // Compiler returns a different-sized PDF per conversation id.
    const sizedCompiler = {
        name: 'sized-test-compiler',
        async compile(payload: any, _context: any) {
            const convId = payload?.bundle?.conversation?.key?.conversationId ?? '';
            const pad = convId.includes('szBig') ? 5000 : 500;
            // A structurally valid PDF (real xref table + trailer + startxref
            // pointer); the size difference lives inside a legal stream object.
            return { pdfBytes: makeValidPdf(pad), diagnostics: [] };
        },
    };
    const convSmall = makeSample('szSmall', 'small chat');
    const convBig = makeSample('szBig', 'big chat');
    const result = await exporter.run(
        {
            selected: [convSmall, convBig].map((c) => ({ id: c.id, title: c.title })),
            conversations: [convSmall, convBig],
            useZip: true,
            writer,
            compiler: sizedCompiler,
            downloadHandler: async (blob: Blob, filename: string) => {
                delivered = { blob, filename };
            },
        },
        {
            onItemExported: (id: string, record: any) => exported.push({ id, record }),
        }
    );
    assert.strictEqual(result.succeeded, 2);
    assert.strictEqual(exported.length, 2);
    assert.ok(delivered, 'zip was delivered');
    const zipSize = (delivered as any).blob.size;
    const recSmall = exported.find((e) => e.id === convSmall.id)!.record;
    const recBig = exported.find((e) => e.id === convBig.id)!.record;
    // Each record describes its OWN pdf: different sizes, matching the staged files.
    const stagedSmall = writer.files.find((f) => f.name.includes('small'));
    const stagedBig = writer.files.find((f) => f.name.includes('big'));
    if (!stagedSmall || !stagedBig) throw new Error('both pdfs were staged in the writer');
    assert.strictEqual(recSmall.fileName, stagedSmall.name);
    assert.strictEqual(recBig.fileName, stagedBig.name);
    assert.strictEqual(recSmall.bytesWritten, stagedSmall.bytes.length);
    assert.strictEqual(recBig.bytesWritten, stagedBig.bytes.length);
    assert.ok(recBig.bytesWritten > recSmall.bytesWritten, 'records reflect per-PDF sizes');
    assert.ok(
        recSmall.bytesWritten < zipSize && recBig.bytesWritten < zipSize,
        'no item record carries the whole-ZIP size'
    );
    // The ZIP artifact itself is the batch-level delivery proof — on the
    // result, not on any item record.
    assert.ok(result.zipDelivery, 'batch result carries the ZIP delivery proof');
    assert.strictEqual(result.zipDelivery!.fileName, (delivered as any).filename);
    assert.strictEqual(result.zipDelivery!.bytesWritten, zipSize);
    assert.ok(result.zipDelivery!.deliveredAt, 'delivery timestamp present');
});
