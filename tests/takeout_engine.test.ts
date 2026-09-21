export {};
const test = require('node:test');
const assert = require('node:assert');
const TakeoutEngine = require('../src/core/engine/takeoutEngine.js');

test('takeout_engine - exports and methods', () => {
    assert.strictEqual(typeof TakeoutEngine.parseTakeoutZip, 'function');
    assert.strictEqual(typeof TakeoutEngine.getTakeoutOfflineChat, 'function');
    assert.strictEqual(typeof TakeoutEngine.getTakeoutFallbackMedia, 'function');
    assert.strictEqual(typeof TakeoutEngine.clearTakeoutData, 'function');
});

test('takeout_engine - getTakeoutOfflineChat empty default', () => {
    TakeoutEngine.clearTakeoutData();
    assert.strictEqual(TakeoutEngine.getTakeoutOfflineChat('nonexistent_id'), null);
});

test('takeout_engine - parseTakeoutZip preserves ID case and syncs multi-turn titles.takeout slot', async () => {
    (global as any).JSZip = require('../lib/jszip.min.js');
    const zip = new (global as any).JSZip();

    // Multi-turn HTML: turn 1 has no prompt, turn 2 has real prompt, ID with mixed case "CaseSensitive_99"
    const htmlContent = `
    <html><body>
      <div class="outer-cell">
        <a href="https://gemini.google.com/app/c_CaseSensitive_99">Link 1</a>
        <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1"><p>Response 1</p></div>
      </div>
      <div class="outer-cell">
        <a href="https://gemini.google.com/app/c_CaseSensitive_99">Link 2</a>
        Prompted 什么是量子物理？<br>
        <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1"><p>量子物理是研究微观粒子的物理学分支。</p></div>
      </div>
    </body></html>
    `;

    zip.file('Takeout/Gemini/MyActivity.html', htmlContent);
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    TakeoutEngine.clearTakeoutData();
    const result = await TakeoutEngine.parseTakeoutZip(zipBuffer);

    assert.strictEqual(result.conversations.length, 1);
    const conv = result.conversations[0];
    
    // 1. ID case must be preserved (CaseSensitive_99, not lowercased to casesensitive_99)
    assert.strictEqual(conv.id, 'CaseSensitive_99');

    // 2. Title and titles.takeout must both be synced to turn 2's prompt
    assert.strictEqual(conv.title, '什么是量子物理？');
    assert.strictEqual(conv.titles.takeout, '什么是量子物理？');

    // 3. getTakeoutOfflineChat should find by exact ID and with c_ prefix
    const offlineChat1 = TakeoutEngine.getTakeoutOfflineChat('CaseSensitive_99');
    assert.ok(offlineChat1, 'Should find offline chat by exact ID');
    assert.strictEqual(offlineChat1.title, '什么是量子物理？');
    assert.strictEqual(offlineChat1.titles.takeout, '什么是量子物理？');
    assert.strictEqual(offlineChat1.messages.length, 4); // 2 turns * (1 user + 1 model)

    const offlineChat2 = TakeoutEngine.getTakeoutOfflineChat('c_CaseSensitive_99');
    assert.ok(offlineChat2, 'Should find offline chat with c_ prefix');
});

test('takeout_engine - extractC2PATimestamp extracts UTC timestamp from binary', () => {
    assert.strictEqual(typeof TakeoutEngine.extractC2PATimestamp, 'function');
    
    // Sample buffer containing C2PA timestamp: 20260902183651Z
    const fakeC2PABuf = Buffer.from('dummy_header_jumb_c2pa_signature_20260902183651Z_more_bytes');
    const ts = TakeoutEngine.extractC2PATimestamp(fakeC2PABuf);
    assert.ok(ts, 'Timestamp should be extracted');
    const expected = Date.UTC(2026, 8, 2, 18, 36, 51);
    assert.strictEqual(ts, expected);

    // No timestamp
    assert.strictEqual(TakeoutEngine.extractC2PATimestamp(Buffer.from('no_timestamp_here')), null);
    assert.strictEqual(TakeoutEngine.extractC2PATimestamp(null), null);
});

