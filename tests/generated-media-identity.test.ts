export {};
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TakeoutEngine } = require('../src/core/engine/takeoutEngine.js');
const { supplementTakeoutGeneratedMedia } = require('../src/core/engine/export/batchWorker.js');
const { normalizeGeminiConversation } = require('../src/core/export/canonical/index.js');
const { parseTakeoutHtmlBlocks, correlateGeneratedImages } = require('../src/core/engine/takeout/takeoutHtmlParser.js');

const id = '1bd028d5c5b0c0e2';
const prompt = 'Generate an image of a cute futuristic astronaut cat drinking coffee on Mars with high detail';
const time = Date.parse('2026-09-02T18:36:40.472Z');
const png = 'watermarked_img_45281370108017511-1c81efe352c9ef8a.png';
const jpg = 'watermarked_img_4528137010801751197.jpg';
function onlineChat(): any {
    return { id, messages: [
        { id: 'r_1c81efe352c9ef8a', role: 'user', content: prompt, timestamp: time },
        { id: 'm1', role: 'model', providerRequestId: '1c81efe352c9ef8a', content: '', images: [{
            type: 'image', fileName: jpg, sourceUrl: 'https://lh3.googleusercontent.com/generated-cat',
            localName: `assets/${jpg}`, isGenerated: true, providerRequestId: '1c81efe352c9ef8a', imageOrdinal: 0
        }] },
    ] };
}

test('real Takeout fixture preserves event metadata through MediaIndex and dedupes the online JPG', async () => {
    (global as any).JSZip = require('../lib/jszip.min.js');
    TakeoutEngine.clearTakeoutData('identity');
    try {
        await TakeoutEngine.parseTakeoutZip(fs.readFileSync(path.join(__dirname, 'fixtures/gemini_takeout_clean.zip')), null, 'identity');
        const media = TakeoutEngine.getTakeoutMediaForChat(id, 'identity');
        assert.equal(media[0].filename, png);
        assert.deepEqual(media[0].generation, {
            chatId: id, time: Math.floor(time / 1000) * 1000, prompt,
            generationOrdinal: 0, imageCount: 1, imageOrdinal: 0,
            providerRequestId: '1c81efe352c9ef8a',
        });
        const offline = TakeoutEngine.getTakeoutOfflineChat(id, 'identity');
        assert.equal(offline.messages.find((m: any) => m.role === 'model').images[0].generation.prompt, prompt);
        const chat = onlineChat();
        supplementTakeoutGeneratedMedia(chat, id, 'identity', TakeoutEngine);
        assert.equal(chat.messages[1].images.length, 1);
        assert.equal(chat.messages[1].images[0].fileName, jpg);
        assert.equal((chat.messages[1] as any).generation.turnId, 'm1');
        const { bundle } = await normalizeGeminiConversation(chat);
        assert.equal(bundle.assets.filter((a: any) => a.kind === 'image').length, 1);
        // Dedupe retains the offline bytes under event identity even though names differ.
        const image = chat.messages[1].images[0];
        const bytes = await TakeoutEngine.getTakeoutFallbackMedia(id, jpg, 'identity', image.generation);
        assert.ok(bytes && bytes.length > 0);
        const { AssetPipeline } = require('../src/core/engine/assetPipeline.js');
        const pipeline = new AssetPipeline({
            currentSlot: 'identity', takeoutEngine: TakeoutEngine,
            fetchAsset: async () => ({ success: false, error: 'offline' }),
        });
        const acquired = await pipeline.acquireAssetBytes(image, chat, { isImage: true, maxRetries: 0 });
        assert.equal(acquired.ok, true);
        assert.equal(acquired.recoveredFromTakeout, true);
        assert.deepEqual(acquired.bytes, bytes);
        const { preparePdfItem } = require('../src/core/export/pdf/prepareItem.js');
        const pdf = await preparePdfItem(chat, {
            currentSlot: 'identity', takeoutEngine: TakeoutEngine,
            fetchAsset: async () => ({ success: false, error: 'offline' }), maxAssetRetries: 0,
        });
        assert.equal(pdf.ok, true);
        const pdfImages = pdf.bundle.assets.filter((asset: any) => asset.kind === 'image');
        assert.equal(pdfImages.length, 1);
        assert.deepEqual(pdf.byteStore.get(pdfImages[0].storageRef), bytes);

        assert.equal(await TakeoutEngine.getTakeoutFallbackMedia(id, jpg, 'identity', {
            ...image.generation, generationOrdinal: 99, providerRequestId: 'nonexistent',
        }), null);

    } finally { TakeoutEngine.clearTakeoutData('identity'); }
});

