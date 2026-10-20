/**
 * tests/canonical-generated-image-consistency.test.ts
 * Tier 1 unit tests for PR 3: Asset Placement & Single Placement Contract.
 *
 * Verifies:
 * 1. Single generated image -> 1 inline figure, 0 companion cards
 * 2. Multiple generated images -> N inline figures, 0 companion cards, each path appears exactly once
 * 3. Uploaded image attachment (user turn) -> 1 inline figure, 0 companion cards
 * 4. Inline Markdown image attachment -> 0 duplicate companion cards
 * 5. Real-world 040ffd Imagen regression shape (model text + 6 generated images, placed exactly once)
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const canonical = require('../src/core/export/canonical/index.js');
const { normalizeGeminiConversation, renderCanonicalHtml } = canonical;

test('PR 3 - 1: Single generated image on model turn renders 1 inline figure and no companion cards', async () => {
    const raw: any = {
        id: 'c_gen_single',
        title: 'Single Imagen Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Here is your generated image of a martian cat.',
                images: [
                    {
                        type: 'image',
                        name: 'martian_cat.png',
                        localName: 'assets/martian_cat.png',
                        url: 'https://example.com/martian_cat.png',
                    },
                ],
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(raw);
    const msg = bundle.conversation.messages[0];

    // Canonical AST check
    const imgBlock = msg.blocks.find((b: any) => b.type === 'image');
    assert.ok(imgBlock, 'ImageBlock must exist in canonical blocks');

    // HTML Rendering check
    const { html, diagnostics } = renderCanonicalHtml(bundle);
    assert.strictEqual(diagnostics.length, 0, 'Expected zero diagnostics for resolvable image');

    // 1 inline visual figure in model content
    const inlineFigures = html.match(/<figure class="gem-figure gem-image-block"/g) || [];
    assert.strictEqual(inlineFigures.length, 1, 'Expected exactly 1 inline <figure> in model content');
    assert.ok(html.includes('class="gem-msg-img"'), 'Expected inline image to have gem-msg-img class');
    assert.ok(html.includes('src="assets/martian_cat.png"'), 'Expected image URL in inline img src');

    // No companion cards or carousel
    const cards = html.match(/<a class="gem-att-card/g) || [];
    assert.strictEqual(cards.length, 0, 'No companion card should be rendered');
    assert.ok(!html.includes('gem-carousel'), 'No carousel should be rendered');

    // Image appears in exactly 1 figure
    const srcCount = html.split('src="assets/martian_cat.png"').length - 1;
    assert.strictEqual(srcCount, 1, 'Image src must appear exactly once in rendered HTML');
});

test('PR 3 - 2: Multiple generated images on model turn render N inline figures and no companion cards', async () => {
    const images = [
        { type: 'image', name: 'cat_variant_1.png', localName: 'assets/cat_1.png', url: 'https://example.com/cat_1.png' },
        { type: 'image', name: 'cat_variant_2.png', localName: 'assets/cat_2.png', url: 'https://example.com/cat_2.png' },
        { type: 'image', name: 'cat_variant_3.png', localName: 'assets/cat_3.png', url: 'https://example.com/cat_3.png' },
        { type: 'image', name: 'cat_variant_4.png', localName: 'assets/cat_4.png', url: 'https://example.com/cat_4.png' },
    ];

    const raw: any = {
        id: 'c_gen_multi',
        title: 'Multiple Imagen Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Here are 4 variants of your request.',
                images,
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(raw);
    const msg = bundle.conversation.messages[0];

    const imgBlocks = msg.blocks.filter((b: any) => b.type === 'image');
    assert.strictEqual(imgBlocks.length, 4, 'Expected 4 canonical ImageBlocks');

    const { html, diagnostics } = renderCanonicalHtml(bundle);
    assert.strictEqual(diagnostics.length, 0, 'Expected zero diagnostics');

    // N inline figures
    const inlineFigures = html.match(/<figure class="gem-figure gem-image-block"/g) || [];
    assert.strictEqual(inlineFigures.length, 4, 'Expected 4 inline figures');

    // No companion cards or carousel
    const cards = html.match(/<a class="gem-att-card/g) || [];
    assert.strictEqual(cards.length, 0, 'Expected 0 companion cards');
    assert.ok(!html.includes('gem-carousel'), 'No carousel should be rendered');

    // Verify all 4 paths exist in exactly 1 figure each
    for (let i = 1; i <= 4; i++) {
        const path = `assets/cat_${i}.png`;
        const count = html.split(`src="${path}"`).length - 1;
        assert.strictEqual(count, 1, `Expected src="${path}" to appear exactly once in HTML, found ${count}`);
    }
});

test('PR 3 - 3: User uploaded image attachment renders 1 inline figure and no companion cards', async () => {
    const raw: any = {
        id: 'c_user_upload',
        title: 'User Upload Test',
        messages: [
            {
                id: 'u1',
                role: 'user',
                content: 'Analyze this photo from my garden.',
                attachments: [
                    {
                        type: 'image',
                        name: 'garden_photo.jpg',
                        localName: 'assets/garden_photo.jpg',
                        url: 'https://example.com/garden_photo.jpg',
                    },
                ],
            },
            {
                id: 'm1',
                role: 'model',
                content: 'That looks like a beautiful rose garden.',
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(raw);
    const userMsg = bundle.conversation.messages[0];

    // Canonical AST check
    const userImgBlock = userMsg.blocks.find((b: any) => b.type === 'image');
    assert.ok(userImgBlock, 'User image block must exist');

    const { html } = renderCanonicalHtml(bundle);

    const userTurn = html.slice(html.indexOf('<section class="gem-turn gem-turn-user"'), html.indexOf('<section class="gem-turn gem-turn-model"'));
    assert.ok(userTurn.includes('gem-image-block'), 'User prompt contains inline figure');
    assert.ok(userTurn.includes('gem-msg-img'), 'User prompt contains gem-msg-img');
    assert.ok(userTurn.includes('garden_photo.jpg'), 'User prompt contains garden_photo.jpg');

    // No companion cards or carousel
    const userCards = userTurn.match(/<a class="gem-att-card/g) || [];
    assert.strictEqual(userCards.length, 0, 'Expected 0 companion cards in user turn');
    assert.ok(!userTurn.includes('gem-carousel'), 'No carousel in user turn');
});

test('PR 3 - 4: Generated image with explicit markdown embed does not produce duplicate cards', async () => {
    const raw: any = {
        id: 'c_markdown_dedup',
        title: 'Markdown Embed Dedup Test',
        messages: [
            {
                id: 'm1',
                role: 'model',
                content: 'Here is the generated output:\n\n![Generated Image](assets/generated_preview.png)',
                attachments: [
                    {
                        type: 'image',
                        localName: 'assets/generated_preview.png',
                        name: 'generated_preview.png',
                        url: 'https://example.com/generated_preview.png',
                        isGenerated: true,
                    },
                ],
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(raw);
    const { html } = renderCanonicalHtml(bundle);

    // Markdown inline image rendered
    assert.ok(html.includes('gem-inline-img') || html.includes('gem-image-block'), 'Expected inline image to be rendered');
    assert.ok(html.includes('assets/generated_preview.png'), 'Expected asset path in HTML');

    // No duplicate companion cards for inline markdown image
    const cards = html.match(/<a class="gem-att-card/g) || [];
    assert.strictEqual(cards.length, 0, 'Explicit inline markdown image should not generate redundant companion cards');
    assert.ok(!html.includes('gem-carousel'), 'No carousel should be rendered');

    // Image path appears exactly once
    const count = html.split('assets/generated_preview.png').length - 1;
    assert.strictEqual(count, 1, 'Path must appear exactly once in HTML');
});

test('PR 3 - 5: Real-world 040ffd Imagen regression shape (model text + 6 generated images)', async () => {
    const rawImages = [
        { type: 'image', name: 'cat_01.jpg', localName: 'assets/cat_01.jpg', url: 'https://example.com/cat_01.jpg' },
        { type: 'image', name: 'cat_02.jpg', localName: 'assets/cat_02.jpg', url: 'https://example.com/cat_02.jpg' },
        { type: 'image', name: 'cat_03.jpg', localName: 'assets/cat_03.jpg', url: 'https://example.com/cat_03.jpg' },
        { type: 'image', name: 'cat_04.jpg', localName: 'assets/cat_04.jpg', url: 'https://example.com/cat_04.jpg' },
        { type: 'image', name: 'cat_05.jpg', localName: 'assets/cat_05.jpg', url: 'https://example.com/cat_05.jpg' },
        { type: 'image', name: 'cat_06.jpg', localName: 'assets/cat_06.jpg', url: 'https://example.com/cat_06.jpg' },
    ];

    const raw: any = {
        id: '97f22329fd040ffd',
        title: 'Martian Astronaut Cat Drinking Coffee',
        messages: [
            {
                id: 'msg-0',
                role: 'user',
                content: 'Generate images of a martian astronaut cat drinking coffee on Mars.',
            },
            {
                id: 'msg-1',
                role: 'model',
                content: 'Here are several concepts of a martian astronaut cat enjoying coffee on Mars:',
                images: rawImages,
                attachments: rawImages,
            },
        ],
    };

    const { bundle } = await normalizeGeminiConversation(raw);
    const modelMsg = bundle.conversation.messages[1];

    // Verify deduplication in normalizeMessage (rawImages passed in both images and attachments)
    const imgBlocks = modelMsg.blocks.filter((b: any) => b.type === 'image');
    assert.strictEqual(imgBlocks.length, 6, 'Expected exactly 6 image blocks after attachment deduplication');

    const { html, diagnostics } = renderCanonicalHtml(bundle);
    assert.strictEqual(diagnostics.length, 0, 'Expected zero diagnostics');

    // Verify model content is NOT empty
    const modelTurn = html.slice(html.indexOf('gem-turn-model'));
    const modelContentMatch = modelTurn.match(/<div class="gem-model-content">([\s\S]*?)<\/div>/);
    assert.ok(modelContentMatch, 'gem-model-content must exist in model turn');
    const modelContent = modelContentMatch[1];

    // Must contain intro text
    assert.ok(modelContent.includes('Here are several concepts'), 'gem-model-content must contain the model text response');

    // Must contain all 6 inline figures
    const inlineFigures = modelContent.match(/<figure class="gem-figure gem-image-block"/g) || [];
    assert.strictEqual(inlineFigures.length, 6, 'gem-model-content must contain all 6 generated images inline');

    // No companion download cards or carousel
    const cards = modelTurn.match(/<a class="gem-att-card/g) || [];
    assert.strictEqual(cards.length, 0, 'No companion download cards should be rendered');
    assert.ok(!modelTurn.includes('gem-carousel'), 'No carousel should be rendered');

    // Verify all 6 paths appear in exactly 1 figure each
    for (let i = 1; i <= 6; i++) {
        const path = `assets/cat_0${i}.jpg`;
        const count = html.split(`src="${path}"`).length - 1;
        assert.strictEqual(count, 1, `Expected src="${path}" to appear exactly once in HTML, found ${count}`);
    }
});
