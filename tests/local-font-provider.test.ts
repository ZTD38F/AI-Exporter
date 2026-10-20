/**
 * tests/local-font-provider.test.ts
 * Tier 1 tests for the Phase D local-first font provider
 * (src/core/export/typst/fonts/localFontProvider.ts).
 *
 * Covers (all with a mocked queryLocalFonts -- no real browser needed):
 *  - pure font matching: exact family, postscript heuristic, style priority,
 *    requested-order priority, no double-claiming
 *  - provider wrapper: API missing / denied / failing never throws
 *  - resolution: diagnostics on every miss, explicit fallback chain,
 *    lazy getBytes(), no silent substitution
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const {
    rankLocalFontCandidates,
    bestCandidateForFamily,
    queryLocalFontsProvider,
    resolveLocalFonts,
    warmLocalFontCache,
    getCachedLocalFonts,
    clearLocalFontCache,
    CJK_FONT_STACK,
} = require('../src/core/export/typst/fonts/localFontProvider.js');

function mockEntry(family: string, postscriptName: string, style: string): any {
    return {
        family,
        fullName: `${family} ${style}`,
        postscriptName,
        style,
        blob: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
    };
}

function stubQueryLocalFonts(fn: any): () => void {
    clearLocalFontCache();
    const g: any = globalThis;
    const had = Object.prototype.hasOwnProperty.call(g, 'queryLocalFonts');
    const prev = g.queryLocalFonts;
    g.queryLocalFonts = fn;
    return () => {
        clearLocalFontCache();
        if (had) g.queryLocalFonts = prev;
        else delete g.queryLocalFonts;
    };
}

test('matcher: exact family match wins and entries are claimed once', () => {
    const entries = [
        mockEntry('Noto Sans CJK SC', 'NotoSansCJKsc-Regular', 'Regular'),
        mockEntry('Noto Sans CJK SC', 'NotoSansCJKsc-Bold', 'Bold'),
        mockEntry('PingFang SC', 'PingFangSC-Regular', 'Regular'),
    ];
    const cands = rankLocalFontCandidates(entries, ['Noto Sans CJK SC', 'PingFang SC']);
    assert.strictEqual(cands.length, 3);
    assert.strictEqual(cands[0].postscriptName, 'NotoSansCJKsc-Regular');
    assert.strictEqual(cands[0].requestedFamily, 'Noto Sans CJK SC');
    // Regular sorts before Bold for the same family.
    assert.strictEqual(cands[1].postscriptName, 'NotoSansCJKsc-Bold');
    assert.strictEqual(cands[2].requestedFamily, 'PingFang SC');
});

test('matcher: postscript heuristic matches when family field is generic', () => {
    const entries = [mockEntry('Noto Sans CJK', 'NotoSansCJKsc-Regular', 'Regular')];
    const cands = rankLocalFontCandidates(entries, ['Noto Sans CJK SC']);
    assert.strictEqual(cands.length, 1);
    assert.strictEqual(cands[0].requestedFamily, 'Noto Sans CJK SC');
});

test('matcher: first requested family claims an ambiguous entry', () => {
    const entries = [mockEntry('Noto Sans CJK', 'NotoSansCJKsc-Regular', 'Regular')];
    const cands = rankLocalFontCandidates(entries, ['Noto Sans CJK', 'Noto Sans CJK SC']);
    // Entry matches both (exact family for the first, PS stem for the second);
    // claimed by the earlier-requested family only.
    assert.strictEqual(cands.length, 1);
    assert.strictEqual(cands[0].requestedFamily, 'Noto Sans CJK');
});

test('matcher: no arbitrary prefix match on the postscript stem', () => {
    // "Noto Sans" must NOT claim "NotoSansCJKsc-Regular": the PS family stem
    // is "notosanscjksc", which only equals "Noto Sans CJK SC".
    const entries = [mockEntry('Noto Sans CJK SC', 'NotoSansCJKsc-Regular', 'Regular')];
    assert.strictEqual(rankLocalFontCandidates(entries, ['Noto Sans']).length, 0);
    assert.strictEqual(rankLocalFontCandidates(entries, ['Noto Sans CJK']).length, 0);
    assert.strictEqual(rankLocalFontCandidates(entries, ['Noto Sans CJK SC']).length, 1);
});

test('matcher: postscript stem parsing handles hyphen-less names', () => {
    const entries = [mockEntry('Sans', 'ArialBold', 'Bold')];
    const cands = rankLocalFontCandidates(entries, ['Arial']);
    assert.strictEqual(cands.length, 1);
    assert.strictEqual(cands[0].postscriptName, 'ArialBold');
    // ...but a bare prefix of the stem still does not match.
    assert.strictEqual(rankLocalFontCandidates(entries, ['Ari']).length, 0);
});

test('matcher: case-insensitive, no match returns empty', () => {
    const entries = [mockEntry('pingfang sc', 'PingFangSC-Regular', 'Regular')];
    const cands = rankLocalFontCandidates(entries, ['PingFang SC']);
    assert.strictEqual(cands.length, 1);
    assert.strictEqual(rankLocalFontCandidates(entries, ['Comic Sans']).length, 0);
});

test('bestCandidateForFamily returns the Regular-first candidate', () => {
    const entries = [
        mockEntry('Arial', 'Arial-Bold', 'Bold'),
        mockEntry('Arial', 'ArialMT', 'Regular'),
    ];
    const cands = rankLocalFontCandidates(entries, ['Arial']);
    const best = bestCandidateForFamily(cands, 'Arial');
    assert.strictEqual(best && best.postscriptName, 'ArialMT');
    assert.strictEqual(bestCandidateForFamily(cands, 'Missing'), undefined);
});

test('provider: API absent returns api-unavailable, does not throw', async () => {
    const restore = stubQueryLocalFonts(undefined);
    try {
        const res: any = await queryLocalFontsProvider();
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.reason, 'api-unavailable');
        assert.ok(res.detail.includes('queryLocalFonts'));
    } finally {
        restore();
    }
});

test('provider: NotAllowedError maps to permission-denied', async () => {
    const err: any = new Error('Permission dismissed');
    err.name = 'NotAllowedError';
    const restore = stubQueryLocalFonts(async () => {
        throw err;
    });
    try {
        const res: any = await queryLocalFontsProvider();
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.reason, 'permission-denied');
    } finally {
        restore();
    }
});

test('provider: generic failure maps to query-failed', async () => {
    const restore = stubQueryLocalFonts(async () => {
        throw new Error('boom');
    });
    try {
        const res: any = await queryLocalFontsProvider();
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.reason, 'query-failed');
    } finally {
        restore();
    }
});

test('provider: resolves entries when API works', async () => {
    const restore = stubQueryLocalFonts(async () => [mockEntry('Arial', 'ArialMT', 'Regular')]);
    try {
        const res: any = await queryLocalFontsProvider();
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.fonts.length, 1);
    } finally {
        restore();
    }
});

test('resolve: CJK found -> ranked fonts, lazy getBytes, info diagnostic', async () => {
    const restore = stubQueryLocalFonts(async () => [
        mockEntry('PingFang SC', 'PingFangSC-Regular', 'Regular'),
        mockEntry('Noto Sans CJK SC', 'NotoSansCJKsc-Regular', 'Regular'),
        mockEntry('Arial', 'ArialMT', 'Regular'),
    ]);
    try {
        const res: any = await resolveLocalFonts();
        assert.strictEqual(res.localFontsAvailable, true);
        // CJK stack order: Noto Sans CJK SC is requested before PingFang SC.
        assert.strictEqual(res.fonts[0].family, 'Noto Sans CJK SC');
        assert.strictEqual(res.fonts[0].source, 'local');
        const bytes = await res.fonts[0].getBytes();
        assert.ok(bytes instanceof Uint8Array);
        assert.strictEqual(bytes.length, 8);
        const codes = res.diagnostics.map((d: any) => d.code);
        assert.ok(codes.includes('TYPST_LOCAL_FONTS_RESOLVED'));
        assert.ok(codes.includes('TYPST_LOCAL_FONTS_MISSING'), 'missing families must be diagnosed');
        assert.ok(res.fallbackChain[0].includes('Noto Sans CJK SC'));
        assert.ok(res.fallbackChain.some((s: string) => s.includes('NewCMMath')));
    } finally {
        restore();
    }
});

test('resolve: nothing found -> MISSING diagnostics, bundled-only, localFontsAvailable=false', async () => {
    const restore = stubQueryLocalFonts(async () => []);
    try {
        const res: any = await resolveLocalFonts({ cjk: ['Noto Sans CJK SC'], latin: [] });
        assert.strictEqual(res.fonts.length, 0);
        // Query succeeded but nothing matched: the sandbox compiles with
        // bundled fonts only, so localFontsAvailable must be false.
        assert.strictEqual(res.localFontsAvailable, false);
        const codes = res.diagnostics.map((d: any) => d.code);
        assert.ok(codes.includes('TYPST_LOCAL_FONTS_MISSING'));
        const missing = res.diagnostics.find((d: any) => d.code === 'TYPST_LOCAL_FONTS_MISSING');
        assert.ok(missing.message.includes('Noto Sans CJK SC'));
        assert.ok(res.fallbackChain[0].includes('NewCMMath'));
    } finally {
        restore();
    }
});

test('resolve: one font file is never mounted twice across CJK/Latin stacks', async () => {
    const restore = stubQueryLocalFonts(async () => [
        mockEntry('Noto Sans', 'NotoSans-Regular', 'Regular'),
    ]);
    try {
        const res: any = await resolveLocalFonts({ cjk: ['Noto Sans'], latin: ['Noto Sans'] });
        // The single installed file is claimed by CJK; Latin must not mount it again.
        assert.strictEqual(res.fonts.length, 1);
        assert.strictEqual(res.fonts[0].postscriptName, 'NotoSans-Regular');
        const codes = res.diagnostics.map((d: any) => d.code);
        assert.ok(codes.includes('TYPST_LOCAL_FONTS_ALREADY_MOUNTED'));
        assert.ok(!codes.includes('TYPST_LOCAL_FONTS_MISSING'), 'already-mounted is not a miss');
        assert.strictEqual(res.localFontsAvailable, true);
    } finally {
        restore();
    }
});

test('resolve: denied -> DENIED diagnostic, bundled-only chain', async () => {
    const err: any = new Error('denied');
    err.name = 'NotAllowedError';
    const restore = stubQueryLocalFonts(async () => {
        throw err;
    });
    try {
        const res: any = await resolveLocalFonts();
        assert.strictEqual(res.localFontsAvailable, false);
        assert.strictEqual(res.fonts.length, 0);
        const codes = res.diagnostics.map((d: any) => d.code);
        assert.ok(codes.includes('TYPST_LOCAL_FONTS_DENIED'));
        assert.ok(res.fallbackChain[0].includes('NewCMMath'));
    } finally {
        restore();
    }
});

test('resolve: non-Regular only -> STYLE_FALLBACK diagnostic (no silent swap)', async () => {
    const restore = stubQueryLocalFonts(async () => [
        mockEntry('Noto Sans CJK SC', 'NotoSansCJKsc-Bold', 'Bold'),
    ]);
    try {
        const res: any = await resolveLocalFonts({ cjk: ['Noto Sans CJK SC'], latin: [] });
        assert.strictEqual(res.fonts.length, 1);
        const codes = res.diagnostics.map((d: any) => d.code);
        assert.ok(codes.includes('TYPST_LOCAL_FONTS_STYLE_FALLBACK'));
        const d = res.diagnostics.find((x: any) => x.code === 'TYPST_LOCAL_FONTS_STYLE_FALLBACK');
        assert.ok(d.message.includes('Bold'));
    } finally {
        restore();
    }
});

test('resolve: limit truncates in priority order with info diagnostic', async () => {
    const restore = stubQueryLocalFonts(async () => [
        mockEntry('Noto Sans CJK SC', 'NotoSansCJKsc-Regular', 'Regular'),
        mockEntry('PingFang SC', 'PingFangSC-Regular', 'Regular'),
        mockEntry('Arial', 'ArialMT', 'Regular'),
    ]);
    try {
        const res: any = await resolveLocalFonts({ limit: 1 });
        assert.strictEqual(res.fonts.length, 1);
        assert.strictEqual(res.fonts[0].family, 'Noto Sans CJK SC');
        assert.ok(res.diagnostics.some((d: any) => d.code === 'TYPST_LOCAL_FONTS_TRUNCATED'));
    } finally {
        restore();
    }
});

test('stacks: CJK stack is non-empty and ordered', () => {
    assert.ok(Array.isArray(CJK_FONT_STACK) && CJK_FONT_STACK.length > 0);
    assert.strictEqual(CJK_FONT_STACK[0], 'Noto Sans CJK SC');
});

test('cache: warmLocalFontCache queries once and caches entries', async () => {
    let callCount = 0;
    const restore = stubQueryLocalFonts(async () => {
        callCount++;
        return [mockEntry('Noto Sans CJK SC', 'NotoSansCJKsc-Regular', 'Regular')];
    });
    try {
        assert.strictEqual(getCachedLocalFonts(), null);
        await warmLocalFontCache();
        assert.strictEqual(callCount, 1);
        const cached = getCachedLocalFonts();
        assert.ok(cached && cached.length === 1);
        assert.strictEqual(cached[0].family, 'Noto Sans CJK SC');

        // Calling warm again does not re-query
        await warmLocalFontCache();
        assert.strictEqual(callCount, 1);

        // queryLocalFontsProvider reuses the cache
        const res = await queryLocalFontsProvider();
        assert.strictEqual(res.ok, true);
        assert.strictEqual(callCount, 1);
    } finally {
        restore();
    }
});

test('cache: warmLocalFontCache handles rejection gracefully without throwing', async () => {
    const restore = stubQueryLocalFonts(async () => {
        throw new Error('Access denied');
    });
    try {
        await assert.doesNotReject(async () => {
            await warmLocalFontCache();
        });
        assert.strictEqual(getCachedLocalFonts(), null);
    } finally {
        restore();
    }
});

test('cache: clearLocalFontCache resets cached entries and allows re-query', async () => {
    let callCount = 0;
    const restore = stubQueryLocalFonts(async () => {
        callCount++;
        return [mockEntry('Arial', 'ArialMT', 'Regular')];
    });
    try {
        await warmLocalFontCache();
        assert.strictEqual(callCount, 1);
        assert.ok(getCachedLocalFonts() !== null);

        clearLocalFontCache();
        assert.strictEqual(getCachedLocalFonts(), null);

        const res = await queryLocalFontsProvider();
        assert.strictEqual(res.ok, true);
        assert.strictEqual(callCount, 2);
    } finally {
        restore();
    }
});
