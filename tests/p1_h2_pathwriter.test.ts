import { indexFixture } from './helpers/indexFixture.js';
export {};
const test = require('node:test');
const assert = require('node:assert');

const pathUtils = require('../src/shared/utils/pathUtils.js');
const { mergeConversationIndex, indexActivityTime } = require('../src/l2/conversationIndex.js');

test('p1_h2 - P1-102: con.md is rewritten, not left as a reserved name', () => {
    const out = pathUtils.sanitizeFileName('con.md');
    assert.notStrictEqual(out.toLowerCase(), 'con.md');
    assert.ok(out.endsWith('.md'), `extension preserved, got ${out}`);
});

test('p1_h2 - P1-103: COM/LPT 1..99 are reserved', () => {
    for (const name of ['com1', 'com10', 'com99', 'lpt1', 'lpt42', 'lpt99']) {
        const out = pathUtils.sanitizeFileName(name);
        assert.notStrictEqual(out.toLowerCase(), name, `${name} must be rewritten`);
    }
    const out = pathUtils.sanitizeFileName('lpt99.txt');
    assert.notStrictEqual(out.toLowerCase(), 'lpt99.txt');
    assert.ok(out.endsWith('.txt'));
});

test('p1_h2 - P1-104: long emoji names truncate without lone surrogates', () => {
    const out = pathUtils.sanitizeFileName('😀'.repeat(100));
    assert.strictEqual([...out].length, 70);
    for (const ch of out) {
        const cp = ch.codePointAt(0)!;
        assert.ok(!(cp >= 0xd800 && cp <= 0xdfff), 'lone surrogate found');
    }
});

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

test('p1_h2 - P1-107: takeout placeholder titles do not flow back in', () => {
    const bad = indexFixture({ id: 'c_1', titles: { takeout: 'Google Gemini' } });
    assert.strictEqual(bad.title, undefined, 'placeholder must not be selected as a title');
    const good = indexFixture({ id: 'c_1', title: 'Weekend hiking plan', titleSource: 'derived' });
    assert.strictEqual(good.titleSource, 'derived');
    assert.strictEqual(good.title, 'Weekend hiking plan');
});

test('p1_h2 - P1-108: mergeConversation honors digit-string updatedAt', () => {
    const oldC = { id: 'c_1', updatedAt: '2024-01-01T00:00:00.000Z', title: 'Old' };
    const inc = { id: 'c_1', updatedAt: '1726358400000', title: 'New' };
    const r = mergeConversationIndex(indexFixture(oldC), indexFixture(inc));
    assert.notDeepStrictEqual(r, indexFixture(oldC), 'newer digit-string timestamp should win');
    const eff = indexActivityTime(r);
    assert.strictEqual(eff, 1726358400000);
});

test('p1_h2 - P1-110: fenced/inline code keeps HTML-like content', () => {
    const html = '<pre><code class="language-html">&lt;div&gt;hi&lt;/div&gt;</code></pre>'
        + '<p>real <b>bold</b> text</p>'
        + '<p>sample <code>List&lt;String&gt;</code> and <code>&lt;h1&gt;t&lt;/h1&gt;</code></p>';
    const { convertHtmlToMarkdown } = require('../src/l1/parsers/shared/html/htmlToMarkdown.js');
    const out = convertHtmlToMarkdown(html);
    assert.ok(out.includes('<div>hi</div>'), 'fenced code content must survive');
    assert.ok(out.includes('`List<String>`'), 'inline code generic must survive');
    assert.ok(out.includes('`<h1>t</h1>`'), 'inline code must not be rewritten by heading pass');
    assert.ok(out.includes('**bold**'), 'real bold outside code still converts');
});

test('p1_h2 - P1-115: ZipWriter refuses beyond safe budget instead of warning', async () => {
    (globalThis as any).self = (globalThis as any).self || {};
    (globalThis as any).self.JSZip = (globalThis as any).self.JSZip || require('../lib/jszip.min.js');
    const { ZipWriter } = require('../src/l4/packaging/writers/zipWriter.js');
    const w = new ZipWriter();
    assert.throws(
        () => w.writeFile('big.bin', { byteLength: 300 * 1024 * 1024 } as any),
        /200MB/
    );
});

test('p1_h2 - P1-116: FsWriter serializes concurrent writes to the same path', async () => {
    const { FsWriter } = require('../src/l4/delivery/writers/fsWriter.js');
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
    const w = new FsWriter(dirHandle2);
    await Promise.all([w.writeFile('same.txt', 'aaa'), w.writeFile('same.txt', 'bbb')]);
    const i0s = events.indexOf('w1:start'), i0e = events.indexOf('w1:end');
    const i1s = events.indexOf('w2:start'), i1e = events.indexOf('w2:end');
    assert.ok(i0s !== -1 && i1s !== -1, `both writes ran: ${events.join(',')}`);
    const interleaved = (i0s < i1s && i1s < i0e) || (i1s < i0s && i0s < i1e);
    assert.ok(!interleaved, `same-path writes must serialize, got ${events.join(',')}`);
});

test('p1_h2 - review fix (c): writeChains map does not grow without bound', async () => {
    const { FsWriter } = require('../src/l4/delivery/writers/fsWriter.js');
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
    const w = new FsWriter(fakeDir);
    // concurrent writes to the same path must serialize and leave no chain residue
    await Promise.all([
        w.writeFile('same.md', 'one'),
        w.writeFile('same.md', 'two'),
        w.writeFile('other.md', 'three')
    ]);
    assert.strictEqual(w.__writeChains.size, 0, `chain map must be empty after writes, got ${w.__writeChains.size}`);
    assert.deepStrictEqual(written.slice().sort(), ['one', 'three', 'two']);
});
