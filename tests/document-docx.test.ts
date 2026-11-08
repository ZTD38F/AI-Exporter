import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import type { DisplayBlock } from '../src/l3b/ast/ast.js';
import { docxImageInfo } from '../src/l4/shared/docxImageType.js';
import { v2Conversation, v2Document } from './helpers/l4V2Fixtures.js';
import { renderDocumentDocx } from '../src/l4/format/docx/renderDocx.js';
import { createExportPathPlanner, buildExportFiles } from '../src/l4/packaging/index.js';
import type { PreparedResources } from '../src/shared/resources/resourceResult.js';
const JSZip = require('../lib/jszip.min.js');

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2GAAAAAASUVORK5CYII=', 'base64'));

test('DOCX renders actual OOXML, editable text, safe links, a merged table and embedded image', async () => {
    const document = v2Document([
        { type: 'paragraph', children: [
            { type: 'strong', children: [{ type: 'text', text: 'Hello & <World>' }] },
            { type: 'text', text: ' ' },
            { type: 'link', href: 'https://example.com/?a=1&b=2', children: [{ type: 'text', text: 'website' }] },
            { type: 'text', text: ' ' },
            { type: 'link', href: 'javascript:alert(1)', children: [{ type: 'text', text: 'unsafe link' }] },
        ] },
        { type: 'heading', level: 2, children: [{ type: 'text', text: 'Heading' }] },
        { type: 'code', code: 'const x = "<";', language: 'typescript' },
        { type: 'list', ordered: true, items: [
            { blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'First item' }] }] },
            { blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'Second item' }] }] },
        ] },
        { type: 'table', columnAlignments: ['left', 'right'], headerRows: [
            [{ column: 0, colSpan: 2, rowSpan: 1, children: [{ type: 'text', text: 'Merged heading' }] }],
        ], rows: [[
            { column: 0, colSpan: 1, rowSpan: 1, children: [{ type: 'text', text: 'Left' }] },
            { column: 1, colSpan: 1, rowSpan: 1, children: [{ type: 'text', text: 'Right' }] },
        ]] },
        { type: 'image', resourceId: 'image', alt: 'Diagram' },
        { type: 'math', source: '\\frac{a}{b}' },
    ], { title: 'Docx & example' });
    const before = structuredClone(document);
    const prepared: PreparedResources = new Map([
        ['image', { ok: true, resourceId: 'image', value: { bytes: png, mediaType: 'image/png' } }],
    ]);
    const bytes = await renderDocumentDocx(document, { image: 'assets/diagram.png' }, prepared);
    assert.deepEqual(document, before);
    assert.ok(bytes.length > 1000);
    const zip = await JSZip.loadAsync(bytes);
    assert.ok(zip.file('[Content_Types].xml'));
    assert.ok(zip.file('word/styles.xml'));
    assert.ok(Object.keys(zip.files).some(name => /^word\/media\/.+\.png$/.test(name)));
    const doc = await zip.file('word/document.xml').async('string');
    const rels = await zip.file('word/_rels/document.xml.rels').async('string');
    assert.ok(doc.includes('Docx &amp; example'));
    assert.ok(doc.includes('Hello &amp; &lt;World&gt;'));
    assert.ok(doc.includes('First item') && doc.includes('Second item'));
    assert.ok(doc.includes('Merged heading') && doc.includes('<w:gridSpan w:val="2"/>'));
    assert.ok(doc.includes('Diagram') && doc.includes('r:embed="rId'));
    assert.ok(doc.includes('<m:f>') && doc.includes('<m:num>') && doc.includes('<m:den>'), 'fraction is an editable Word equation');
    assert.ok(rels.includes('https://example.com/?a=1&amp;b=2'));
    assert.ok(!rels.includes('javascript:'));
    assert.ok(doc.includes('unsafe link'), 'untrusted link label is not dropped');
});

