export {};
const test = require('node:test');
const assert = require('node:assert');

const pathUtils = require('../src/core/utils/pathUtils.js');
const titleUtils = require('../src/core/utils/titleUtils.js');
const { mergeConversation } = require('../src/core/utils/mergeUtils.js');
const progressUtils = require('../src/core/utils/progressUtils.js');
const { ChatFormatter } = require('../src/core/engine/chatFormatter.js');

test('p1_h2 - P1-102: con.md is rewritten, not left as a reserved name', () => {
    const out = pathUtils.sanitizeFileName('con.md');
    assert.notStrictEqual(out.toLowerCase(), 'con.md');
    assert.ok(out.endsWith('.md'), `extension preserved, got ${out}`);
});

// ---------- P1-103: COM/LPT 1-99 ----------
test('p1_h2 - P1-103: COM/LPT 1..99 are reserved', () => {
    for (const name of ['com1', 'com10', 'com99', 'lpt1', 'lpt42', 'lpt99']) {
        const out = pathUtils.sanitizeFileName(name);
        assert.notStrictEqual(out.toLowerCase(), name, `${name} must be rewritten`);
    }
    const out = pathUtils.sanitizeFileName('lpt99.txt');
    assert.notStrictEqual(out.toLowerCase(), 'lpt99.txt');
    assert.ok(out.endsWith('.txt'));
});

// ---------- P1-104: truncate by code point, not UTF-16 unit ----------
test('p1_h2 - P1-104: long emoji names truncate without lone surrogates', () => {
    const out = pathUtils.sanitizeFileName('😀'.repeat(100));
    assert.strictEqual([...out].length, 70);
    for (const ch of out) {
        const cp = ch.codePointAt(0)!;
        assert.ok(!(cp >= 0xd800 && cp <= 0xdfff), 'lone surrogate found');
    }
});

// ---------- P1-105: extension traversal sanitized ----------
test('p1_h2 - P1-105: buildExportFileName strips path traversal from extension', () => {
    const out = pathUtils.buildExportFileName('title', 'c_123', '../../etc/passwd');
    assert.ok(!out.includes('/') && !out.includes('..'), `got ${out}`);
    assert.ok(out.length > 0);
});

test('p1_h2 - P1-105b: buildExportFileName preserves _cid6 under downstream sanitizeRelativePath even with long titles', () => {
    const longTitle = '在 Kerr 黑洞时空几何背景下，基于 Newman-Penrose 零四标架投影推导 Teukolsky 主方程（Teukolsky Master Equation），并严格展示辐射规范下拉普拉斯-';
    const out = pathUtils.buildExportFileName(longTitle, '2f088360411acd53', 'md');
    assert.ok(out.endsWith('_1acd53.md'), `filename must end with _1acd53.md, got ${out}`);
    const cleaned = pathUtils.sanitizeRelativePath(out, 'file');
    assert.strictEqual(cleaned, out, 'downstream sanitizeRelativePath must not truncate _cid6');
});

// ---------- P1-106: toTimestampMs ----------
test('p1_h2 - P1-106: toTimestampMs normalizes timestamp shapes', () => {
    const f = titleUtils.toTimestampMs;
    assert.strictEqual(f(3000), 3000, 'number keeps ms contract');
    assert.strictEqual(f('1726358400'), 1726358400000, 'digit string < 1e11 is epoch seconds');
    assert.strictEqual(f('1726358400000'), 1726358400000, 'long digit string is epoch ms');
    assert.strictEqual(f('2024-09-14T00:00:00.000Z'), 1726272000000, 'ISO string');
    assert.strictEqual(f(new Date('2024-09-14T00:00:00.000Z')), 1726272000000, 'Date');
    assert.strictEqual(f('not-a-date'), null);
    assert.strictEqual(f(null), null);
    assert.strictEqual(f(undefined), null);
    assert.strictEqual(f(-5), null);
    assert.strictEqual(f(''), null);
});

