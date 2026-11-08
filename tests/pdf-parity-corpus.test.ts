/** Shared Document AST corpus: JSON closure, ordered HTML/PDF text parity and explicit degradation diagnostics. */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { renderDocumentHtml } = require('../src/l4/format/html/renderHtml.js');
const { renderTypstFixture } = require('./helpers/renderTypstFixture.js');
const { assertDocumentAst } = require('./helpers/assertDocumentAst.js');
const { collectDocumentResources } = require('../src/l3b/ast/resourceReferences.js');
const corpusDir = path.join(__dirname, 'parity-corpus');
const fixtureNames: string[] = fs
    .readdirSync(corpusDir)
    .filter((f: string) => f.endsWith('.json'))
    .sort();

const validatedFixtures = new Map<string, unknown>();
const loadFixture = (name: string): any => {
    if (!validatedFixtures.has(name)) {
        const fixture = JSON.parse(fs.readFileSync(path.join(corpusDir, name), 'utf8'));
        assertDocumentAst(fixture.document, name);
        validatedFixtures.set(name, fixture);
    }
    return validatedFixtures.get(name);
};

test('parity corpus: every fixture is a closed JSON display tree', () => {
    assert.ok(fixtureNames.length >= 4);
    for (const name of fixtureNames) {
        const fixture = loadFixture(name), document = fixture.document;
        assert.equal(typeof document.title, 'string');
        assert.equal('schemaVersion' in document, false);
        assert.deepEqual(JSON.parse(JSON.stringify(document)), document);
        assert.ok(document.messages.every((message: { role: string }) => typeof message.role === 'string')); // AST messages are positional, without transport IDs.
        const preparedIds = new Set(fixture.resourceIds);
        for (const id of collectDocumentResources(document).referencedIds) assert.ok(preparedIds.has(id), `${name}: missing resource identity ${id}`);
        assert.ok(!('bundle' in fixture) && !('conversation' in fixture));
    }
});

test('parity corpus: long-conversation fixture really carries 121 messages', () => {
    assert.equal(loadFixture('long-conversation-121.json').document.messages.length, 121);
});

// ---------------------------------------------------------------------------
// Gate 3 (active since D8-A): HTML-vs-PDF text parity per fixture.
// ---------------------------------------------------------------------------

const CJK_CLASS = '\\u2e80-\\u9fff\\u3400-\\u4dbf\\uf900-\\ufaff';

function decodeEntities(s: string): string {
    return s
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_m: string, n: string) => String.fromCodePoint(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_m: string, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

/** Collapse whitespace and drop insignificant spaces between CJK characters. */
function normalizeLine(s: string): string {
    let t = s.replace(/\s+/g, ' ').trim();
    t = t.replace(new RegExp(`([${CJK_CLASS}])\\s+(?=[${CJK_CLASS}])`, 'g'), '$1');
    return t;
}

/**
 * Strip documented HTML presentation chrome. Returns null to drop the line.
 * Never touches conversation content: the missing-asset placeholders keep the
 * human-readable label, which is exactly what the PDF fallback shows.
 */
function stripHtmlChrome(line: string): string | null {
    if (line === '复制') return null; // code-block copy button
    const missing = /^(?:图片不可用|附件不可用):\s*(.*?)\s*MISSING$/.exec(line);
    if (missing) return missing[1] || null; // missing attachment card keeps the asset label
    return line; // Both backends retain the same localized inline unavailable text.
}

function textLinesFromHtml(html: string): string[] {
    // This oracle compares message bodies; the document title/metadata are rendered by document.typ.
    let t = html.replace(/<header class="gem-conversation-header">[\s\S]*?<\/header>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<math[\s\S]*?<annotation\b[^>]*>([\s\S]*?)<\/annotation>[\s\S]*?<\/math>/gi, '$1');
    // Block-level closings and <br>/<hr> are line breaks; every other tag is
    // removed WITHOUT inserting a space so inline markup (strong/em/a/code)
    // never introduces phantom spacing around CJK text.
    t = t.replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|th|td|thead|tbody|table|blockquote|pre|figure|figcaption|details|summary|caption)\b[^>]*>/gi, '\n');
    t = t.replace(/<(br|hr|div)\b[^>]*>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    t = decodeEntities(t);
    const out: string[] = [];
    for (const raw of t.split('\n')) {
        const n = normalizeLine(raw);
        if (!n) continue;
        const s = stripHtmlChrome(n);
        if (s) out.push(s);
    }
    return out;
}

interface TextParts { body: string[]; asset: string[]; }

