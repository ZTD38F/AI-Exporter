export {};
const test = require('node:test');
const assert = require('node:assert');

const TakeoutEngine = require('../src/core/engine/takeoutEngine.js');
const { GeminiAPIClient } = require('../src/core/api/geminiClient.js');
const I18n = require('../src/core/utils/i18n.js');
const DialogView = require('../src/ui/views/dialogView.js');

(global as any).I18n = I18n;

test('takeout_engine - C2PA regex parses years beyond 2029', () => {
    // 2032-11-15 12:30:00 UTC
    const rawString = "dummy_header_20321115123000Z_dummy_footer";
    const ts = TakeoutEngine.extractC2PATimestamp(rawString);
    assert.ok(ts !== null, 'C2PA timestamp in 2032 should be parsed');
    const d = new Date(ts);
    assert.strictEqual(d.getUTCFullYear(), 2032);
    assert.strictEqual(d.getUTCMonth(), 10); // November is 0-indexed: 10
    assert.strictEqual(d.getUTCDate(), 15);
});

test('takeout_engine - prevents cross-chat media hijacking for generic image names', async () => {
    (global as any).JSZip = require('../lib/jszip.min.js');
    const zip = new (global as any).JSZip();

    // HTML only mentions chat_B_123456 having image_01.png
    const htmlContent = `
    <html><body>
      <div class="outer-cell">
        <a href="https://gemini.google.com/app/chat_B_123456">Chat B Link</a>
        Prompted Chat B message<br>
        <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">
          <p>Response B</p>
          <img src="image_01.png" />
        </div>
      </div>
      <div class="outer-cell">
        <a href="https://gemini.google.com/app/chat_A_123456">Chat A Link</a>
        Prompted Chat A message<br>
        <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">
          <p>Response A without images</p>
        </div>
      </div>
    </body></html>
    `;

    zip.file('Takeout/Gemini/MyActivity.html', htmlContent);
    const imgData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic bytes
    zip.file('Takeout/Gemini/image_01.png', imgData);

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    TakeoutEngine.clearTakeoutData();
    await TakeoutEngine.parseTakeoutZip(zipBuffer);

    // Chat B owns image_01.png -> should find it
    const mediaB = await TakeoutEngine.getTakeoutFallbackMedia('chat_B_123456', 'image_01.png');
    assert.ok(mediaB && mediaB.length > 0, 'Chat B should retrieve its own image');

    // Chat A does NOT own image_01.png -> generic name should NOT be hijacked from globalMedia!
    const mediaA = await TakeoutEngine.getTakeoutFallbackMedia('chat_A_123456', 'image_01.png');
    assert.strictEqual(mediaA, null, 'Chat A must NOT hijack Chat B image with generic name');

    // Another generic attempt 'image.png'
    const mediaAGeneric = await TakeoutEngine.getTakeoutFallbackMedia('chat_A_123456', 'image.png');
    assert.strictEqual(mediaAGeneric, null, 'Chat A must NOT match image.png against Chat B image');
});

test('takeout_engine - clearTakeoutData thoroughly cleans slot and global caches', async () => {
    (global as any).JSZip = require('../lib/jszip.min.js');
    const zip = new (global as any).JSZip();
    zip.file('Takeout/Gemini/MyActivity.html', `<html><body><div class="outer-cell"><a href="https://gemini.google.com/app/chat_slot_123">Link</a>Prompted hi<br><div class="content-cell">hello</div></div></body></html>`);
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    TakeoutEngine.clearTakeoutData();
    await TakeoutEngine.parseTakeoutZip(zipBuffer, null, 'u1');

    const chatBefore = TakeoutEngine.getTakeoutOfflineChat('chat_slot_123', 'u1');
    assert.ok(chatBefore, 'Should exist before clear');

    TakeoutEngine.clearTakeoutData('u1');
    const chatAfter = TakeoutEngine.getTakeoutOfflineChat('chat_slot_123', 'u1');
    assert.strictEqual(chatAfter, null, 'Should be cleared after clearTakeoutData');
});

