/**
 * tests/canonical-parser-hardening.test.ts
 * Tier 1 tests for the F2 canonical Markdown parser hardening:
 * display-math block policy (P0 formal case), borderless tables, escaped /
 * code-span pipes, balanced-paren link targets, first-class inline images
 * (bare / linked / reuse / missing / multi), nested emphasis, and malformed
 * input preservation.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const canonical = require('../src/core/export/canonical/index.js');
const { normalizeGeminiConversation, validateBundle } = canonical;

async function norm(content: string, extra?: Record<string, unknown>) {
    const raw: any = {
        id: 'c1',
        messages: [{ id: 'm1', role: 'user', content, ...(extra || {}) }],
    };
    const { bundle, diagnostics } = await normalizeGeminiConversation(raw);
    return { bundle, diagnostics, msg: bundle.conversation.messages[0] };
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
    assert.strictEqual(msg.blocks.length, 1);
    const p = msg.blocks[0];
    assert.strictEqual(p.type, 'paragraph');
    const kinds = p.children.map((c: any) => c.type);
    assert.deepStrictEqual(kinds, ['inlineMath', 'text']);
    assert.strictEqual(p.children[0].source, 'F_n = \\\\frac{a}{b}');
    assert.ok(p.children[1].text.includes('其中 text。'));
    assert.ok(!diagnostics.some((d: any) => d.code === 'MATH_BLOCK_EMPTY'));
});

test('standalone display formula is a MathBlock', async () => {
    const { msg } = await norm('$$x^2 + y^2$$');
    assert.strictEqual(msg.blocks.length, 1);
    assert.strictEqual(msg.blocks[0].type, 'math');
    assert.strictEqual(msg.blocks[0].source, 'x^2 + y^2');
});

test('multiple formulas on one line all survive as inline math', async () => {
    const { msg } = await norm('$$a$$ and $$b$$ done');
    assert.strictEqual(msg.blocks.length, 1);
    const kinds = msg.blocks[0].children.map((c: any) => c.type);
    assert.deepStrictEqual(kinds, ['inlineMath', 'text', 'inlineMath', 'text']);
    assert.strictEqual(msg.blocks[0].children[0].source, 'a');
    assert.strictEqual(msg.blocks[0].children[2].source, 'b');
});

test('unclosed display-math fence keeps the lines and raises a diagnostic', async () => {
    const { msg, diagnostics } = await norm('$$\nE = mc^2\nstill open');
    assert.strictEqual(msg.blocks[0].type, 'math');
    assert.ok(msg.blocks[0].source.includes('E = mc^2'));
    assert.ok(
        diagnostics.some((d: any) => d.code === 'MATH_FENCE_UNCLOSED'),
        'MATH_FENCE_UNCLOSED raised',
    );
});

test('borderless table parses without leading/trailing pipes', async () => {
    const { msg } = await norm('a | b\n--- | ---\n1 | 2\n');
    const t = msg.blocks.find((b: any) => b.type === 'table');
    assert.ok(t, 'table found');
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
    const t = msg.blocks.find((b: any) => b.type === 'table');
    assert.ok(t, 'table found');
    const body = t.rows[t.rows.length - 1];
    assert.deepStrictEqual(
        body.cells.map((c: any) => inlineText(c.children)),
        ['x|y', 'z|w'],
    );
});

test('link target with balanced parentheses is preserved', async () => {
    const { msg } = await norm('[x](https://a/b_(c))');
    const link = msg.blocks[0].children.find((c: any) => c.type === 'link');
    assert.ok(link, 'link found');
    assert.strictEqual(link.href, 'https://a/b_(c)');
});

test('bare remote image becomes a first-class ImageInline with a remote asset', async () => {
    const { bundle, msg } = await norm('see ![alt text](https://example.com/i.png) here');
    const img = msg.blocks[0].children.find((c: any) => c.type === 'image');
    assert.ok(img, 'image inline found');
    assert.strictEqual(img.alt, 'alt text');
    const asset = bundle.assets.find((a: any) => a.id === img.assetId);
    assert.ok(asset, 'asset registered');
    assert.strictEqual(asset.status, 'remote');
    assert.strictEqual(asset.sourceUrl, 'https://example.com/i.png');
    assert.deepStrictEqual(validateBundle(bundle).filter((d: any) => d.severity === 'error'), []);
});

test('linked image parses as link wrapping an ImageInline', async () => {
    const { bundle, msg } = await norm('[![alt](https://example.com/i.png)](https://example.com/page)');
    const link = msg.blocks[0].children.find((c: any) => c.type === 'link');
    assert.ok(link, 'link found');
    assert.strictEqual(link.href, 'https://example.com/page');
    assert.strictEqual(link.children.length, 1);
    assert.strictEqual(link.children[0].type, 'image');
    assert.strictEqual(link.children[0].alt, 'alt');
    assert.ok(bundle.assets.some((a: any) => a.id === link.children[0].assetId), 'asset registered');
});

test('inline image reuses the matching attachment asset', async () => {
    const { bundle, msg } = await norm('see ![pic](assets/shot.png) here', {
        attachments: [{ localName: 'assets/shot.png', mimeType: 'image/png' }],
    });
    const img = msg.blocks[0].children.find((c: any) => c.type === 'image');
    assert.ok(img, 'image inline found');
    assert.strictEqual(img.assetId, 'm1-a0');
    assert.strictEqual(bundle.assets.length, 1);
});

test('image with no resolvable source is missing and raises a diagnostic', async () => {
    const { bundle, msg, diagnostics } = await norm('x ![]() y');
    const img = msg.blocks[0].children.find((c: any) => c.type === 'image');
    assert.ok(img, 'image inline found');
    const asset = bundle.assets.find((a: any) => a.id === img.assetId);
    assert.ok(asset, 'asset registered');
    assert.strictEqual(asset.status, 'missing');
    assert.ok(
        diagnostics.some((d: any) => d.code === 'INLINE_IMAGE_ASSET_MISSING'),
        'INLINE_IMAGE_ASSET_MISSING raised',
    );
});

test('multiple images in one paragraph each get their own asset', async () => {
    const { bundle, msg } = await norm('![one](https://example.com/1.png) ![two](https://example.com/2.png)');
    const imgs = msg.blocks[0].children.filter((c: any) => c.type === 'image');
    assert.strictEqual(imgs.length, 2);
    assert.notStrictEqual(imgs[0].assetId, imgs[1].assetId);
    assert.strictEqual(bundle.assets.length, 2);
});

test('nested emphasis: strong containing emphasis', async () => {
    const { msg } = await norm('**bold *bold-italic* end**');
    const strong = msg.blocks[0].children.find((c: any) => c.type === 'strong');
    assert.ok(strong, 'strong found');
    const kinds = strong.children.map((c: any) => c.type);
    assert.deepStrictEqual(kinds, ['text', 'emphasis', 'text']);
    assert.strictEqual(inlineText(strong.children), 'bold bold-italic end');
});

test('nested emphasis: emphasis containing strong', async () => {
    const { msg } = await norm('*italic **bold** end*');
    const em = msg.blocks[0].children.find((c: any) => c.type === 'emphasis');
    assert.ok(em, 'emphasis found');
    const kinds = em.children.map((c: any) => c.type);
    assert.deepStrictEqual(kinds, ['text', 'strong', 'text']);
});

test('triple-star and strikethrough keep their node shapes', async () => {
    const { msg } = await norm('***both*** and ~~gone~~');
    const first = msg.blocks[0].children[0];
    const hasBoth = (first.type === 'strong' && first.children[0].type === 'emphasis') ||
                    (first.type === 'emphasis' && first.children[0].type === 'strong');
    assert.ok(hasBoth, 'both strong and emphasis found');
    const strike = msg.blocks[0].children.find((c: any) => c.type === 'strikethrough');
    assert.ok(strike, 'strikethrough found');
});

test('unclosed emphasis markers stay literal text', async () => {
    const { msg } = await norm('**unclosed and *also');
    assert.deepStrictEqual(
        msg.blocks[0].children.map((c: any) => c.type),
        ['text'],
    );
    assert.ok(msg.blocks[0].children[0].text.includes('**unclosed'));
});

test('dollar prices are not treated as math', async () => {
    const { msg } = await norm('price is $5 and $10');
    assert.deepStrictEqual(
        msg.blocks[0].children.map((c: any) => c.type),
        ['text'],
    );
    assert.ok(msg.blocks[0].children[0].text.includes('$5 and $10'));
});