test('takeout_engine - parseTakeoutZip associates watermarked images via C2PA time correlation and monopolistic fallback', async () => {
    (global as any).JSZip = require('../lib/jszip.min.js');
    const zip = new (global as any).JSZip();

    // 2 conversations:
    // Chat A: prompt at 2026-08-27 23:10:04 UTC (1787958604000)
    // Chat B: prompt at 2026-08-24 18:43:31 UTC (1787683411000)
    const html = `
    <html><body>
      <div class="outer-cell">
        <a href="https://gemini.google.com/app/chat_A_12345678">Link A</a>
        Prompted 画一只火星上的猫<br>
        1 generated image.<br>
        Aug 27, 2026, 11:10:04 PM PDT<br>
        <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1"><p>Here is your cat</p></div>
      </div>
      <div class="outer-cell">
        <a href="https://gemini.google.com/app/chat_B_87654321">Link B</a>
        Prompted 生成首页宣传图<br>
        1 generated image.<br>
        Aug 24, 2026, 6:43:31 PM PDT<br>
        <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1"><p>Here is your banner</p></div>
      </div>
    </body></html>
    `;

    // Create 2 watermarked images with C2PA timestamps matching within 10-15s
    // Image A time: Aug 28, 2026 06:10:16 UTC (12s after Chat A)
    const imgABuffer = Buffer.from('fake_png_header_jumb_c2pa_20260828061016Z_tail');
    // Image B time: Aug 25, 2026 01:43:41 UTC (10s after Chat B)
    const imgBBuffer = Buffer.from('fake_png_header_jumb_c2pa_20260825014341Z_tail');

    zip.file('Takeout/My Activity/Gemini Apps/MyActivity.html', html);
    zip.file('Takeout/My Activity/Gemini Apps/watermarked_img_1111-aaaa.png', imgABuffer);
    zip.file('Takeout/My Activity/Gemini Apps/watermarked_img_2222-bbbb.png', imgBBuffer);

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    TakeoutEngine.clearTakeoutData();
    const res = await TakeoutEngine.parseTakeoutZip(zipBuffer);

    assert.strictEqual(res.conversations.length, 2);

    // Chat A media must be watermarked_img_1111-aaaa.png
    const mediaA = TakeoutEngine.getTakeoutMediaForChat('chat_A_12345678');
    assert.strictEqual(mediaA.length, 1);
    assert.strictEqual(mediaA[0].filename, 'watermarked_img_1111-aaaa.png');
    assert.strictEqual(mediaA[0].isGenerated, true);

    // Chat B media must be watermarked_img_2222-bbbb.png
    const mediaB = TakeoutEngine.getTakeoutMediaForChat('chat_B_87654321');
    assert.strictEqual(mediaB.length, 1);
    assert.strictEqual(mediaB[0].filename, 'watermarked_img_2222-bbbb.png');
    assert.strictEqual(mediaB[0].isGenerated, true);

    // Offline chat model turn must contain ![Generated Image](assets/...)
    const chatAOffline = TakeoutEngine.getTakeoutOfflineChat('chat_A_12345678');
    assert.ok(chatAOffline);
    const modelTurnA = chatAOffline.messages.find((m: any) => m.role === 'model');
    assert.ok(modelTurnA.content.includes('![Generated Image](assets/watermarked_img_1111-aaaa.png)'));
    assert.strictEqual(modelTurnA.images.length, 1);
    assert.strictEqual(modelTurnA.images[0].fileName, 'watermarked_img_1111-aaaa.png');

    // getTakeoutFallbackMedia should return binary buffer for watermarked image
    const binA = await TakeoutEngine.getTakeoutFallbackMedia('chat_A_12345678', 'watermarked_img_1111-aaaa.png');
    assert.ok(binA && binA.length > 0);
});