/**
 * Partition the HTML into body lines and attachment-card lines. The HTML
 * renderer hoists image/file blocks into an attachment carousel (before the
 * body for user turns, after it for model turns); the PDF keeps asset blocks
 * inline. Comparing the two partitions separately asserts the same body text
 * in the same order and the same asset cards in the same relative order.
 */
async function htmlTextParts(html: string): Promise<TextParts> {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(html);
        const partition = await page.evaluate(() => {
            const assets = [...document.querySelectorAll('.gem-att-card, .gem-missing-asset:not(.gem-missing-inline)')];
            const html = assets.map(node => node.outerHTML).join('\n');
            assets.forEach(node => node.remove());
            return { asset: html, body: document.documentElement.outerHTML };
        });
        const assetLines = textLinesFromHtml(partition.asset).map(line => line.replace(/^(?:图片不可用|附件不可用)[：:]?\s*/, '')).filter(Boolean);
        return { body: textLinesFromHtml(partition.body), asset: assetLines.filter((line, index) => line !== assetLines[index - 1]) };
    } finally { await browser.close(); }
}

/** Flatten Typst inline nodes to the text the template typesets. */
function typstInlineText(nodes: any[]): string {
    let s = '';
    for (const n of nodes ?? []) {
        switch (n.type) {
            case 'text': s += n.text; break;
            case 'strong': case 'emphasis': case 'strikethrough': case 'link': s += typstInlineText(n.children); break;
            case 'inlineCode': s += n.text; break;
            case 'lineBreak': s += '\n'; break;
            case 'image': s += n.alt ?? `[image: ${n.asset}]`; break;
            case 'inlineMath': s += n.latex; break;
            default: break;
        }
    }
    return s;
}

function typstTextParts(payload: any, document: any): TextParts {

    const body: string[] = [];
    const asset: string[] = [];
    const emit = (isAsset: boolean, text: string): void => {
        for (const raw of String(text).split('\n')) {
            const n = normalizeLine(raw);
            if (n) (isAsset ? asset : body).push(n);
        }
    };
    const emitBlock = (b: any, displayType: string | undefined): void => {
        // A missing image/file block reaches the PDF as an `unknown` fallback node;
        // the display type keeps it in the asset partition with its HTML resource placement.
        const isAsset = b.type === 'image' || b.type === 'file' || displayType === 'image' || displayType === 'file';
        switch (b.type) {
            case 'paragraph': {
                emit(isAsset, typstInlineText(b.children));
                return;
            }
            case 'thematicBreak':
                return;
            case 'heading':
                emit(isAsset, typstInlineText(b.children));
                return;
            case 'quote':
            case 'note': {
                if (b.label && displayType === 'disclosure') emit(isAsset, b.label);
                if (b.blocks) {
                    for (const sub of b.blocks) emitBlock(sub, displayType);
                } else {
                    emit(isAsset, typstInlineText(b.children));
                }
                return;
            }
            case 'list':
                for (const item of b.items ?? []) for (const sub of item.blocks ?? []) emitBlock(sub, displayType);
                return;
            case 'code': {
                emit(isAsset, b.header);
                emit(isAsset, b.text);
                return;
            }
            case 'math':
                emit(isAsset, b.latex);
                return;
            case 'table':
                if (b.caption) emit(isAsset, typstInlineText(b.caption));
                for (const row of b.headers ?? []) for (const cell of row) emit(isAsset, typstInlineText(cell.children));
                for (const row of b.rows ?? []) for (const cell of row) emit(isAsset, typstInlineText(cell.children));
                return;
            case 'image':
                if (b.caption) emit(isAsset, typstInlineText(b.caption));
                return;
            case 'file':
                emit(isAsset, b.name);
                // The template renders authored descriptions below file cards.
                if (b.description) emit(isAsset, typstInlineText(b.description));
                return;
            case 'unknown':
                if (b.fallback) emit(isAsset, b.fallback);
                if (b.details) emit(isAsset, typstInlineText(b.details));
                if (b.blocks) {
                    for (const sub of b.blocks) emitBlock(sub, displayType);
                }
                return;
            default:
                return;
        }
    };
    if (payload.title) body.push(normalizeLine(payload.title));
    for (const [messageIndex, msg] of (payload.messages ?? []).entries()) {
        const sourceMessage = document.messages[messageIndex];
        const cblocks: any[] = sourceMessage?.blocks ?? [];
        // toRenderMessage maps display blocks 1:1, optionally prepending one
        // role-prefix note (system/developer/unknown roles only).
        const offset = ['system', 'developer', 'unknown'].includes(sourceMessage.role) ? 1 : 0;
        (msg.blocks ?? []).forEach((b: any, j: number) => {
            emitBlock(b, cblocks[j - offset]?.type);
        });
        for (const a of msg.attachments ?? []) {
            if (a.type === 'file') emit(true, a.name);
            else {
                emit(true, a.name);
                if (a.meta) emit(true, a.meta);
            }
        }
    }
    return { body: body.filter(Boolean), asset: asset.filter((line, index) => !!line && line !== asset[index - 1]) };
}

