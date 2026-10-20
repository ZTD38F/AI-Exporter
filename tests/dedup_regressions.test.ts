export {};
const test = require('node:test');
const assert = require('node:assert');

const { isRateLimited, calculateBackoff } = require('../src/core/engine/export/rateLimiter.js');
const { formatLiveSaveMarkdown, writeLiveSaveMarkdown } = require('../src/core/engine/liveSaveWriter.js');

// ---------------------------------------------------------------------------
// 429 predicate unification: all previously inlined variants must be caught
// by the single canonical isRateLimited.
// ---------------------------------------------------------------------------

test('dedup - isRateLimited catches every previously inlined 429 variant', () => {
    const positives: Array<[string, any]> = [
        ['http 429 status', { success: false, status: 429, error: '' }],
        ['429 in message', { success: false, error: 'request failed: 429' }],
        ['rate limit words', { success: false, error: 'Rate limit exceeded, retry later' }],
        ['quota', { success: false, error: 'quota exceeded for model' }],
        ['too many requests', { success: false, error: 'Too Many Requests' }],
        // legacy variants previously inlined only in content/messageRouter.ts
        ['BardErrorInfo', { success: false, error: 'BardErrorInfo: something broke' }],
        ['1096 code', { success: false, error: 'error 1096 occurred' }],
        ['resource_exhausted', { success: false, error: 'RESOURCE_EXHAUSTED grpc status' }],
    ];
    for (const [label, res] of positives) {
        assert.strictEqual(isRateLimited(res), true, `should detect: ${label}`);
    }

    const negatives: Array<[string, any]> = [
        ['success result', { success: true, status: 429 }],
        ['null', null],
        ['undefined', undefined],
        ['unrelated error', { success: false, error: 'network timeout' }],
        ['empty', { success: false, error: '' }],
    ];
    for (const [label, res] of negatives) {
        assert.strictEqual(isRateLimited(res), false, `should not flag: ${label}`);
    }
});

test('dedup - calculateBackoff keeps formula, cap and honors Retry-After', () => {
    // without Retry-After: capped at 30s even for large retry counts
    for (let i = 0; i < 6; i++) {
        const d = calculateBackoff(10);
        assert.ok(d <= 30000, `backoff capped at 30000, got ${d}`);
        assert.ok(d >= 0, 'backoff non-negative');
    }
    // with Retry-After: delay is at least retryAfterMs, may exceed the cap
    // (matches the old retryPolicy.handleHttp429 semantics)
    const withAfter = calculateBackoff(0, { retryAfterMs: 60000 });
    assert.ok(withAfter >= 60000, `Retry-After honored, got ${withAfter}`);
    // small Retry-After below the computed delay does not shrink it
    const smallAfter = calculateBackoff(3, { retryAfterMs: 100 });
    assert.ok(smallAfter >= 2000 * Math.pow(2, 3), `computed delay kept, got ${smallAfter}`);
});

// ---------------------------------------------------------------------------
// live-save pipeline unification: both call sites share format + writer.
// ---------------------------------------------------------------------------

test('dedup - formatLiveSaveMarkdown uses shared filename format and formatter', async () => {
    const seen: any[] = [];
    const deps = {
        buildFileName: (t: string, n: string, e: string) => { seen.push([t, n, e]); return `${t}_${n}.${e}`; },
        formatter: { formatMarkdownCanonical: async (c: any) => ({ content: `#MOCK#${c.title}#${c.id}`, ext: 'md', mime: 'text/markdown' }) },
    };
    const { fileName, markdown } = await formatLiveSaveMarkdown(
        { chat: { messages: [{ role: 'user', content: 'hi' }] }, safeTitle: 'My Chat', nid: 'abc123' },
        deps
    );
    assert.deepStrictEqual(seen, [['My Chat', 'abc123', 'md']]);
    assert.strictEqual(fileName, 'My Chat_abc123.md');
    assert.strictEqual(markdown, '#MOCK#My Chat#abc123');
});

test('dedup - live-save formatting failures propagate without writing a fallback', async () => {
    let writes = 0;
    await assert.rejects(writeLiveSaveMarkdown(
        { init: async () => {}, writeFile: async () => { writes++; } },
        { chat: {}, safeTitle: 'T', nid: 'n1' },
        { formatter: { formatMarkdownCanonical: async () => { throw new Error('formatting failed'); } } },
    ), /formatting failed/);
    assert.strictEqual(writes, 0);
});

test('dedup - writeLiveSaveMarkdown writes via shared writer and honors fileName override', async () => {
    const writes: any[] = [];
    const fakeWriter = {
        init: async () => {},
        writeFile: async (subDir: string, file: string, data: string) => { writes.push([subDir, file, data]); },
    };
    const deps = {
        buildFileName: (t: string, n: string) => `built_${n}.md`,
        formatter: { formatMarkdownCanonical: async () => ({ content: 'MD-BODY', ext: 'md', mime: 'text/markdown' }) },
    };

    const target1 = await writeLiveSaveMarkdown(
        fakeWriter, { chat: {}, safeTitle: 'T', nid: 'n9' }, deps
    );
    assert.strictEqual(target1, 'built_n9.md');
    assert.deepStrictEqual(writes[0], ['', 'built_n9.md', 'MD-BODY']);

    const target2 = await writeLiveSaveMarkdown(
        fakeWriter, { chat: {}, safeTitle: 'T', nid: 'n9' }, deps, { fileName: 'custom.md' }
    );
    assert.strictEqual(target2, 'custom.md');
    assert.deepStrictEqual(writes[1], ['', 'custom.md', 'MD-BODY']);
});
