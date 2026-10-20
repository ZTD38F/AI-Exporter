export {};
const test = require('node:test');
const assert = require('node:assert');

// Regression tests (audit M1): a Takeout record with no parsable timestamp
// must keep `timestamp: null` ("missing stays missing", P1-085/P1-067
// precedent) instead of a fabricated Date.now(). A fabricated "now" is client
// time injected into a server-authoritative field: it wins max-arbitration in
// mergeConversation and permanently pollutes the record, since later real
// server timestamps can never "un-win" it.
//
// Session-level only: message-level turn timestamp fallbacks are untouched.

const TakeoutEngine = require('../src/core/engine/takeoutEngine.js');
const { mergeConversation } = require('../src/core/utils/mergeUtils.js');

function buildZip(html: string) {
    (global as any).JSZip = require('../lib/jszip.min.js');
    const zip = new (global as any).JSZip();
    zip.file('Takeout/Gemini/MyActivity.html', html);
    return zip.generateAsync({ type: 'nodebuffer' });
}

// A takeout block with NO timestamp text anywhere (no en/zh/iso date match).
const htmlNoTimestamp = `
<html><body>
  <div class="outer-cell">
    <a href="https://gemini.google.com/app/c_NoTimestamp_4242">Link</a>
    Prompted 什么是光合作用？<br>
    <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1"><p>光合作用是植物利用光能的过程。</p></div>
  </div>
</body></html>
`;

test('takeout_missing_ts - parser leaves timestamp null when the block has no timestamp', async () => {
    TakeoutEngine.clearTakeoutData();
    const buf = await buildZip(htmlNoTimestamp);
    const result = await TakeoutEngine.parseTakeoutZip(buf);

    assert.strictEqual(result.conversations.length, 1);
    const conv = result.conversations[0];
    // Old behavior: `timestamp: ts || Date.now()` fabricated "now" here.
    assert.strictEqual(conv.timestamp, null, 'missing timestamp must stay null, never Date.now()');
});

test('takeout_missing_ts - merge with a null-timestamp takeout record keeps the old timestamp', () => {
    const oldTs = 1700000000000; // fixed server timestamp, must survive
    const old = {
        id: 'NoTimestamp_4242',
        title: 'old title',
        titleSource: 'rpc',
        titles: { rpc: 'old title' },
        timestamp: oldTs,
        updatedAt: oldTs,
        messageCount: 3,
    };
    const incoming = {
        id: 'NoTimestamp_4242',
        title: '什么是光合作用？',
        titleSource: 'takeout',
        titles: { takeout: '什么是光合作用？' },
        timestamp: null, // what the parser now produces for missing ts
        messageCount: 1,
    };

    const { merged } = mergeConversation(old, incoming, {});
    assert.strictEqual(merged.timestamp, oldTs, 'merge must keep old server timestamp, not null');
});

test('takeout_missing_ts - merge with no timestamps anywhere stays null, not Date.now()', () => {
    const old = {
        id: 'NoTimestamp_4242',
        title: 'old title',
        titleSource: 'rpc',
        titles: { rpc: 'old title' },
        timestamp: null,
        messageCount: 1,
    };
    const incoming = {
        id: 'NoTimestamp_4242',
        title: '什么是光合作用？',
        titleSource: 'takeout',
        titles: { takeout: '什么是光合作用？' },
        timestamp: null,
        messageCount: 1,
    };

    const before = Date.now();
    const { merged } = mergeConversation(old, incoming, {});
    const after = Date.now();
    assert.strictEqual(merged.timestamp, null, 'no server time anywhere -> null, never fabricated now');
    assert.ok(
        !(typeof merged.timestamp === 'number' && merged.timestamp >= before && merged.timestamp <= after),
        'merged timestamp must not be a fabricated Date.now()'
    );
});
