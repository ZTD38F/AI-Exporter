export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

// ---------- P1-023: monotonic progress ----------
test('p1_b3 - P1-023: progress never goes backwards', () => {
    const src = SRC('core/engine/export/progressReporter.ts');
    assert.ok(src.includes('lastPct'), 'monotonic tracker exists');
    assert.ok(/Math\.max\(this\.lastPct/.test(src), 'clamped to max of last and current');
});

// ---------- P1-027: base64-only cap ----------
test('p1_b3 - P1-027: 50MB cap only on base64 path', () => {
    const src = SRC('content/assetFetcher.ts');
    // The cap check must appear AFTER the preferBuffer early-return, not before
    const bufferIdx = src.indexOf('if (msg.preferBuffer === true');
    const capIdx = src.indexOf('if (blob.size > MAX_BASE64_BLOB_SIZE)');
    assert.ok(bufferIdx !== -1 && capIdx !== -1, 'both sections present');
    assert.ok(bufferIdx < capIdx, 'buffer path tried before cap check');
});

// ---------- P1-029: bounded image concurrency ----------
test('p1_b3 - P1-029: image fetch has concurrency bound', () => {
    const src = SRC('content/liveSaveCoordinator.ts');
    assert.ok(src.includes('IMAGE_FETCH_CONCURRENCY'), 'concurrency constant exists');
    assert.ok(/const workerCount = Math\.min\(IMAGE_FETCH_CONCURRENCY/.test(src), 'worker pool bounded');
});

// ---------- P1-036: abortable cooldown ----------
test('p1_b3 - P1-036: waitForCooldown is abort-interruptible', () => {
    const src = SRC('core/engine/export/rateLimiter.ts');
    assert.ok(src.includes('abortableSleep'), 'abortableSleep exists');
});

// ---------- P1-037: stagger ----------
test('p1_b3 - P1-037: cooldown has stagger', () => {
    const src = SRC('core/engine/export/rateLimiter.ts');
    assert.ok(src.includes('stagger'), 'stagger exists');
});
