/** Physical disk delivery checks. Only the platform host and PDF compiler are
 * adapted; unified Export, Composer, Packaging, Delivery and records are real. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { historicalFixture } from './helpers/nativeFixture.js';
import { v2LiveSaveHost } from './helpers/v2LiveSaveHost.js';
import { v2ExportHost, exportRequest, exportKey } from './helpers/v2ExportHost.js';
import { TypstSandboxCompiler } from '../src/l4/format/pdf/typst/typstSandboxCompiler.js';
import { runExport } from '../src/application/export/runExport.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { getExportRecord } from '../src/l3a/storageService.js';
import { __getZipConstructor, __setZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';
import { extractPdfText } from './helpers/pdfTextExtract.js';
const JSZip = require('../lib/jszip.min.js');
const fixtureDir = path.join(__dirname, 'fixtures', 'provider');
const sample = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'conversation-sample.json'), 'utf8'));

// Fixture helpers

function makeSample(idSuffix: string, title: string, marker?: string) {
    const c = JSON.parse(JSON.stringify(sample));
    c.id = `pdf-e2e-disk-${idSuffix}`;
    c.title = title;
    c.titles = { [c.titleSource || 'legacy']: title };
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

/** Recursively collect plain text from the prepared display transport inline/block nodes. */
function flattenText(node: any): string {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(flattenText).join(' ');
    if (typeof node === 'object') {
        if (typeof node.text === 'string') return node.text;
        if (Array.isArray(node.children)) return node.children.map(flattenText).join('');
        return Object.values(node).filter(value=>typeof value==='object').map(flattenText).join(' ');
    }
    return '';
}

function documentBodyText(document: any, maxLen = 600): string {
    const msgs = document?.messages ?? [];
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
        const title = payload.document.title;
        const body = documentBodyText(payload.document);
        return { pdfBytes: buildTextPdf(String(title), body), diagnostics: [] };
    }
}

// Node-backed FileSystemDirectoryHandle adapter for the REAL FsWriter.
// Only the browser platform API is adapted; FsWriter itself is untouched.

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


async function seed(conv: ReturnType<typeof makeSample>) {
    const parsed=historicalFixture(conv);const {index,detail}=parsed.conversation;
    await ingestDetail(index.key.accountId,index.key.conversationId,detail,index);
    return index.key.conversationId;
}
function compiler(t: import('node:test').TestContext) {
    const instance=new TitleTextPdfCompiler();
    t.mock.method(TypstSandboxCompiler.prototype,'compile',instance.compile.bind(instance));
}
test('e2e-disk: unified PDF Folder Writer creates a parseable physical file',async t=>{
    const h=v2LiveSaveHost(t);compiler(t);const tmp=freshTempDir('pdf-e2e-disk-single-');
    try{
        h.directory(makeNodeDirHandle(tmp));const title='E2E Disk Single Chat';
        const id=await seed(makeSample('single',title));
        const result=await runExport(exportRequest([id],{format:'pdf',delivery:'folderWriter',includeAssets:true}));
        assert.equal(result.exported,1);assert.deepEqual(result.failed,[]);
        const pdfs=pdfFilesRecursive(tmp);assert.equal(pdfs.length,1);
        const bytes=fs.readFileSync(pdfs[0]);assert.ok(bytes.length>0);assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
        const extracted=extractPdfText(bytes);assert.ok(extracted.pageCount>=1);assert.ok(extracted.text.includes(title));
        assert.ok(extracted.text.includes('Shopping list'));assert.ok(extracted.text.includes('milk'));
        const record=await getExportRecord(exportKey(id));assert.equal(record?.format,'pdf');assert.equal(record?.status,'partial');
        assert.deepEqual(Object.keys(record!).sort(),['attachmentIssues','exportedAt','folderBaseName','format','otherContentMissing','status']);
        assert.equal(record?.folderBaseName, path.basename(pdfs[0], '.pdf'));
        assert.ok(record!.attachmentIssues!.length > 0, 'persist attachment reasons for the delivered partial PDF');
    }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
test('e2e-disk: Browser batch ZIP reopens from disk with three distinct parseable PDFs',async t=>{
    const h=v2ExportHost(t);compiler(t);const tmp=freshTempDir('pdf-e2e-disk-zip-');
    const previous=__getZipConstructor();__setZipConstructor(JSZip);t.after(()=>__setZipConstructor(previous));
    try{
        const specs=[{suffix:'a',title:'E2E Batch Chat Alpha',marker:'UNIQUE-MARKER-ALPHA-7f3a'},
            {suffix:'b',title:'E2E Batch Chat Beta',marker:'UNIQUE-MARKER-BETA-9c1e'},
            {suffix:'c',title:'E2E Batch Chat Gamma',marker:'UNIQUE-MARKER-GAMMA-42bd'}];
        const ids=[];for(const spec of specs)ids.push(await seed(makeSample(spec.suffix,spec.title,spec.marker)));
        const result=await runExport(exportRequest(ids,{format:'pdf',includeAssets:false}));
        assert.equal(result.exported,3);assert.deepEqual(result.failed,[]);assert.equal(h.clicks(),1);assert.equal(h.blobs.length,1);
        const zipPath=path.join(tmp,h.filenames[0]);fs.writeFileSync(zipPath,Buffer.from(await h.blobs[0].arrayBuffer()));assert.ok(fs.statSync(zipPath).size>0);
        const zip=await JSZip.loadAsync(fs.readFileSync(zipPath));
        const entries=Object.values(zip.files).filter((f:any)=>!f.dir&&f.name.endsWith('.pdf')) as any[];assert.equal(entries.length,3);
        const seen=new Set<string>();for(const entry of entries){
            const data=await entry.async('uint8array');assert.equal(Buffer.from(data.subarray(0,5)).toString(),'%PDF-');
            const extracted=extractPdfText(data);assert.ok(extracted.pageCount>=1);
            const spec=specs.find(s=>extracted.text.includes(s.title));assert.ok(spec);assert.ok(extracted.text.includes(spec.marker));
            for(const other of specs)if(other!==spec)assert.ok(!extracted.text.includes(other.marker));seen.add(spec.marker);
        }
        assert.equal(seen.size,3);for(const id of ids)assert.equal((await getExportRecord(exportKey(id)))?.format,'pdf');
    }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