test('correlation attaches each image to its own generation turn rather than first model', async () => {
    const html = [0, 1].map(i => `<div class="outer-cell"><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted draw ${i}<br>1 generated image.<br>Sep 2, 2026, 11:${36 + i}:40 AM PDT<br></div>https://gemini.google.com/app/${id}</div>`).join('');
    const parsed = await parseTakeoutHtmlBlocks({ htmlText: html, zipFiles: {} });
    const images = parsed.genBlocks.map((b: any, i: number) => ({ filename: `generated-${i}.png`, fileObj: {}, time: b.time + 5000 }));
    correlateGeneratedImages(images, parsed.genBlocks, parsed.localMediaMap, parsed.localConvCache, parsed.extractedMap);
    const models = parsed.localConvCache[id].messages.filter((m: any) => m.role === 'model');
    assert.equal(models.length, 2);
    for (let i = 0; i < models.length; i++) {
        assert.equal(models[i].images.length, 1);
        assert.equal(models[i].images[0].fileName, `generated-${i}.png`);
        assert.equal(models[i].images[0].generation.generationOrdinal, i);
    }
});

test('different events and unproven multi-image ordinals are never suppressed', () => {
    const generation = { chatId: id, time: Math.floor(time / 1000) * 1000 + 60000, prompt, generationOrdinal: 1, imageCount: 1, imageOrdinal: 0 };
    const engine = { getTakeoutMediaForChat: () => [{ filename: png, isGenerated: true, generation }] };
    const chat = onlineChat();
    supplementTakeoutGeneratedMedia(chat, id, 'identity', engine);
    assert.equal(chat.messages.length, 3, 'distinct event is retained as its own turn');
    const multi = onlineChat();
    engine.getTakeoutMediaForChat = () => [{ filename: png, isGenerated: true, generation: { ...generation, time: time - 472, generationOrdinal: 0, imageCount: 2, imageOrdinal: undefined as any } }];
    supplementTakeoutGeneratedMedia(multi, id, 'identity', engine);
    assert.equal(multi.messages[1].images.length, 2, 'unknown image ordinal cannot justify deleting media');
});

test('ambiguous same-second repeated prompts do not dedupe', () => {
    const chat = onlineChat();
    chat.messages.push(...onlineChat().messages);
    const generation = { chatId: id, time: time - 472, prompt, generationOrdinal: 0, imageCount: 1, imageOrdinal: 0 };
    supplementTakeoutGeneratedMedia(chat, id, 'identity', { getTakeoutMediaForChat: () => [{ filename: png, isGenerated: true, generation }] });
    assert.equal(chat.messages.length, 5);
});


test('RPC generated-media detector preserves generated status while inline images remain unmarked', () => {
    const { extractImages } = require('../src/core/api/parser/attachments.js');
    const generated: any[] = Array(16).fill(null);
    generated[2] = jpg;
    generated[3] = 'https://lh3.googleusercontent.com/generated';
    generated[11] = 'image/jpeg';
    generated[15] = [512, 512, 1000];
    assert.equal(extractImages([generated])[0].isGenerated, true);
    assert.equal(extractImages([['https://lh3.googleusercontent.com/inline', 512, 512]])[0].isGenerated, undefined);
});