// ---------- P1-107: takeout fallback uses the same bar as tier 1 ----------
test('p1_h2 - P1-107: takeout placeholder titles do not flow back in', () => {
    const bad = titleUtils.resolveTitle({ id: 'c_1', titles: { takeout: 'Google Gemini' } });
    assert.strictEqual(bad.source, 'default', `placeholder must not resolve as takeout, got ${bad.source}`);
    const good = titleUtils.resolveTitle({ id: 'c_1', titles: { takeout: 'Weekend hiking plan' } });
    assert.strictEqual(good.source, 'takeout');
    assert.strictEqual(good.title, 'Weekend hiking plan');
});

// ---------- P1-108: merge timestamps via toTimestampMs ----------
test('p1_h2 - P1-108: mergeConversation honors digit-string updatedAt', () => {
    const oldC = { id: 'c_1', updatedAt: '2024-01-01T00:00:00.000Z', title: 'Old' };
    const inc = { id: 'c_1', updatedAt: '1726358400000', title: 'New' };
    const r = mergeConversation(oldC, inc);
    assert.ok(r.isChanged, 'newer digit-string timestamp should win');
    const eff = titleUtils.getEffectiveTimestamp(r.merged);
    assert.strictEqual(eff, 1726358400000);
});

// ---------- P1-109: NaN progress ----------
test('p1_h2 - P1-109: NaN/Infinity pct becomes 0, not NaN', () => {
    assert.strictEqual(progressUtils.formatExportProgress({ pct: NaN }).pct, 0);
    assert.strictEqual(progressUtils.formatExportProgress({ pct: Infinity }).pct, 0);
    assert.strictEqual(progressUtils.formatExportProgress(NaN).pct, 0);
    assert.strictEqual(progressUtils.formatExportProgress({ pct: 42 }).pct, 42);
});

// ---------- P1-110: code spans survive the residual tag strip ----------
test('p1_h2 - P1-110: fenced/inline code keeps HTML-like content', () => {
    const html = '<pre><code class="language-html">&lt;div&gt;hi&lt;/div&gt;</code></pre>'
        + '<p>real <b>bold</b> text</p>'
        + '<p>sample <code>List&lt;String&gt;</code> and <code>&lt;h1&gt;t&lt;/h1&gt;</code></p>';
    const out = ChatFormatter.convertHtmlToMarkdown(html);
    assert.ok(out.includes('<div>hi</div>'), 'fenced code content must survive');
    assert.ok(out.includes('`List<String>`'), 'inline code generic must survive');
    assert.ok(out.includes('`<h1>t</h1>`'), 'inline code must not be rewritten by heading pass');
    assert.ok(out.includes('**bold**'), 'real bold outside code still converts');
});

// ---------- P1-112: no substring cross-file matching ----------
// ---------- P1-115: ZipWriter 200MB hard fail ----------
test('p1_h2 - P1-115: ZipWriter refuses beyond safe budget instead of warning', async () => {
    (globalThis as any).self = (globalThis as any).self || {};
    (globalThis as any).self.JSZip = (globalThis as any).self.JSZip || require('../lib/jszip.min.js');
    const { ZipWriter } = require('../src/core/engine/writers/zipWriter.js');
    const w = new ZipWriter('test');
    assert.throws(
        () => w.writeFile('big.bin', { byteLength: 300 * 1024 * 1024 } as any),
        /200MB/
    );
});

// ---------- P1-116: FsWriter serializes same-path writes ----------
test('p1_h2 - P1-116: FsWriter serializes concurrent writes to the same path', async () => {
    const { FsWriter } = require('../src/core/engine/writers/fsWriter.js');
    const events: string[] = [];
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
    // Tag writables by creation order to observe interleaving.
    let n = 0;
    const dirHandle2: any = {
        getDirectoryHandle: async () => dirHandle2,
        getFileHandle: async (_name: string, _opts: any) => ({
            createWritable: async () => {
                const tag = `w${++n}`;
                return {
                    write: async () => { events.push(`${tag}:start`); await delay(30); events.push(`${tag}:end`); },
                    close: async () => {}
                };
            }
        })
    };
    const w = new FsWriter(dirHandle2, 'batch');
    await Promise.all([w.writeFile('same.txt', 'aaa'), w.writeFile('same.txt', 'bbb')]);
    const i0s = events.indexOf('w1:start'), i0e = events.indexOf('w1:end');
    const i1s = events.indexOf('w2:start'), i1e = events.indexOf('w2:end');
    assert.ok(i0s !== -1 && i1s !== -1, `both writes ran: ${events.join(',')}`);
    const interleaved = (i0s < i1s && i1s < i0e) || (i1s < i0s && i0s < i1e);
    assert.ok(!interleaved, `same-path writes must serialize, got ${events.join(',')}`);
});

