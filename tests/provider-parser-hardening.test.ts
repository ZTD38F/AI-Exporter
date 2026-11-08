import { fixtureAccountFor } from './helpers/domainFixture.js';
const { historicalFixture } = require('./helpers/nativeFixture.js');
/**
 * tests/provider-parser-hardening.test.ts
 * Tier 1 tests for the F2 canonical Markdown parser hardening:
 * display-math block policy (P0 formal case), borderless tables, escaped /
 * code-span pipes, balanced-paren link targets, first-class inline images
 * (bare / linked / reuse / missing / multi), nested emphasis, and malformed
 * input preservation.
 */
export {};
const test = require('node:test');
import assert from 'node:assert/strict';

const { assertDomainClosure } = require('../src/l2/closure.js');
const { composeDomainDocument } = require('../src/l3b/compose/composeDomainDocument.js');
const { renderDocumentHtml } = require('../src/l4/format/html/renderHtml.js');

async function norm(content: string, extra?: Record<string, unknown>) {
    const raw: any = {
        id: 'c1',
        messages: [{ id: 'm1', role: 'user', content, ...(extra || {}) }],
    };
    const { conversation: domain, diagnostics } = await historicalFixture(raw, { providerId: 'gemini' });
    return { domain, diagnostics, msg: domain.detail.messages[0] };
}

function inlineText(nodes: any[]): string {
    return nodes
        .map((n) => {
            if (n.type === 'text' || n.type === 'inlineCode') return n.text ?? n.code ?? '';
            if (n.type === 'inlineMath') return `$${n.source}$`;
            if (n.type === 'image') return `[img:${n.alt ?? ''}]`;
            if (n.children) return inlineText(n.children);
            return '';
        })
        .join('');
}

test('F1: display formula with trailing text keeps both, never an empty MathBlock', async () => {
    const { msg, diagnostics } = await norm('$$F_n = \\\\frac{a}{b}$$ 其中 text。');
    assert.strictEqual(msg.content.length, 1);
    const p = msg.content[0];
    assert.strictEqual(p.type, 'paragraph');
    assert.ok(p?.type === 'paragraph');
    const kinds = p.children.map((c: any) => c.type);
    assert.deepStrictEqual(kinds, ['inlineMath', 'text']);
    assert.strictEqual(p.children[0].source, 'F_n = \\\\frac{a}{b}');
    assert.ok(p.children[1].text.includes('其中 text。'));
    assert.ok(!diagnostics.some((d: any) => d.code === 'MATH_BLOCK_EMPTY'));
});

test('standalone display formula is a MathBlock', async () => {
    const { msg } = await norm('$$x^2 + y^2$$');
    assert.strictEqual(msg.content.length, 1);
    assert.strictEqual(msg.content[0].type, 'math');
    assert.ok(msg.content[0]?.type === 'math');
    assert.strictEqual(msg.content[0].source, 'x^2 + y^2');
});

test('multiple formulas on one line all survive as inline math', async () => {
    const { msg } = await norm('$$a$$ and $$b$$ done');
    assert.strictEqual(msg.content.length, 1);
    const kinds = msg.content[0].children.map((c: any) => c.type);
    assert.deepStrictEqual(kinds, ['inlineMath', 'text', 'inlineMath', 'text']);
    assert.strictEqual(msg.content[0].children[0].source, 'a');
    assert.strictEqual(msg.content[0].children[2].source, 'b');
});

test('unclosed display-math fence keeps the lines and raises a diagnostic', async () => {
    const { msg, diagnostics } = await norm('$$\nE = mc^2\nstill open');
    assert.strictEqual(msg.content[0].type, 'math');
    assert.ok(msg.content[0]?.type === 'math');
    assert.ok(msg.content[0].source.includes('E = mc^2'));
    assert.ok(
        diagnostics.some((d: any) => d.code === 'MATH_FENCE_UNCLOSED'),
        'MATH_FENCE_UNCLOSED raised',
    );
});

test('borderless table parses without leading/trailing pipes', async () => {
    const { msg } = await norm('a | b\n--- | ---\n1 | 2\n');
    const t = msg.content.find((b: any) => b.type === 'table');
    assert.ok(t?.type === 'table');
    assert.strictEqual(t.headerRows.length, 1);
    assert.strictEqual(t.rows.length, 1);
    assert.deepStrictEqual(
        t.headerRows[0].cells.map((c: any) => inlineText(c.children)),
        ['a', 'b'],
    );
    assert.deepStrictEqual(
        t.rows[0].cells.map((c: any) => inlineText(c.children)),
        ['1', '2'],
    );
});

test('escaped pipes and code-span pipes do not split columns', async () => {
    const { msg } = await norm('| a | b |\n| --- | --- |\n| `x\\|y` | z\\|w |\n');
    const t = msg.content.find((b: any) => b.type === 'table');
    assert.ok(t?.type === 'table');
    const body = t.rows[t.rows.length - 1];
    assert.deepStrictEqual(
        body.cells.map((c: any) => inlineText(c.children)),
        ['x|y', 'z|w'],
    );
});

test('link target with balanced parentheses is preserved', async () => {
    const { msg } = await norm('[x](https://a/b_(c))');
    const link = msg.content[0].children.find((c: any) => c.type === 'link');
    assert.ok(link?.type === 'link');
    assert.strictEqual(link.href, 'https://a/b_(c)');
});