test('regression: Online Martian Cat + Takeout yields exactly 1 image in Markdown, HTML, PDF without prefix heuristic', async () => {
    const { renderCanonicalMarkdown } = require('../src/core/export/canonical/renderCanonicalMarkdown.js');
    const { renderCanonicalHtml } = require('../src/core/export/canonical/renderCanonicalHtml.js');
    (global as any).JSZip = require('../lib/jszip.min.js');
    TakeoutEngine.clearTakeoutData('identity');
    try {
        await TakeoutEngine.parseTakeoutZip(fs.readFileSync(path.join(__dirname, 'fixtures/gemini_takeout_clean.zip')), null, 'identity');
        const chat = onlineChat();
        supplementTakeoutGeneratedMedia(chat, id, 'identity', TakeoutEngine);

        // 1. Supplementation skips duplicate
        assert.equal(chat.messages[1].images.length, 1);
        assert.equal(chat.messages[1].content, '');

        // 2. Canonical normalization
        const { bundle } = await normalizeGeminiConversation(chat);
        const imageAssets = bundle.assets.filter((a: any) => a.kind === 'image');
        assert.equal(imageAssets.length, 1, 'Exactly 1 logical image asset');

        // 3. Markdown render
        const md = renderCanonicalMarkdown(bundle);
        const mdImageMatches = md.match(/!\[.*?\]\(.*?\)/g) || [];
        assert.equal(mdImageMatches.length, 1, 'Markdown has exactly 1 image reference');

        // 4. HTML render
        const { html } = renderCanonicalHtml(bundle);
        const htmlImageMatches = html.match(/<img\s+[^>]*>/gi) || [];
        assert.equal(htmlImageMatches.length, 1, 'HTML has exactly 1 img tag');
    } finally {
        TakeoutEngine.clearTakeoutData('identity');
    }
});

test('regression: multi-image generation in same turn does NOT merge different images (ordinal 0 vs 1)', async () => {
    const { renderCanonicalMarkdown } = require('../src/core/export/canonical/renderCanonicalMarkdown.js');
    const reqId = '1c81efe352c9ef8a';
    const chat: any = {
        id,
        messages: [
            { id: `r_${reqId}`, role: 'user', content: 'Generate 2 astronaut cats', timestamp: time },
            {
                id: 'm1',
                role: 'model',
                providerRequestId: reqId,
                content: '',
                images: [
                    {
                        type: 'image',
                        fileName: 'cat_0.jpg',
                        sourceUrl: 'https://lh3.googleusercontent.com/cat0',
                        localName: 'assets/cat_0.jpg',
                        isGenerated: true,
                        providerRequestId: reqId,
                        imageOrdinal: 0
                    },
                    {
                        type: 'image',
                        fileName: 'cat_1.jpg',
                        sourceUrl: 'https://lh3.googleusercontent.com/cat1',
                        localName: 'assets/cat_1.jpg',
                        isGenerated: true,
                        providerRequestId: reqId,
                        imageOrdinal: 1
                    }
                ]
            }
        ]
    };

    // Takeout provides image for ordinal 0
    const engine = {
        getTakeoutMediaForChat: () => [
            {
                filename: 'cat_0_takeout.png',
                isGenerated: true,
                providerRequestId: reqId,
                imageOrdinal: 0,
                generation: { chatId: id, providerRequestId: reqId, imageOrdinal: 0, imageCount: 2, generationOrdinal: 0 }
            }
        ]
    };

    supplementTakeoutGeneratedMedia(chat, id, 'test_slot', engine);
    assert.equal(chat.messages[1].images.length, 2, 'Must not duplicate ordinal 0 or wipe ordinal 1');

    const { bundle } = await normalizeGeminiConversation(chat);
    const imageAssets = bundle.assets.filter((a: any) => a.kind === 'image');
    assert.equal(imageAssets.length, 2, 'Both distinct images must be retained in canonical assets');

    const md = renderCanonicalMarkdown(bundle);
    const mdImageMatches = md.match(/!\[.*?\]\(.*?\)/g) || [];
    assert.equal(mdImageMatches.length, 2, 'Markdown has 2 distinct image references');
});

