export {};
const test = require('node:test');
const assert = require('node:assert');

const { TakeoutEngine } = require('../src/core/engine/takeoutEngine.js');
const zipBombGuard = require('../src/core/engine/takeout/zipBombGuard.js');
const mediaIndex = require('../src/core/engine/takeout/mediaIndex.js');

// ---------- P1-112: no substring cross-file matching ----------
test('p1_h1 - P1-112: fallback media never returns an unrelated file via substring', async () => {
    mediaIndex.clearTakeoutData();
    const fakeBytes = new Uint8Array([1, 2, 3]);
    mediaIndex.commitTakeoutData(null, {
        mediaMap: {
            // NOTE: keys are normId-normalized ('c_1' -> '1')
            '1': [{ filename: 'cat-photo.png', fileObj: { async: async () => fakeBytes } }]
        },
        globalMedia: {},
        convCache: {}
    });
    // 'sunset-cat-photo' merely CONTAINS 'cat-photo' — must not match.
    const hit = await mediaIndex.getTakeoutFallbackMedia('c_1', 'sunset-cat-photo.png');
    assert.strictEqual(hit, null, 'substring match must not return another file\'s bytes');
    // Exact stem still matches.
    const exact = await mediaIndex.getTakeoutFallbackMedia('c_1', 'cat-photo.png');
    assert.ok(exact && exact.length === 3, 'exact match must still work');
    mediaIndex.clearTakeoutData();
});

// ---------- P1-113: slot isolation ----------
test('p1_h1 - P1-113: unknown slot never falls back to another slot\'s data', () => {
    mediaIndex.clearTakeoutData();
    mediaIndex.commitTakeoutData(null, {
        mediaMap: { '9': [{ filename: 'secret.png', fileObj: {} }] },
        globalMedia: {},
        convCache: {}
    });
    const store = mediaIndex.getStore('slot-that-never-imported');
    assert.deepStrictEqual(store.mediaMap, {}, 'isolated store must be empty');
    assert.deepStrictEqual(mediaIndex.getTakeoutMediaForChat('c_9', 'slot-that-never-imported'), [],
        'explicit unknown slot must not leak legacy-global media');
    // Legacy path (no slot) still works.
    assert.strictEqual(mediaIndex.getTakeoutMediaForChat('c_9').length, 1);
    mediaIndex.clearTakeoutData();
});

// ---------- P1-114: zip bomb guards fail closed ----------
test('p1_h1 - P1-114: zip guards fail closed on unknown size', () => {
    assert.throws(() => zipBombGuard.validateZipFile(undefined), /无法确认|Cannot determine/);
    assert.throws(() => zipBombGuard.validateZipFile({} as any), /无法确认|Cannot determine/);
    assert.throws(() => zipBombGuard.validateZipFile({ size: 600 * 1024 * 1024 }), /过大|too large/i);
    assert.doesNotThrow(() => zipBombGuard.validateZipFile(Buffer.alloc(10) as any), 'Buffer uses .length');
    assert.throws(
        () => zipBombGuard.validateZipEntries({ files: { 'a.txt': { dir: false } } } as any),
        /无法确认未压缩大小|unverified sizes/i
    );
    assert.doesNotThrow(
        () => zipBombGuard.validateZipEntries({ files: { 'a.txt': { dir: false, _data: { uncompressedSize: 10 } } } } as any)
    );
});

// ---------- P1-117: C2PA trust marker + date validation ----------
test('p1_h1 - P1-117: C2PA needs a trust marker and a valid calendar date', () => {
    const f = TakeoutEngine.extractC2PATimestamp;
    const trusted2032 = f('c2pa:claim_generator="Google" date="20321115123000Z"');
    assert.ok(trusted2032 !== null, 'trusted 2032 timestamp must parse');
    assert.strictEqual(new Date(trusted2032).getUTCFullYear(), 2032);
    assert.strictEqual(f('dummy_header_20321115123000Z_dummy_footer'), null,
        'bare digit run with no trust context must be rejected');
    assert.strictEqual(f('c2pa manifest date="20321301123000Z"'), null, 'month 13 is invalid');
    assert.strictEqual(f('xmp:CreateDate="20230230123000Z"'), null, 'Feb 30 is invalid');
    const buf = f(Buffer.from('junk jumb data 20260322143000Z tail'));
    assert.ok(buf !== null, 'Buffer input with jumb marker must parse');
});

// ---------- P1-111: takeoutHtmlParser builds a one-time ZIP index ----------
test('p1_h1 - P1-111: takeoutHtmlParser uses a prebuilt index, not a triple loop', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/core/engine/takeout/takeoutHtmlParser.ts'), 'utf8');
    assert.ok(src.includes('__zipExact'), 'prebuilt exact-match index missing');
    assert.ok(src.includes('__zipEntries'), 'flat ZIP entry index missing');
});

// ---------- takeoutHtmlSizeUnknown i18n key ----------
test('p1_h1 - takeoutHtmlSizeUnknown key exists in en and zh', () => {
    const en = require('../src/core/utils/locales/en.js');
    const zh = require('../src/core/utils/locales/zh.js');
    assert.ok(typeof en.takeoutHtmlSizeUnknown === 'string' && en.takeoutHtmlSizeUnknown.length > 0, 'en key present');
    assert.ok(typeof zh.takeoutHtmlSizeUnknown === 'string' && zh.takeoutHtmlSizeUnknown.length > 0, 'zh key present');
});

test('p1_h1 - parseTakeoutTimestamp CST and numeric offset handling', () => {
    const { parseTakeoutTimestamp } = require('../src/core/engine/takeout/takeoutHtmlParser.js');
    const blockCjkCst = '<div class="content-cell">Prompted 介绍木星<br>Jul 15, 2024, 2:30:00 PM CST</div>';
    const tsCst = parseTakeoutTimestamp(blockCjkCst);
    assert.ok(tsCst !== null);
    const isoCst = new Date(tsCst).toISOString();
    assert.strictEqual(isoCst, '2024-07-15T06:30:00.000Z', 'CST in CJK context must map to UTC+8 (+0800)');

    const blockUtc = '<div class="content-cell">Prompted Hello<br>Jul 15, 2024, 2:30:00 PM UTC+8</div>';
    const tsUtc = parseTakeoutTimestamp(blockUtc);
    assert.ok(tsUtc !== null);
    assert.strictEqual(new Date(tsUtc).toISOString(), '2024-07-15T06:30:00.000Z');

    const blockZh = '<div class="content-cell">提示 你好<br>2024年3月15日 下午2:30:00 UTC+8</div>';
    const tsZh = parseTakeoutTimestamp(blockZh);
    assert.ok(tsZh !== null);
    assert.strictEqual(new Date(tsZh).toISOString(), '2024-03-15T06:30:00.000Z');
});

