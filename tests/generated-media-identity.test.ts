import { useIndexStorage } from './helpers/indexStorage.js';
useIndexStorage();
export {};
const test = require('node:test');
import assert from 'node:assert/strict';
const fs = require('node:fs');
const path = require('node:path');
import { parseGeminiTakeoutZipArchive } from '../src/l1/imports/takeout/readArchive.js';
import { decodeTurn, GEMINI_JSPB_SCHEMA } from '../src/l1/parsers/gemini/rpc/extractors.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';

const id = '1bd028d5c5b0c0e2';
const png = 'watermarked_img_45281370108017511-1c81efe352c9ef8a.png';
const jpg = 'watermarked_img_4528137010801751197.jpg';

test('real Takeout fixture does not guess ownership of unreferenced generated image bytes', async () => {
    const JSZip = require('../lib/jszip.min.js');
    const result = await parseGeminiTakeoutZipArchive(fs.readFileSync(path.join(__dirname, 'fixtures/gemini_takeout_clean.zip')), { providerId: 'gemini', readArchive: bytes => JSZip.loadAsync(bytes) });
    const offline = result.find(source => source.conversationId === id); assert.ok(offline);
    assert.equal('key' in offline.conversation.detail, false);
    assert.deepEqual(offline.archiveResources, {});
    assert.ok(offline.diagnostics.some(d => d.code === 'TAKEOUT_GENERATED_MEDIA_UNRESOLVED'));
    const resources = createSourceResourceContext();
    try {
        resources.retainParsed({ accountId: '10000000-0000-4000-8000-000000000001', conversationId: id }, offline);
        await assert.rejects(resources.acquire({ accountId: '10000000-0000-4000-8000-000000000001', conversationId: id }, { id: png, kind: 'image' }), /locator/);
    } finally { resources.release(); }
});

test('RPC generated-media detector preserves generated status while inline images remain unmarked', () => {
    const { extractImages } = require('./helpers/recordFixture/attachments.js');
    const generated: any[] = Array(16).fill(null);
    generated[2] = jpg;
    generated[3] = 'https://lh3.googleusercontent.com/generated';
    generated[11] = 'image/jpeg';
    generated[15] = [512, 512, 1000];
    assert.equal(extractImages([generated])[0].isGenerated, true);
    assert.equal(extractImages([['https://lh3.googleusercontent.com/inline', 512, 512]])[0].isGenerated, undefined);
});

test('regression: extractImages suppresses 2x inline tuple duplicate sharing token with generated media', () => {
    const { extractImages } = require('./helpers/recordFixture/attachments.js');
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
    const { extractImages } = require('./helpers/recordFixture/attachments.js');
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

test('regression: decodeTurn verifies request identity only in documented slots', () => {
    const extractTurnRequestId = (turn: unknown): string | undefined => decodeTurn(turn)?.rawProviderRequestId;

    // Verify schema constant
    assert.equal(GEMINI_JSPB_SCHEMA.TURN.REQUEST_ID_SLOT, 1, 'REQUEST_ID_SLOT must be index 1 in ID_META');

    // Case 1: Standard canonical slot: idMeta[1] carries "r_<hex>"
    const turnStandard = [
        ["c_d3226d9a046c1116", "r_1c81efe352c9ef8a"],
        [1725302200, 0],
        [["user text"]],
        [[["rc_model_1", ["model text"]]]]
    ];
    assert.equal(extractTurnRequestId(turnStandard), 'r_1c81efe352c9ef8a', 'Extract from standard slot 1');

    // Case 2: Standalone slot 0 when convId is absent
    const turnStandalone = [
        ["r_2b3c4d5e6f7a8b9c"],
        [1725302200, 0],
        [["user text"]],
        [[["rc_model_1", ["model text"]]]]
    ];
    assert.equal(extractTurnRequestId(turnStandalone), 'r_2b3c4d5e6f7a8b9c', 'Extract from slot 0 when convId is absent');

    // Case 3: Direct string idMeta
    const turnStringId = [
        "r_9988776655443322",
        [1725302200, 0]
    ];
    assert.equal(extractTurnRequestId(turnStringId), 'r_9988776655443322', 'Extract from direct string idMeta');

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

    // Request identity remains exactly as captured for messages and generated images.
    const mixedCase = [["c_conv123", "r_AbC-09"], [1725302200, 0]];
    assert.equal(decodeTurn(mixedCase)?.rawProviderRequestId, 'r_AbC-09');
    assert.equal(decodeTurn(turnUnconfirmedSlot)?.rawProviderRequestId, undefined);
    assert.equal(decodeTurn(turnWithRInTimestamp)?.rawProviderRequestId, undefined);
});