test('regression: different provider request IDs are never deduped', async () => {
    const chat: any = {
        id,
        messages: [
            { id: 'r_aaaaaaaaaaaaaaaa', role: 'user', content: 'Cat A', timestamp: time },
            {
                id: 'm1',
                role: 'model',
                providerRequestId: 'aaaaaaaaaaaaaaaa',
                content: '',
                images: [
                    {
                        type: 'image',
                        fileName: 'cat_a.jpg',
                        localName: 'assets/cat_a.jpg',
                        isGenerated: true,
                        providerRequestId: 'aaaaaaaaaaaaaaaa',
                        imageOrdinal: 0
                    }
                ]
            }
        ]
    };

    const engine = {
        getTakeoutMediaForChat: () => [
            {
                filename: 'cat_b.png',
                isGenerated: true,
                providerRequestId: 'bbbbbbbbbbbbbbbb',
                imageOrdinal: 0,
                generation: { chatId: id, providerRequestId: 'bbbbbbbbbbbbbbbb', imageOrdinal: 0, imageCount: 1, generationOrdinal: 0 }
            }
        ]
    };

    supplementTakeoutGeneratedMedia(chat, id, 'test_slot', engine);
    assert.equal(chat.messages.length, 3, 'Different request ID must be added as distinct model message, not deduped');
});

test('regression: extractImages suppresses 2x inline tuple duplicate sharing token with generated media', () => {
    const { extractImages } = require('../src/core/api/parser/attachments.js');
    const token = '8815680899422160530';
    const inlineTuple = ['https://lh3.googleusercontent.com/inline-2x', 2816, 1536, token];
    const generatedNode: any[] = Array(16).fill(null);
    generatedNode[2] = 'watermarked_img_4528137010801751197.jpg';
    generatedNode[3] = 'https://lh3.googleusercontent.com/gg/original';
    generatedNode[5] = token;
    generatedNode[11] = 'image/jpeg';
    generatedNode[15] = [1408, 768, 924784];

    // Order 1: inline tuple first, generated node second (typical JSPB walk order)
    const imgs1 = extractImages([inlineTuple, generatedNode]);
    assert.equal(imgs1.length, 1, 'Must deduplicate to exactly 1 image');
    assert.equal(imgs1[0].fileName, 'watermarked_img_4528137010801751197.jpg');
    assert.equal(imgs1[0].isGenerated, true);
    assert.equal(imgs1[0].width, 1408);
    assert.equal(imgs1[0].height, 768);

    // Order 2: generated node first, inline tuple second
    const imgs2 = extractImages([generatedNode, inlineTuple]);
    assert.equal(imgs2.length, 1, 'Must deduplicate to exactly 1 image');
    assert.equal(imgs2[0].fileName, 'watermarked_img_4528137010801751197.jpg');
    assert.equal(imgs2[0].isGenerated, true);
    assert.equal(imgs2[0].width, 1408);
    assert.equal(imgs2[0].height, 768);
});

test('regression: extractImages suppresses 2x upscale derivative rendition (slot 8 === 2) and retains authoritative 1x watermarked image', () => {
    const { extractImages } = require('../src/core/api/parser/attachments.js');
    const baseNode: any[] = Array(16).fill(null);
    baseNode[2] = 'watermarked_img_4528137010801751197.jpg';
    baseNode[3] = 'https://lh3.googleusercontent.com/gg/original';
    baseNode[5] = '$token_base';
    baseNode[8] = null; // base authoritative generation
    baseNode[11] = 'image/jpeg';
    baseNode[15] = [1408, 768, 934819];

    const upscaleNode: any[] = Array(25).fill(null);
    upscaleNode[2] = '8815680899422160530.jpeg';
    upscaleNode[3] = 'https://lh3.googleusercontent.com/gg/upscaled';
    upscaleNode[5] = '$token_upscale';
    upscaleNode[8] = 2; // 2x upscale derivative rendition
    upscaleNode[11] = 'image/jpeg';
    upscaleNode[15] = [2816, 1536, 3435994];

    const imgs = extractImages([baseNode, upscaleNode]);
    assert.equal(imgs.length, 1, 'Must retain only 1 authoritative base image');
    assert.equal(imgs[0].fileName, 'watermarked_img_4528137010801751197.jpg');
    assert.equal(imgs[0].width, 1408);
    assert.equal(imgs[0].height, 768);
    assert.equal(imgs[0].isGenerated, true);
});

