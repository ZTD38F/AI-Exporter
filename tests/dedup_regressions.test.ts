import { v2LiveSaveHost, seedLiveDetail, liveKey } from './helpers/v2LiveSaveHost.js';
import { runLiveSave } from '../src/runtime/background/liveSaveHandler.js';
import { getExportRecord } from '../src/l3a/storageService.js';
import { buildExportFileName } from '../src/shared/utils/pathUtils.js';
export {};
const test = require('node:test');
const assert = require('node:assert');

const { calculateBackoff } = require('../src/shared/utils/retryUtils.js');


// Ordinary request rate limiting is based on HTTP 429 only.


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

// live-save pipeline unification: both call sites share format + writer.

test('dedup - Live Save uses the shared Markdown renderer and Packaging filename', async (t: import('node:test').TestContext) => {
    const host = v2LiveSaveHost(t);
    await seedLiveDetail('abc123', [], { title: 'Canonical title' });
    const result = await runLiveSave(liveKey('abc123'));
    assert.strictEqual(result?.exported, 1);
    const name = buildExportFileName('Canonical title', 'abc123', 'md');
    assert.deepStrictEqual([...host.files.keys()], [name]);
    const markdown = host.files.get(name);
    assert.ok(typeof markdown === 'string' && markdown.includes('Answer for abc123'));
    assert.ok(typeof markdown === 'string' && markdown.includes('Canonical title'));
});

test('dedup - Live Save input failure cannot write a fallback or commit a record', async (t: import('node:test').TestContext) => {
    const host = v2LiveSaveHost(t);
    await require('../src/application/settings/index.js').updateSettings({ enabledDisk: true, defaultFormat: 'markdown' });
    // No trustworthy Domain is available; there is no parallel scraper/formatter fallback.
    const { ingestIndexes } = require('../src/l2/ingestion.js');
    await ingestIndexes(liveKey('fatal').accountId, [{ conversationId: 'fatal', fields: { title: 'Unavailable', titleSource: 'provider' } }]);
    const result = await runLiveSave(liveKey('fatal'));
    assert.deepStrictEqual(result?.failed, [liveKey('fatal')]);
    assert.strictEqual(host.files.size, 0);
    assert.strictEqual(await getExportRecord(liveKey('fatal')), null);
});

test('dedup - repeated Live Save replaces the planned file rather than creating a second filename policy', async (t: import('node:test').TestContext) => {
    const host = v2LiveSaveHost(t);
    await seedLiveDetail('n9', [], { title: 'Stable title', savedAt: 100 });
    await runLiveSave(liveKey('n9'));
    await seedLiveDetail('n9', [], { title: 'Stable title', savedAt: 200 });
    await runLiveSave(liveKey('n9'));
    assert.deepStrictEqual([...host.files.keys()], [buildExportFileName('Stable title', 'n9', 'md')]);
    assert.strictEqual((await getExportRecord(liveKey('n9')))?.chatTime, 200);
    assert.strictEqual(host.events.filter(event => event.startsWith('close:')).length, 2);
});