test('DOCX planner embeds supported images but preserves files and unsupported image formats alongside Word', () => {
    const c = v2Conversation('Document', [
        { id: 'image', kind: 'image', name: 'photo.png', mediaType: 'image/png' },
        { id: 'unsupported', kind: 'image', name: 'picture.webp', mediaType: 'image/webp' },
        { id: 'file', kind: 'file', name: 'notes.txt', mediaType: 'text/plain' },
    ]);
    const prepared: PreparedResources = new Map([
        ['image', { ok: true, resourceId: 'image', value: { bytes: png, mediaType: 'image/png' } }],
        ['unsupported', { ok: true, resourceId: 'unsupported', value: { bytes: new Uint8Array([1, 2]), mediaType: 'image/webp' } }],
        ['file', { ok: true, resourceId: 'file', value: { bytes: new Uint8Array([3, 4]), mediaType: 'text/plain' } }],
    ]);
    const plan = createExportPathPlanner('docx')(c, prepared, new Set(['file']));
    assert.match(plan.fileName, /\.docx$/);
    assert.equal(plan.externalResourceIds.has('image'), false);
    assert.equal(plan.externalResourceIds.has('unsupported'), true);
    assert.equal(plan.externalResourceIds.has('file'), true);
    const files = buildExportFiles('docx', plan, new Uint8Array([1]), prepared);
    assert.equal(files.length, 3);
    assert.equal(files[0].mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('DOCX handles empty conversation and unavailable images without losing the text', async () => {
    const empty = v2Document([{ type: 'image', resourceId: 'missing', alt: 'Lost drawing' }], { title: 'Image failure' });
    const zip = await JSZip.loadAsync(await renderDocumentDocx(empty, {}, new Map(), { locale: 'zh' }));
    const body = await zip.file('word/document.xml').async('string');
    assert.ok(body.includes('Lost drawing'));
});


test('DOCX preserves portrait, landscape and progressive JPEG proportions in the actual OOXML', async () => {
    for (const [name, width, height] of [['portrait', 300, 900], ['landscape', 900, 300], ['progressive', 300, 900]] as const) {
        const bytes = readFileSync(`tests/fixtures/docx/${name}.jpg`);
        assert.deepEqual(docxImageInfo('image/jpeg', bytes), { type: 'jpg', width, height });
        const prepared: PreparedResources = new Map([
            ['image', { ok: true, resourceId: 'image', value: { bytes, mediaType: 'image/jpeg' } }],
        ]);
        const document = v2Document([{ type: 'image', resourceId: 'image', alt: name }]);
        const zip = await JSZip.loadAsync(await renderDocumentDocx(document, { image: 'assets/photo.jpg' }, prepared));
        const xml = await zip.file('word/document.xml').async('string');
        const extent = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml);
        assert.ok(extent, 'Word drawing has physical dimensions');
        const displayedWidth = Number(extent[1]) / 9525;
        const displayedHeight = Number(extent[2]) / 9525;
        assert.ok(displayedWidth <= 520 && displayedHeight <= 610);
        assert.ok(Math.abs(displayedWidth / displayedHeight / (width / height) - 1) < 0.005,
            `${name} must retain its aspect ratio after integer pixel scaling`);
        const embedded = Object.keys(zip.files).find(name => /^word\/media\/.+\.jpg$/.test(name));
        assert.ok(embedded);
        assert.deepEqual(await zip.file(embedded).async('uint8array'), new Uint8Array(bytes), 'source JPEG is not re-encoded');
    }
});

test('DOCX unreadable image dimensions preserve companion bytes and readable fallback text', async () => {
    const jpeg = readFileSync('tests/fixtures/docx/portrait.jpg');
    const brokenImages = [
        new Uint8Array([255, 216, 255]),
        new Uint8Array([255, 216, 255, 224, 255, 255]), // metadata extends past EOF
        new Uint8Array([255, 216, 255, 192, 0, 2]), // frame too short
        jpeg.subarray(0, 40),
        new Uint8Array([255, 216, 255, 218, 0, 2]), // scan without a frame
    ];
    for (const bytes of brokenImages) {
        assert.equal(docxImageInfo('image/jpeg', bytes), undefined);
        const prepared: PreparedResources = new Map([
            ['image', { ok: true, resourceId: 'image', value: { bytes, mediaType: 'image/jpeg' } }],
        ]);
        const plan = createExportPathPlanner('docx')(v2Conversation('Broken', [
            { id: 'image', kind: 'image', name: 'broken.jpg', mediaType: 'image/jpeg' },
        ]), prepared, new Set());
        const output = await renderDocumentDocx(v2Document([{ type: 'image', resourceId: 'image', alt: 'Original image' }]), plan.resources, prepared);
        const zip = await JSZip.loadAsync(output);
        const xml = await zip.file('word/document.xml').async('string');
        assert.ok(xml.includes('Original image') && xml.includes(plan.resources.image));
        assert.ok(!xml.includes('<w:drawing>'));
        assert.equal(plan.externalResourceIds.has('image'), true);
        const files = buildExportFiles('docx', plan, output, prepared);
        assert.deepEqual(files.find(file => file.fileName === plan.resources.image)?.content, bytes);
    }
});

test('DOCX image headers use byte-view offsets and reject zero dimensions', () => {
    const padded = new Uint8Array(png.length + 9);
    padded.set(png, 9);
    assert.deepEqual(docxImageInfo('image/png', padded.subarray(9)), { type: 'png', width: 1, height: 1 });
    const zeroPng = new Uint8Array(png);
    zeroPng.fill(0, 16, 20);
    assert.equal(docxImageInfo('image/png', zeroPng), undefined);
    const gif = new Uint8Array([71, 73, 70, 56, 57, 97, 44, 1, 132, 3]);
    assert.deepEqual(docxImageInfo('image/gif', gif), { type: 'gif', width: 300, height: 900 });
    gif.fill(0, 6, 8);
    assert.equal(docxImageInfo('image/gif', gif), undefined);
});


test('DOCX native lists preserve starts, nesting, restarts and unnumbered continuation paragraphs', async () => {
    const paragraph = (text: string): DisplayBlock => ({ type: 'paragraph', children: [{ type: 'text', text }] });
    const zip = await JSZip.loadAsync(await renderDocumentDocx(v2Document([
        { type: 'list', ordered: true, start: 3, items: [
            { blocks: [paragraph('outer first'), paragraph('continued paragraph'),
                { type: 'list', ordered: true, start: 7, items: [{ blocks: [paragraph('inner numbered')] }] },
                { type: 'list', ordered: false, items: [{ blocks: [paragraph('inner bullet')] }] },
            ] },
            { blocks: [paragraph('outer second')] },
        ] },
        paragraph('between lists'),
        { type: 'list', ordered: true, items: [{ blocks: [paragraph('restarted list')] }] },
        { type: 'list', ordered: false, items: [{ blocks: [{ type: 'code', code: 'nonparagraph first block' }] }] },
    ]), {}, new Map()));
    const xml = new DOMParser().parseFromString(await zip.file('word/document.xml').async('string'), 'application/xml');
    const paragraphs = Array.from(xml.getElementsByTagName('w:p'));
    const find = (text: string) => {
        const result = paragraphs.find(p => p.textContent === text);
        assert.ok(result, text);
        return result;
    };
    const numId = (text: string) => find(text).getElementsByTagName('w:numId').item(0)?.getAttribute('w:val');
    const outer = numId('outer first');
    assert.ok(outer);
    assert.equal(numId('outer second'), outer, 'nested lists must not reset the parent counter');
    assert.notEqual(numId('inner numbered'), outer);
    assert.notEqual(numId('restarted list'), outer, 'a separate list has a separate Word numbering instance');
    assert.equal(find('inner numbered').getElementsByTagName('w:ilvl').item(0)?.getAttribute('w:val'), '1');
    assert.equal(find('inner bullet').getElementsByTagName('w:ilvl').item(0)?.getAttribute('w:val'), '1');
    assert.equal(numId('continued paragraph'), undefined);
    assert.equal(find('continued paragraph').getElementsByTagName('w:ind').item(0)?.getAttribute('w:left'), '540');
    assert.equal(numId('nonparagraph first block'), undefined, 'code remains code after an empty native list marker');
    const numbering = await zip.file('word/numbering.xml').async('string');
    assert.match(numbering, /<w:start w:val="3"/);
    assert.match(numbering, /<w:start w:val="7"/);
    assert.match(numbering, /<w:numFmt w:val="bullet"/);
    assert.match(numbering, /<w:lvlText w:val="%2\."/);
    assert.match(numbering, /<w:startOverride w:val="7"/);
});

test('DOCX converts common inline and display LaTeX structures to native Word math', async () => {
    const sources = [
        String.raw`\frac{a_1}{b^2}`, String.raw`\sqrt{x}+\sqrt[3]{y}`,
        String.raw`\sum_{i=1}^{n} i^2`, String.raw`\int_0^1 x^2\,dx`,
        String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
        String.raw`\begin{cases}x^2&x>0\\0&x\le0\end{cases}`,
        String.raw`\hat{x}+\vec{v}+\overline{AB}`,
        String.raw`\mathbb{R}+\text{中文条件}`,
        String.raw`\left|x\right|+\binom{n}{k}`,
        String.raw`\lim_{x\to0}\frac{\sin x}{x}=1`,
    ];
    const zip = await JSZip.loadAsync(await renderDocumentDocx(v2Document([
        { type: 'paragraph', children: [{ type: 'text', text: 'Before ' }, { type: 'inlineMath', source: 'E=mc^2' }, { type: 'text', text: ' after' }] },
        ...sources.map(source => ({ type: 'math' as const, source })),
    ]), {}, new Map()));
    const body = await zip.file('word/document.xml').async('string');
    const xml = new DOMParser().parseFromString(body, 'application/xml');
    assert.equal(xml.getElementsByTagName('m:oMath').length, sources.length + 1);
    assert.equal(xml.getElementsByTagName('m:oMathPara').length, sources.length, 'display equations use native display containers');
    for (const tag of ['m:f', 'm:rad', 'm:deg', 'm:sSub', 'm:sSup', 'm:sSubSup', 'm:limLow', 'm:limUpp', 'm:m', 'm:d', 'm:acc', 'm:bar', 'm:func']) {
        assert.ok(xml.getElementsByTagName(tag).length > 0, tag);
    }
    const limitFunction = xml.getElementsByTagName('m:func').item(0);
    assert.ok(limitFunction);
    assert.equal(limitFunction.getElementsByTagName('m:fName').item(0)?.getElementsByTagName('m:f').length, 0, 'limit name stays outside the fraction');
    assert.equal(limitFunction.getElementsByTagName('m:f').length, 1);
    const matrix = xml.getElementsByTagName('m:m').item(0);
    assert.ok(matrix);
    assert.equal(matrix.getElementsByTagName('m:mr').length, 2);
    assert.equal(matrix.getElementsByTagName('m:e').length, 4);
    assert.equal(matrix.textContent, 'abcd');
    assert.ok(body.includes('<m:begChr m:val="|"/>'), 'MathML divides delimiters use Word vertical bars');
    assert.ok(body.includes('中文条件') && body.includes('double-struck'));
    assert.ok(!body.includes('frac{') && !body.includes('begin{') && !body.includes('Unable to typeset'));
    const paragraph = Array.from(xml.getElementsByTagName('w:p')).find(p => p.textContent === 'Before E=mc2 after');
    assert.ok(paragraph?.getElementsByTagName('m:oMath').length, 'inline equation stays between its surrounding words');
});

test('DOCX unsupported and malformed formulas retain the entire original source without partial math', async () => {
    for (const source of [String.raw`a+\unknownmacro{x}`, String.raw`\frac{a}{`, String.raw`a+\phantom{x}`, 'x'.repeat(20_001)]) {
        const zip = await JSZip.loadAsync(await renderDocumentDocx(v2Document([
            { type: 'paragraph', children: [{ type: 'inlineMath', source }] },
            { type: 'math', source },
            { type: 'paragraph', children: [{ type: 'text', text: 'following content survives' }] },
        ]), {}, new Map()));
        const xml = new DOMParser().parseFromString(await zip.file('word/document.xml').async('string'), 'application/xml');
        assert.equal(xml.getElementsByTagName('m:oMath').length, 0);
        assert.equal(Array.from(xml.getElementsByTagName('w:t')).filter(t => t.textContent === source).length, 2);
        assert.ok(xml.documentElement?.textContent?.includes('following content survives'));
    }
});

test('DOCX native math escapes XML text and never creates links from untrusted math commands', async () => {
    const source = String.raw`\text{<w:hyperlink> \& unsafe} + x < y`;
    const zip = await JSZip.loadAsync(await renderDocumentDocx(v2Document([
        { type: 'math', source },
        { type: 'math', source: String.raw`\href{https://evil.example}{x}` },
    ]), {}, new Map()));
    const body = await zip.file('word/document.xml').async('string');
    const xml = new DOMParser().parseFromString(body, 'application/xml');
    assert.equal(xml.getElementsByTagName('m:oMath').length, 1);
    assert.equal(xml.getElementsByTagName('w:hyperlink').length, 0);
    assert.ok(body.includes('&lt;w:hyperlink&gt;'));
    assert.ok(xml.documentElement?.textContent?.replace(/\u00a0/g, ' ').includes('<w:hyperlink> & unsafe'));
    const rels = await zip.file('word/_rels/document.xml.rels').async('string');
    assert.ok(!rels.includes('evil.example'));
});

test('DOCX handles KaTeX function subscripts and macron accents found in real exports', async () => {
    const sources = [String.raw`2 f_{\max}`, String.raw`\lambda_{\min}(P)`,
        String.raw`\sigma_{\max}(A)`, String.raw`\bar{x}+\bar{M}`,
        String.raw`\lim_{k\to\infty}\|A^k\|^{1/k}=\rho(A)`];
    const zip = await JSZip.loadAsync(await renderDocumentDocx(v2Document(
        sources.map(source => ({ type: 'paragraph' as const, children: [{ type: 'inlineMath' as const, source }] })),
    ), {}, new Map()));
    const xml = new DOMParser().parseFromString(await zip.file('word/document.xml').async('string'), 'application/xml');
    assert.equal(xml.getElementsByTagName('m:oMath').length, sources.length);
    assert.equal(xml.getElementsByTagName('m:bar').length, 2);
    const fn = xml.getElementsByTagName('m:func').item(0);
    assert.ok(fn);
    assert.equal(fn.getElementsByTagName('m:limLow').length, 1);
    assert.ok(fn.getElementsByTagName('m:e').item(1)?.textContent?.includes('ρ'), 'function argument is not an isolated norm delimiter');
    assert.ok(!xml.documentElement?.textContent?.includes('\\'));
});

test('DOCX expands oversized formula tables without losing headers, row order, merged labels or trailing content', async () => {
    const formula = String.raw`\begin{pmatrix}x_1&y_1&1&0&0&0&-u_1x_1&-u_1y_1&-u_1\end{pmatrix}`;
    const document = v2Document([
        { type: 'table', columnAlignments: ['left','left','left','left','left'],
            caption: [{ type: 'text', text: 'Constraints' }],
            headerRows: [[{ column: 0, colSpan: 5, rowSpan: 1, children: [{ type: 'text', text: 'All columns' }] }]],
            rows: [1,2].map(row => Array.from({ length: 5 }, (_, column) => ({
                column, colSpan: 1, rowSpan: 1, children: [
                    { type: 'text' as const, text: `row${row}-col${column} ` },
                    { type: 'inlineMath' as const, source: formula },
                ],
            }))),
        },
        { type: 'paragraph', children: [{ type: 'text', text: 'after-table' }] },
    ]);
    const before = structuredClone(document);
    const zip = await JSZip.loadAsync(await renderDocumentDocx(document, {}, new Map()));
    const xml = new DOMParser().parseFromString(await zip.file('word/document.xml').async('string'), 'application/xml');
    assert.equal(xml.getElementsByTagName('w:tbl').length, 0, 'unbreakable formulas use the full page width');
    assert.equal(xml.getElementsByTagName('m:m').length, 10);
    const text = xml.documentElement?.textContent ?? '';
    assert.ok(text.includes('Constraints') && text.includes('Column 1–5'));
    assert.ok(text.indexOf('row1-col4') < text.indexOf('row2-col0'));
    assert.ok(text.indexOf('row2-col4') < text.indexOf('after-table'));
    assert.equal(text.split('All columns').length - 1, 11, 'each expanded cell retains its merged header association');
    assert.deepEqual(document, before);
});

test('DOCX aligned derivations preserve empty alignment cells and scripts on complete bracketed operands', async () => {
    const source = String.raw`\begin{aligned}\Delta V&=x[k+1]^\top P x[k+1]\\&=(Ax[k])^\top P(Ax[k])-x[k]^\top P x[k]\\&=x[k]^\top(A^\top PA-P)x[k]\end{aligned}`;
    const zip = await JSZip.loadAsync(await renderDocumentDocx(v2Document([{ type: 'math', source }]), {}, new Map()));
    const xml = new DOMParser().parseFromString(await zip.file('word/document.xml').async('string'), 'application/xml');
    assert.equal(xml.getElementsByTagName('m:mr').length, 3);
    assert.ok(Array.from(xml.getElementsByTagName('m:e')).every(e => e.childNodes.length > 0), 'empty aligned cells use an invisible run rather than a missing operand');
    const scripts = Array.from(xml.getElementsByTagName('m:sSup'));
    assert.ok(scripts.some(script => script.getElementsByTagName('m:d').length > 0), 'transposes attach to a bracketed operand');
    assert.ok(!scripts.some(script => /^\)|^\]/.test(script.getElementsByTagName('m:e').item(0)?.textContent ?? '')), 'no isolated closing delimiter as script base');
});
