/**
 * tests/pdf-e2e-disk.test.ts
 *
 * Item 6 (P0): the true end-to-end PDF disk-write happy path.
 *
 * Everything before this test stopped at "compiler returns bytes" or used a
 * fake in-memory writer. This test drives the REAL production path:
 *
 *   PdfExporter -> pipeline (project/resource/payload/compile/deliver) ->
 *   real Writer (FsWriter / ZipWriter, NOT mocked) -> real bytes on disk in a
 *   temp directory -> reopen from disk and verify.
 *
 * - Single export (useZip: false): real FsWriter (via createWriter('fs'))
 *   over a Node-backed FileSystemDirectoryHandle adapter writing into a temp
 *   dir. Only the browser platform API is adapted; the Writer itself is real.
 * - Batch ZIP (useZip: true, 3 conversations): real ZipWriter (via
 *   createWriter('zip')); the downloadHandler (the production delivery
 *   endpoint) writes the delivered blob to a temp dir; the ZIP is reopened
 *   with JSZip and every PDF re-verified.
 *
 * The compiler is a test-local IPdfCompiler with a distinct name (not the
 * stub) that emits structurally valid PDFs — real xref table + startxref
 * pointer + trailer + %%EOF, so the pipeline's own compile-stage structural
 * verification accepts them — embedding the conversation title and flattened
 * message text. Text is extracted back with the repo's own
 * tests/helpers/pdfTextExtract.ts helper.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PdfExporter } = require('../src/core/export/pdf/index.js');
const { createWriter } = require('../src/core/engine/writers/writerInterface.js');
const { extractPdfText } = require('./helpers/pdfTextExtract.js');

// Production serves JSZip from lib/jszip.min.js as a page global; mirror that
// here so the REAL ZipWriter resolves its dependency the same way.
(globalThis as any).self = (globalThis as any).self || {};
(globalThis as any).self.JSZip = require('../lib/jszip.min.js');
const JSZip = (globalThis as any).self.JSZip;

const fixtureDir = path.join(__dirname, 'fixtures', 'canonical');
const sample = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'gemini-normalizer-sample.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeSample(idSuffix: string, title: string, marker?: string) {
    const c = JSON.parse(JSON.stringify(sample));
    c.id = `pdf-e2e-disk-${idSuffix}`;
    c.title = title;
    if (marker) {
        // Distinct body text per conversation so per-PDF text correctness is
        // verifiable (flows through the real normalizer into the bundle).
        for (const m of c.messages) {
            if (typeof m.content === 'string') {
                m.content = `${m.content}\n\n${marker}\n`;
            }
        }
    }
    return c;
}

/** Recursively collect plain text from canonical bundle inline/block nodes. */
function flattenText(node: any): string {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(flattenText).join(' ');
    if (typeof node === 'object') {
        if (typeof node.text === 'string') return node.text;
        if (Array.isArray(node.children)) return node.children.map(flattenText).join('');
    }
    return '';
}