test('bare remote image becomes a first-class ImageInline with a remote asset', async () => {
    const { domain, msg } = await norm('see ![alt text](https://example.com/i.png) here');
    const img = msg.content[0].children.find((c: any) => c.type === 'image');
    assert.ok(img?.type === 'image');
    assert.strictEqual(img.alt, 'alt text');
    const asset = domain.detail.assets.find((a: any) => a.id === img.assetId);
    assert.ok(asset, 'asset registered');
    assert.strictEqual(asset.sourceUri, 'https://example.com/i.png');
    assert.doesNotThrow(() => assertDomainClosure((domain).detail));
});

test('linked image parses as link wrapping an ImageInline', async () => {
    const { domain, msg } = await norm('[![alt](https://example.com/i.png)](https://example.com/page)');
    const link = msg.content[0].children.find((c: any) => c.type === 'link');
    assert.ok(link?.type === 'link');
    assert.strictEqual(link.href, 'https://example.com/page');
    assert.strictEqual(link.children.length, 1);
    assert.strictEqual(link.children[0].type, 'image');
    assert.ok(link.children[0]?.type === 'image');
    assert.strictEqual(link.children[0].alt, 'alt');
    assert.ok(domain.detail.assets.some((a: any) => a.id === link.children[0].assetId), 'asset registered');
});

test('inline image reuses the matching attachment asset', async () => {
    const { domain, msg } = await norm('see ![pic](assets/shot.png) here', {
        attachments: [{ localName: 'assets/shot.png', mimeType: 'image/png' }],
    });
    const img = msg.content[0].children.find((c: any) => c.type === 'image');
    assert.ok(img?.type === 'image');
    assert.strictEqual(img.assetId, domain.detail.assets[0].id);
    assert.strictEqual(domain.detail.assets.length, 1);
});

test('image with no source remains a semantic asset and the backend reports unavailable resources', async () => {
    const { domain, msg, diagnostics } = await norm('x ![]() y');
    const img = msg.content[0].children.find((c: any) => c.type === 'image');
    assert.ok(img?.type === 'image');
    const asset = domain.detail.assets.find((a: any) => a.id === img.assetId);
    assert.ok(asset, 'asset registered');
    assert.ok(!asset.sourceUri);
    assert.doesNotThrow(() => assertDomainClosure((domain).detail));
    const rendered = renderDocumentHtml(composeDomainDocument(domain, fixtureAccountFor(domain)), {});
    assert.ok(rendered.diagnostics.some((d: any) => d.code === 'HTML_ASSET_UNRESOLVED'));
    assert.ok(rendered.html.includes('gem-missing-asset'));
});

test('multiple images in one paragraph each get their own asset', async () => {
    const { domain, msg } = await norm('![one](https://example.com/1.png) ![two](https://example.com/2.png)');
    const imgs = msg.content[0].children.filter((c: any) => c.type === 'image');
    assert.strictEqual(imgs.length, 2);
    assert.notStrictEqual(imgs[0].assetId, imgs[1].assetId);
    assert.strictEqual(domain.detail.assets.length, 2);
});

test('nested emphasis: strong containing emphasis', async () => {
    const { msg } = await norm('**bold *bold-italic* end**');
    const strong = msg.content[0].children.find((c: any) => c.type === 'strong');
    assert.ok(strong?.type === 'strong');
    const kinds = strong.children.map((c: any) => c.type);
    assert.deepStrictEqual(kinds, ['text', 'emphasis', 'text']);
    assert.strictEqual(inlineText(strong.children), 'bold bold-italic end');
});

test('nested emphasis: emphasis containing strong', async () => {
    const { msg } = await norm('*italic **bold** end*');
    const em = msg.content[0].children.find((c: any) => c.type === 'emphasis');
    assert.ok(em?.type === 'emphasis');
    const kinds = em.children.map((c: any) => c.type);
    assert.deepStrictEqual(kinds, ['text', 'strong', 'text']);
});

test('triple-star and strikethrough keep their node shapes', async () => {
    const { msg } = await norm('***both*** and ~~gone~~');
    const first = msg.content[0].children[0];
    const hasBoth = (first.type === 'strong' && first.children[0].type === 'emphasis') ||
                    (first.type === 'emphasis' && first.children[0].type === 'strong');
    assert.ok(hasBoth, 'both strong and emphasis found');
    const strike = msg.content[0].children.find((c: any) => c.type === 'strikethrough');
    assert.ok(strike?.type === 'strikethrough');
});

test('unclosed emphasis markers stay literal text', async () => {
    const { msg } = await norm('**unclosed and *also');
    assert.deepStrictEqual(
        msg.content[0].children.map((c: any) => c.type),
        ['text'],
    );
    assert.ok(msg.content[0].children[0].text.includes('**unclosed'));
});

test('dollar prices are not treated as math', async () => {
    const { msg } = await norm('price is $5 and $10');
    assert.deepStrictEqual(
        msg.content[0].children.map((c: any) => c.type),
        ['text'],
    );
    assert.ok(msg.content[0].children[0].text.includes('$5 and $10'));
});