/** Order-preserving subsequence: first needle missing from haystack, else null. */
function firstMissing(needles: string[], haystack: string[]): string | null {
    let h = 0;
    for (const n of needles) {
        let found = false;
        while (h < haystack.length) {
            if (haystack[h] === n) { found = true; h++; break; }
            h++;
        }
        if (!found) return n;
    }
    return null;
}

function assertBidirectionalParity(name: string, htmlParts: TextParts, pdfParts: TextParts): void {
    for (const part of ['body', 'asset'] as const) {
        const dropped = firstMissing(htmlParts[part], pdfParts[part]);
        assert.strictEqual(dropped, null,
            `${name}: HTML ${part} line has no PDF counterpart (content dropped by PDF path): ${JSON.stringify(dropped)}`);
        const phantom = firstMissing(pdfParts[part], htmlParts[part]);
        assert.strictEqual(phantom, null,
            `${name}: PDF ${part} line has no HTML counterpart (phantom PDF content): ${JSON.stringify(phantom)}`);
    }
}

interface ParityInputs {
    htmlParts: TextParts;
    pdfParts: TextParts;
    payload: any;
    diagnostics: Array<{ code: string; severity: string }>;
    htmlDiagnostics: Array<{ code: string }>;
}

async function parityInputs(name: string): Promise<ParityInputs> {
    const { document } = loadFixture(name);
    const { html, diagnostics: htmlDiagnostics } = renderDocumentHtml(document, {}, { locale: 'zh' }) as {
        html: string; diagnostics: Array<{ code: string }>;
    };
    const htmlParts = await htmlTextParts(html);
    // Empty preparation exercises the visible unavailable-resource path.
    const { payload, diagnostics } = renderTypstFixture(document, {}, { locale: 'zh' }) as {
        payload: any; diagnostics: Array<{ code: string; severity: string }>;
    };
    const pdfParts = typstTextParts(payload, document);
    return { htmlParts, pdfParts, payload, diagnostics, htmlDiagnostics };
}

for (const name of fixtureNames) {
    // math-cjk carries a known, explicitly asserted citation degradation and
    // is covered by its own test below instead of the generic loop.
    if (name === 'math-cjk.json') continue;
    test(`parity corpus: HTML-vs-PDF text parity for ${name}`, async () => {
        const { htmlParts, pdfParts, diagnostics, htmlDiagnostics } = await parityInputs(name);
        assertBidirectionalParity(name, htmlParts, pdfParts);
        if (name === 'image-attachment.json') {
            // This fixture supplies no prepared bytes: both renderers
            // must degrade VISIBLY (placeholder text + diagnostic), never by
            // silently dropping the attachment.
            const codes = diagnostics.map((d) => d.code);
            assert.ok(codes.includes('TYPST_V8_IMAGE_MISSING'), 'PDF path must flag missing block images');
            assert.ok(codes.includes('TYPST_V8_INLINE_IMAGE_MISSING'), 'PDF path must flag missing inline images');
            assert.ok(
                htmlDiagnostics.some((d) => d.code === 'HTML_ASSET_UNRESOLVED'),
                'HTML path must flag unresolvable assets',
            );
        }
    });
}

test('parity corpus: math-cjk citation titles keep fidelity on both sides', async () => {
    const name = 'math-cjk.json';
    const { htmlParts, pdfParts } = await parityInputs(name);

    const citeTitle = '微积分基本定理';
    assert.ok(htmlParts.body.some((l) => l.includes(citeTitle)), 'HTML shows the citation title');
    assert.ok(
        pdfParts.body.some((l) => l.includes(citeTitle)),
        'PDF shows the citation title (label fidelity, no longer degraded to [n])',
    );

    const htmlPara = htmlParts.body.find((l) => l.includes('牛顿—莱布尼茨公式'));
    const pdfPara = pdfParts.body.find((l) => l.includes('牛顿—莱布尼茨公式'));
    assert.ok(htmlPara !== undefined && pdfPara !== undefined, 'citation paragraph must exist on both sides');
    assert.ok(
        pdfPara?.includes('它把定积分转化为求原函数的过程'),
        'PDF keeps the paragraph text around the citation',
    );

    assertBidirectionalParity(
        name,
        { body: htmlParts.body, asset: htmlParts.asset },
        { body: pdfParts.body, asset: pdfParts.asset },
    );
});