test('takeout_engine - authentic cleaned Takeout fixture parsing', async () => {
    const fs = require('fs');
    const path = require('path');
    const fixturePath = path.resolve(__dirname, 'fixtures/gemini_takeout_clean.zip');
    if (!fs.existsSync(fixturePath)) return;

    (global as any).JSZip = require('../lib/jszip.min.js');
    const buf = fs.readFileSync(fixturePath);
    TakeoutEngine.clearTakeoutData();
    const res = await TakeoutEngine.parseTakeoutZip(buf);

    assert.strictEqual(res.conversations.length, 6, 'Should extract exactly 6 conversations');
    assert.strictEqual(res.totalMediaCount, 1, 'Should extract exactly 1 media asset');

    // Verify cat image conversation
    const catChat = res.conversations.find((c: any) => c.id === '1bd028d5c5b0c0e2');
    assert.ok(catChat, 'Cat conversation should exist');
    assert.ok(catChat.title.includes('astronaut cat') || catChat.title.includes('Cat'));

    const catMedia = TakeoutEngine.getTakeoutMediaForChat('1bd028d5c5b0c0e2');
    assert.strictEqual(catMedia.length, 1);
    assert.ok(catMedia[0].filename.startsWith('watermarked_img_45281370108017511'));

    // Verify Python decorator conversation
    const pyChat = res.conversations.find((c: any) => c.id === '1cea7e48cc166b57');
    assert.ok(pyChat, 'Python decorator conversation should exist');
    assert.ok(pyChat.title.includes('Python') || pyChat.title.includes('装饰器'));
});

test('takeout_engine - extractC2PATimestamp extracts ISO timestamp from C2PA binary block', () => {
    const MediaIndex = require('../src/core/engine/takeout/mediaIndex.js');
    assert.strictEqual(MediaIndex.extractC2PATimestamp(null), null);
    assert.strictEqual(MediaIndex.extractC2PATimestamp(Buffer.from('hello world')), null);

    const fakeC2PA = Buffer.from('xpacket start="W5M0MpCehiHzreSzNTczkc9d" c2pa:claim_generator="Google" date="20260322143000Z" end="w"');
    const ts = MediaIndex.extractC2PATimestamp(fakeC2PA);
    assert.ok(typeof ts === 'number', 'should return numeric epoch timestamp');
    assert.strictEqual(new Date(ts).toISOString(), '2026-03-22T14:30:00.000Z');
});

test('takeout_engine - slot isolation ensures multi-account takeouts do not leak', () => {
    const MediaIndex = require('../src/core/engine/takeout/mediaIndex.js');
    MediaIndex.clearTakeoutData();

    MediaIndex.commitTakeoutData('u0', {
        mediaMap: { 'chat_1': [{ filename: 'img0.jpg' }] },
        globalMedia: { 'img0.jpg': { path: 'u0/img0.jpg' } },
        convCache: { 'c_chat_1': { id: 'chat_1', title: 'Slot 0 Chat' } }
    });

    MediaIndex.commitTakeoutData('u1', {
        mediaMap: { 'chat_2': [{ filename: 'img1.jpg' }] },
        globalMedia: { 'img1.jpg': { path: 'u1/img1.jpg' } },
        convCache: { 'c_chat_2': { id: 'chat_2', title: 'Slot 1 Chat' } }
    });

    const storeU0 = MediaIndex.getStore('u0');
    const storeU1 = MediaIndex.getStore('u1');

    assert.ok(storeU0.convCache['c_chat_1'], 'u0 has chat_1');
    assert.ok(!storeU0.convCache['c_chat_2'], 'u0 must not have chat_2');

    assert.ok(storeU1.convCache['c_chat_2'], 'u1 has chat_2');
    assert.ok(!storeU1.convCache['c_chat_1'], 'u1 must not have chat_1');

    MediaIndex.clearTakeoutData('u1');
    assert.strictEqual(Object.keys(MediaIndex.getStore('u1').convCache).length, 0);
    assert.ok(MediaIndex.getStore('u0').convCache['c_chat_1'], 'u0 cache remains intact after clearing u1');

    MediaIndex.clearTakeoutData();
});