test('p1_h2 - review fix (c): writeChains map does not grow without bound', async () => {
    const { FsWriter } = require('../src/core/engine/writers/fsWriter.js');
    const written: string[] = [];
    const fakeFile = () => ({
        createWritable: async () => ({
            write: async (c: any) => { written.push(String(c)); },
            close: async () => {}
        })
    });
    const fakeDir = {
        name: 'gemini_export',
        getFileHandle: async () => fakeFile()
    };
    const w = new FsWriter(fakeDir, 'gemini_export');
    // concurrent writes to the same path must serialize and leave no chain residue
    await Promise.all([
        w.writeFile('same.md', 'one'),
        w.writeFile('same.md', 'two'),
        w.writeFile('other.md', 'three')
    ]);
    assert.strictEqual(w.__writeChains.size, 0, `chain map must be empty after writes, got ${w.__writeChains.size}`);
    assert.deepStrictEqual(written.slice().sort(), ['one', 'three', 'two']);
});

// ---------- Review fix (d): legacy filename compat ----------
test('p1_h2 - review fix (d): legacy rules reproduced byte-for-byte', () => {
    // reserved-name check ran BEFORE ext stripping in the old rules
    assert.strictEqual(pathUtils.sanitizeFileNameLegacy('con.md'), 'con.md');
    assert.strictEqual(pathUtils.sanitizeFileNameLegacy('lpt99.txt'), 'lpt99.txt');
    assert.strictEqual(pathUtils.sanitizeFileNameLegacy('aux'), 'aux_chat');
    // old truncation used UTF-16 code units
    assert.strictEqual(pathUtils.sanitizeFileNameLegacy('😀'.repeat(100)).length, 70);
    // new rules differ exactly where intended
    assert.notStrictEqual(pathUtils.sanitizeFileName('con.md'), 'con.md');
    assert.strictEqual(pathUtils.sanitizeFileName('con.md'), 'con_chat.md');
});
test('p1_h2 - review fix (d): resolveExportFileName reuses on-disk legacy name', async () => {
    const title = '😀'.repeat(100); // >70 chars: code-point vs UTF-16 truncation differ
    const id = 'c_abcdef123456';
    const newName = pathUtils.buildExportFileName(title, id, 'md');
    const legacyName = pathUtils.buildExportFileNameLegacy(title, id, 'md');
    assert.notStrictEqual(newName, legacyName, `rules must differ for this fixture, got ${newName} vs ${legacyName}`);
    // legacy file on disk -> reuse it, no orphan
    const r1 = await pathUtils.resolveExportFileName(title, id, 'md', async (n: string) => n === legacyName);
    assert.strictEqual(r1, legacyName);
    // new-rule file on disk -> keep the new name
    const r2 = await pathUtils.resolveExportFileName(title, id, 'md', async (n: string) => n === newName);
    assert.strictEqual(r2, newName);
    // nothing on disk -> fresh export uses the new name
    const r3 = await pathUtils.resolveExportFileName(title, id, 'md', async () => false);
    assert.strictEqual(r3, newName);
    // unaffected title -> no probing at all
    let probed = false;
    const r4 = await pathUtils.resolveExportFileName('plain title', id, 'md', async () => { probed = true; return true; });
    assert.strictEqual(r4, pathUtils.buildExportFileName('plain title', id, 'md'));
    assert.strictEqual(probed, false, 'no disk probe when rules agree');
});
test('p1_h2 - review fix (d): reserved stem with extension also compat-probed', async () => {
    const title = 'con.md'; // old rules left it, new rules rewrite the stem
    const id = 'c_abcdef123456';
    const newName = pathUtils.buildExportFileName(title, id, 'md');
    const legacyName = pathUtils.buildExportFileNameLegacy(title, id, 'md');
    assert.notStrictEqual(newName, legacyName);
    const r = await pathUtils.resolveExportFileName(title, id, 'md', async (n: string) => n === legacyName);
    assert.strictEqual(r, legacyName, 'must reuse the on-disk legacy file');
});