test('regression: model message with only ordinary inline/grounding image must NEVER suppress Takeout generated image (both preserved)', async () => {
    const { renderCanonicalMarkdown } = require('../src/core/export/canonical/renderCanonicalMarkdown.js');
    const { renderCanonicalHtml } = require('../src/core/export/canonical/renderCanonicalHtml.js');

    // Model message has only 1 normal inline image (NOT generated, no providerRequestId, no generation identity)
    const normalInlineImage = {
        type: 'image',
        fileName: 'web_search_chart.png',
        sourceUrl: 'https://example.com/web_search_chart.png',
        localName: 'assets/web_search_chart.png',
        isGenerated: false
    };

    const chatWithInlineImage: any = {
        id,
        messages: [
            { id: 'u1', role: 'user', content: prompt, timestamp: time },
            { id: 'm1', role: 'model', content: 'Here is information with an inline web diagram.', images: [normalInlineImage] }
        ]
    };

    // Takeout has a generated image for the same prompt/event
    const generation = {
        chatId: id,
        time: Math.floor(time / 1000) * 1000,
        prompt,
        generationOrdinal: 0,
        imageCount: 1,
        imageOrdinal: 0,
        providerRequestId: '1c81efe352c9ef8a'
    };
    const engine = {
        getTakeoutMediaForChat: () => [{
            filename: png,
            isGenerated: true,
            generation
        }]
    };

    supplementTakeoutGeneratedMedia(chatWithInlineImage, id, 'test_slot', engine);

    // The model message MUST retain both: the ordinary inline image AND the Takeout generated image
    const modelMsg = chatWithInlineImage.messages.find((m: any) => m.role === 'model');
    assert.ok(modelMsg, 'Model message must exist');
    assert.equal(modelMsg.images.length, 2, 'Must contain BOTH the inline image and Takeout generated image');
    assert.ok(modelMsg.images.some((img: any) => img.fileName === 'web_search_chart.png'), 'Inline image preserved');
    assert.ok(modelMsg.images.some((img: any) => img.fileName === png), 'Takeout generated image preserved');

    // Canonical normalization must retain both assets
    const { bundle } = await normalizeGeminiConversation(chatWithInlineImage);
    const imageAssets = bundle.assets.filter((a: any) => a.kind === 'image');
    assert.equal(imageAssets.length, 2, 'Canonical bundle must have exactly 2 image assets');

    const md = renderCanonicalMarkdown(bundle);
    const mdImgs = md.match(/!\[.*?\]\(.*?\)/g) || [];
    assert.equal(mdImgs.length, 2, 'Markdown has 2 image refs');

    const { html } = renderCanonicalHtml(bundle);
    const htmlImgs = html.match(/<img\s+[^>]*>/gi) || [];
    assert.equal(htmlImgs.length, 2, 'HTML has 2 img tags');
});