test('takeout_engine - stripHtmlTags removes nested HTML and script injections safely', () => {
    const TakeoutParser = require('../src/core/engine/takeout/takeoutParser.js');
    assert.strictEqual(TakeoutParser.stripHtmlTags(''), '');
    assert.strictEqual(TakeoutParser.stripHtmlTags(null), '');
    assert.strictEqual(TakeoutParser.stripHtmlTags(12345), '');

    const dirty = '<div class="outer"><p>Hello <b>World</b>!</p><script>alert(1)</script></div>';
    const clean = TakeoutParser.stripHtmlTags(dirty);
    assert.strictEqual(clean, 'Hello World!alert(1)');

    const nested = '<div><span>deep <i>text</i></span></div>';
    assert.strictEqual(TakeoutParser.stripHtmlTags(nested), 'deep text');
});

test('takeout_engine - parseTakeoutZip detects structure drift and throws descriptive error', async () => {
    (global as any).JSZip = require('../lib/jszip.min.js');
    const zip = new (global as any).JSZip();

    const modifiedTakeoutHtml = `
    <html><body>
      <div class="google-gemini-redesign">
        <h1>MyActivity Gemini</h1>
        <div class="chat-card-new">
          <p>Some new format content</p>
        </div>
      </div>
    </body></html>
    `;

    zip.file('Takeout/Gemini/MyActivity.html', modifiedTakeoutHtml);
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    TakeoutEngine.clearTakeoutData();
    await assert.rejects(
        async () => {
            await TakeoutEngine.parseTakeoutZip(zipBuffer);
        },
        (err: any) => {
            return err && String(err.message).includes('Takeout');
        }
    );
});

test('takeout_engine - takeoutHtmlParser parsing helpers', () => {
    const TakeoutHtmlParser = require('../src/core/engine/takeout/takeoutHtmlParser.js');
    assert.strictEqual(typeof TakeoutHtmlParser.parseTakeoutPrompt, 'function');
    assert.strictEqual(typeof TakeoutHtmlParser.parseTakeoutTimestamp, 'function');

    // Prompt extraction test
    const blockWithPrompt = '<div class="outer-cell">Prompted 计算复利公式<br><div class="content-cell"></div></div>';
    const parsedPrompt = TakeoutHtmlParser.parseTakeoutPrompt(blockWithPrompt);
    assert.strictEqual(parsedPrompt.hasExplicitPrompt, true);
    assert.strictEqual(parsedPrompt.promptText, '计算复利公式');

    // Timestamp extraction test
    const blockWithZhTime = '2026年3月15日 下午2:30:00';
    const ts = TakeoutHtmlParser.parseTakeoutTimestamp(blockWithZhTime);
    assert.ok(typeof ts === 'number' && ts > 0, 'Parsed timestamp must be valid number');
});

test('takeout_engine - parseTakeoutZip S-4 memory guardrail on oversized MyActivity.html', async () => {
    (global as any).JSZip = require('../lib/jszip.min.js');
    const zip = new (global as any).JSZip();

    zip.file('Takeout/Gemini/MyActivity.html', 'small text');
    // Mock the uncompressed size property to trigger the S-4 guardrail
    const f = zip.file('Takeout/Gemini/MyActivity.html');
    if (f) {
        f._data = { uncompressedSize: 300 * 1024 * 1024 }; // 300MB > 250MB limit
    }

    const TakeoutParser = require('../src/core/engine/takeout/takeoutParser.js');
    await assert.rejects(
        async () => {
            await TakeoutParser.parseTakeoutZip(zip);
        },
        (err: any) => {
            return err && (err.name === 'TakeoutParseError' || err.message.includes('内存安全上限'));
        }
    );
});