test('geminiClient - normal pagination to completion does not flag hitGoogleLimit', async () => {
    const client = new GeminiAPIClient();
    let pageCount = 0;

    // Mock getConversationList to simulate 11 pages of 50 conversations (550 total), last page has no nextPageToken
    (client as any).getConversationList = async (token?: any) => {
        pageCount++;
        const pageConvs = [];
        for (let j = 0; j < 50; j++) {
            pageConvs.push({ id: `conv_${pageCount}_${j}`, title: `Title ${pageCount}_${j}` });
        }
        return {
            conversations: pageConvs,
            nextPageToken: pageCount < 11 ? `token_page_${pageCount + 1}` : null
        };
    };

    const res = await client.getAllConversations({
        maxPages: 20,
        incremental: false
    });

    assert.strictEqual(res.conversations.length, 550);
    assert.strictEqual(res.hitGoogleLimit, false, 'Normal completion with 550 items must NOT flag hitGoogleLimit');
});

test('geminiClient - error with 1096 or BardErrorInfo flags hitGoogleLimit', async () => {
    const client = new GeminiAPIClient();
    let pageCount = 0;

    (client as any).getConversationList = async () => {
        pageCount++;
        if (pageCount === 3) {
            throw new Error('rpc error: code = 1096, BardErrorInfo: cursor expired');
        }
        return {
            conversations: [{ id: `conv_${pageCount}`, title: `Chat ${pageCount}` }],
            nextPageToken: `token_${pageCount + 1}`
        };
    };

    const res = await client.getAllConversations({
        maxPages: 10,
        incremental: false
    });

    assert.strictEqual(res.conversations.length, 2);
    assert.strictEqual(res.hitGoogleLimit, true, 'Cursor expired 1096 error must flag hitGoogleLimit');
});

test('dialogView - showTakeoutLimitPrompt differentiates between server limit and browsing window guidance', async () => {
    const mockElements: Record<string, any> = {
        takeoutLimitModal: { style: { display: 'none' } },
        takeoutLimitPromptTitle: { textContent: '' },
        takeoutLimitPromptText: { textContent: '' },
        btnModalImportTakeout: {},
        btnModalOpenTakeoutWeb: {},
        btnModalDismissTakeout: {},
        btnTakeoutLimitClose: {}
    };

    (global as any).document = {
        getElementById: (id: string) => mockElements[id] || null,
        querySelectorAll: () => []
    };

    if (I18n && typeof I18n.setLang === 'function') {
        await I18n.setLang('zh');
    }

    // Case 1: True server limit (hitGoogleLimit = true) in Chinese
    await DialogView.showTakeoutLimitPrompt({
        force: true,
        count: 620,
        hitGoogleLimit: true
    });
    assert.strictEqual(mockElements.takeoutLimitModal.style.display, 'flex');
    assert.ok(mockElements.takeoutLimitPromptTitle.textContent.includes('Google 云端拉取上限'));
    assert.ok(mockElements.takeoutLimitPromptText.textContent.includes('620'));

    // Case 2: Browsing window fallback (hitGoogleLimit = false, count >= 500) in Chinese
    await DialogView.showTakeoutLimitPrompt({
        force: true,
        count: 550,
        hitGoogleLimit: false
    });
    assert.ok(mockElements.takeoutLimitPromptTitle.textContent.includes('超出网页浏览上限'));
    assert.ok(mockElements.takeoutLimitPromptText.textContent.includes('550'));

    // Case 3: In English
    if (I18n && typeof I18n.setLang === 'function') {
        await I18n.setLang('en');
    }
    await DialogView.showTakeoutLimitPrompt({
        force: true,
        count: 600,
        hitGoogleLimit: true
    });
    assert.ok(mockElements.takeoutLimitPromptTitle.textContent.includes('Reached Google Cloud History Limit'));

    await DialogView.showTakeoutLimitPrompt({
        force: true,
        count: 500,
        hitGoogleLimit: false
    });
    assert.ok(mockElements.takeoutLimitPromptTitle.textContent.includes('History Exceeds Web Browsing Window'));
});