test('regression: sameGenerationEvent requires matching chatId (cross-conversation same providerRequestId never dedupes)', () => {
    const { sameGenerationEvent } = require('../src/core/engine/generatedMediaIdentity.js');
    const sharedReqId = '1c81efe352c9ef8a';
    const genA = {
        chatId: '1bd028d5c5b0c0e2',
        providerRequestId: sharedReqId,
        time: time,
        prompt: prompt,
        generationOrdinal: 0,
        imageCount: 1,
        imageOrdinal: 0
    };
    const genB = {
        chatId: 'different_conv_9999',
        providerRequestId: sharedReqId,
        time: time,
        prompt: prompt,
        generationOrdinal: 0,
        imageCount: 1,
        imageOrdinal: 0
    };

    // Even though providerRequestId matches, different chatId must return false
    assert.equal(sameGenerationEvent(genA, genB), false, 'Cross-conversation with same requestId must NOT match');

    // Same chatId matches (including c_ prefix tolerance)
    const genWithPrefix = { ...genA, chatId: 'c_' + genA.chatId };
    assert.equal(sameGenerationEvent(genA, genWithPrefix), true, 'Same conversation with c_ prefix must match');

    // Cross-conversation supplementation test
    const chatA: any = {
        id: 'different_conv_9999',
        messages: [
            { id: 'u1', role: 'user', content: prompt, timestamp: time },
            { id: 'm1', role: 'model', providerRequestId: sharedReqId, content: '', images: [{
                type: 'image', fileName: jpg, sourceUrl: 'https://lh3.googleusercontent.com/cat',
                isGenerated: true, providerRequestId: sharedReqId, imageOrdinal: 0
            }] }
        ]
    };
    const engine = {
        getTakeoutMediaForChat: () => [{
            filename: png,
            isGenerated: true,
            generation: genA // generation is for chat 1bd028d5c5b0c0e2
        }]
    };
    supplementTakeoutGeneratedMedia(chatA, 'different_conv_9999', 'test_slot', engine);
    // Takeout image for conv A cannot be deduped into conv B
    assert.equal(chatA.messages.length, 3, 'Cross-conversation media must not be deduped');
});

test('regression: extractTurnRequestId schema slot evidence and fallback boundaries', () => {
    const { extractTurnRequestId } = require('../src/core/api/parser/parseDetail.js');
    const { GEMINI_JSPB_SCHEMA } = require('../src/core/api/parser/extractors.js');

    // Verify schema constant
    assert.equal(GEMINI_JSPB_SCHEMA.TURN.REQUEST_ID_SLOT, 1, 'REQUEST_ID_SLOT must be index 1 in ID_META');

    // Case 1: Standard canonical slot: idMeta[1] carries "r_<hex>"
    const turnStandard = [
        ["c_d3226d9a046c1116", "r_1c81efe352c9ef8a"],
        [1725302200, 0],
        [["user text"]],
        [[["rc_model_1", ["model text"]]]]
    ];
    assert.equal(extractTurnRequestId(turnStandard), '1c81efe352c9ef8a', 'Extract from standard slot 1');

    // Case 2: Standalone slot 0 when convId is absent
    const turnStandalone = [
        ["r_2b3c4d5e6f7a8b9c"],
        [1725302200, 0],
        [["user text"]],
        [[["rc_model_1", ["model text"]]]]
    ];
    assert.equal(extractTurnRequestId(turnStandalone), '2b3c4d5e6f7a8b9c', 'Extract from slot 0 when convId is absent');

    // Case 3: Direct string idMeta
    const turnStringId = [
        "r_9988776655443322",
        [1725302200, 0]
    ];
    assert.equal(extractTurnRequestId(turnStringId), '9988776655443322', 'Extract from direct string idMeta');

    // Case 4: Non-schema slot (e.g. slot 2) must NOT be matched via .find() heuristic (returns undefined)
    const turnUnconfirmedSlot = [
        ["c_conv123", null, "r_unconfirmed12345678"],
        [1725302200, 0]
    ];
    assert.equal(extractTurnRequestId(turnUnconfirmedSlot), undefined, 'Must return undefined for unconfirmed slot (no .find() heuristic)');

    // Case 5: "r_" in turn[1] (TIMESTAMP slot) or other non-id slots must be REJECTED
    const turnWithRInTimestamp = [
        ["c_conv123"],
        "r_fake_in_timestamp_slot"
    ];
    assert.equal(extractTurnRequestId(turnWithRInTimestamp), undefined, 'Must NEVER search outside ID_META (e.g. timestamp slot 1)');

    // Case 6: No r_ present anywhere in idMeta
    const turnNoR = [
        ["c_conv123", "non_r_identifier"],
        [1725302200, 0]
    ];
    assert.equal(extractTurnRequestId(turnNoR), undefined, 'Return undefined when no r_ present');
});