function bundleBodyText(bundle: any, maxLen = 600): string {
    const msgs = bundle?.conversation?.messages ?? [];
    const parts: string[] = [];
    for (const m of msgs) {
        for (const b of m?.blocks ?? []) parts.push(flattenText(b));
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function escapePdfLiteral(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Build a structurally valid minimal PDF (real xref offsets, startxref
 * pointer, trailer, %%EOF) whose content stream shows the given title and
 * body text with WinAnsi (Helvetica) text operators.
 */
function buildTextPdf(title: string, body: string): Uint8Array {
    const enc = new TextEncoder();
    const content = [
        'BT /F1 24 Tf 72 720 Td',
        `(${escapePdfLiteral(title)}) Tj`,
        '0 -36 Td',
        '/F1 12 Tf',
        `(${escapePdfLiteral(body)}) Tj`,
        'ET',
    ].join('\n');
    const contentBytes = enc.encode(content);
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let bodyOut = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((dict, i) => {
        offsets.push(enc.encode(bodyOut).length);
        bodyOut += `${i + 1} 0 obj\n${dict}\nendobj\n`;
    });
    const xrefOffset = enc.encode(bodyOut).length;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
    const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    return enc.encode(bodyOut + xref + trailer);
}

/** Test-local compiler (NOT the stub): embeds title + text into a real PDF. */
class TitleTextPdfCompiler {
    readonly name = 'title-text-test-compiler';
    async compile(payload: any, _context: any) {
        const title =
            payload?.document?.title ??
            payload?.bundle?.conversation?.title ??
            'untitled';
        const body = bundleBodyText(payload?.bundle);
        return { pdfBytes: buildTextPdf(String(title), body), diagnostics: [] };
    }
}

// ---------------------------------------------------------------------------
// Node-backed FileSystemDirectoryHandle adapter for the REAL FsWriter.
// Only the browser platform API is adapted; FsWriter itself is untouched.
// ---------------------------------------------------------------------------

function makeNodeDirHandle(absDir: string): any {
    return {
        name: path.basename(absDir),
        kind: 'directory',
        queryPermission: async () => 'granted',
        getDirectoryHandle: async (name: string, opts?: any) => {
            const sub = path.join(absDir, name);
            if (opts && opts.create) fs.mkdirSync(sub, { recursive: true });
            if (!fs.existsSync(sub)) throw new Error(`directory not found: ${sub}`);
            return makeNodeDirHandle(sub);
        },
        getFileHandle: async (name: string, opts?: any) => {
            const filePath = path.join(absDir, name);
            if (opts && opts.create) {
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.closeSync(fs.openSync(filePath, 'a'));
            }
            if (!fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
            return {
                kind: 'file',
                name,
                createWritable: async () => ({
                    write: async (content: any) => {
                        const buf =
                            content instanceof Uint8Array
                                ? Buffer.from(content)
                                : typeof content === 'string'
                                  ? Buffer.from(content, 'utf8')
                                  : Buffer.from(await content.arrayBuffer());
                        fs.writeFileSync(filePath, buf);
                    },
                    close: async () => {},
                    abort: async () => {},
                }),
            };
        },
    };
}

function freshTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function pdfFilesRecursive(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...pdfFilesRecursive(p));
        else if (e.name.endsWith('.pdf')) out.push(p);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Single export: PdfExporter -> real FsWriter -> real file on disk
// ---------------------------------------------------------------------------

test('e2e-disk: single PDF export lands a real, parseable file on disk', async () => {
    const tmp = freshTempDir('pdf-e2e-disk-single-');
    try {
        const title = 'E2E Disk Single Chat';
        const conv = makeSample('single', title);
        // Real writer, not a mock: createWriter('fs') + Node dirHandle adapter.
        const writer = createWriter('fs', {
            dirHandle: makeNodeDirHandle(tmp),
            folderName: 'gemini_export',
        });
        assert.strictEqual(writer.constructor.name, 'FsWriter', 'must be the real FsWriter');

        const exporter = new PdfExporter(new TitleTextPdfCompiler() as any);
        const exported: any[] = [];
        const result = await exporter.run(
            {
                selected: [{ id: conv.id, title: conv.title }],
                conversations: [conv],
                useZip: false,
                writer,
            },
            { onItemExported: (id: string, record: any) => exported.push({ id, record }) }
        );

        assert.strictEqual(result.total, 1);
        assert.strictEqual(result.succeeded, 1, 'export must succeed');
        assert.strictEqual(result.failed.length, 0);

        // The proof: a real file on a real disk, found via the filesystem.
        const pdfs = pdfFilesRecursive(tmp);
        assert.strictEqual(pdfs.length, 1, `exactly one PDF on disk, got: ${pdfs.join(', ')}`);
        const pdfPath = pdfs[0];
        const stat = fs.statSync(pdfPath);
        assert.ok(stat.size > 0, 'file is non-empty');
        const bytes = fs.readFileSync(pdfPath);
        assert.ok(
            bytes.slice(0, 5).toString('latin1') === '%PDF-',
            'file starts with the %PDF- magic header'
        );

        // Reopen and parse: title + conversation text must be inside.
        const extracted = extractPdfText(new Uint8Array(bytes));
        assert.ok(extracted.pageCount >= 1, 'PDF has at least one page');
        assert.ok(
            extracted.text.includes(title),
            `PDF text contains the conversation title ${JSON.stringify(title)}`
        );
        assert.ok(
            extracted.text.includes('Shopping list'),
            'PDF text contains conversation body text from the fixture'
        );
        assert.ok(extracted.text.includes('milk'), 'PDF text contains body detail text');

        // The export record points at the file that actually landed.
        assert.strictEqual(exported.length, 1);
        assert.strictEqual(exported[0].record.status, 'ok');
        assert.ok(
            (exported[0].record.fileName as string).endsWith('.pdf'),
            'record names the delivered PDF'
        );
        assert.strictEqual(exported[0].record.bytesWritten, stat.size, 'record size matches disk size');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Batch ZIP: PdfExporter -> real ZipWriter -> downloadHandler writes the ZIP
// to disk -> reopen with JSZip, every PDF re-verified
// ---------------------------------------------------------------------------

test('e2e-disk: batch ZIP of 3 conversations lands a real ZIP with 3 parseable PDFs', async () => {
    const tmp = freshTempDir('pdf-e2e-disk-zip-');
    try {
        const specs = [
            { suffix: 'batch-a', title: 'E2E Batch Chat Alpha', marker: 'UNIQUE-MARKER-ALPHA-7f3a' },
            { suffix: 'batch-b', title: 'E2E Batch Chat Beta', marker: 'UNIQUE-MARKER-BETA-9c1e' },
            { suffix: 'batch-c', title: 'E2E Batch Chat Gamma', marker: 'UNIQUE-MARKER-GAMMA-42bd' },
        ];
        const conversations = specs.map((s) => makeSample(s.suffix, s.title, s.marker));

        // Real writer, not a mock.
        const writer = createWriter('zip', { folderName: 'gemini_export' });
        assert.strictEqual(writer.constructor.name, 'ZipWriter', 'must be the real ZipWriter');

        let delivered: { blob: Blob; filename: string } | null = null;
        const exporter = new PdfExporter(new TitleTextPdfCompiler() as any);
        const result = await exporter.run(
            {
                selected: conversations.map((c) => ({ id: c.id, title: c.title })),
                conversations,
                useZip: true,
                writer,
                // The production delivery endpoint: in the browser this triggers
                // the download; here it writes the delivered bytes to disk.
                downloadHandler: async (blob: Blob, filename: string) => {
                    const buf = Buffer.from(await blob.arrayBuffer());
                    fs.writeFileSync(path.join(tmp, filename), buf);
                    delivered = { blob, filename };
                },
            },
            {}
        );

        assert.strictEqual(result.total, 3);
        assert.strictEqual(result.succeeded, 3, 'all 3 exports must succeed');
        assert.strictEqual(result.failed.length, 0);
        assert.ok(delivered, 'ZIP was delivered through downloadHandler');
        assert.ok(result.zipDelivery, 'result carries the ZIP delivery proof');

        // The proof: a real ZIP file on disk.
        const zipPath = path.join(tmp, (delivered as any).filename);
        assert.ok(fs.existsSync(zipPath), 'ZIP file exists on disk');
        const zipStat = fs.statSync(zipPath);
        assert.ok(zipStat.size > 0, 'ZIP is non-empty');
        assert.strictEqual(
            result.zipDelivery!.bytesWritten,
            zipStat.size,
            'delivery proof size matches the ZIP on disk'
        );

        // Reopen the ZIP and verify every entry.
        const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
        const pdfEntries = Object.values(zip.files).filter(
            (f: any) => !f.dir && f.name.endsWith('.pdf')
        ) as any[];
        assert.strictEqual(pdfEntries.length, 3, `ZIP contains 3 PDFs, got: ${pdfEntries.map((f) => f.name).join(', ')}`);

        const seenMarkers = new Set<string>();
        for (const entry of pdfEntries) {
            const data: Uint8Array = await entry.async('uint8array');
            assert.ok(data.length > 0, `${entry.name} is non-empty`);
            assert.ok(
                Buffer.from(data.slice(0, 5)).toString('latin1') === '%PDF-',
                `${entry.name} starts with the %PDF- magic header`
            );
            const extracted = extractPdfText(data);
            assert.ok(extracted.pageCount >= 1, `${entry.name} has at least one page`);
            // Each PDF must carry ITS OWN title and ITS OWN marker text.
            const spec = specs.find((s) => extracted.text.includes(s.title));
            assert.ok(
                spec,
                `${entry.name} contains one of the expected conversation titles; got text: ${JSON.stringify(extracted.text.slice(0, 120))}`
            );
            assert.ok(
                extracted.text.includes(spec!.marker),
                `${entry.name} contains its own body marker ${spec!.marker}`
            );
            for (const other of specs) {
                if (other !== spec) {
                    assert.ok(
                        !extracted.text.includes(other.marker),
                        `${entry.name} must not contain another conversation's marker ${other.marker}`
                    );
                }
            }
            seenMarkers.add(spec!.marker);
        }
        assert.strictEqual(seenMarkers.size, 3, 'all 3 conversations are distinctly represented');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
