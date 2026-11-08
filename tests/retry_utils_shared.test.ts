import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { calculateBackoff, abortableSleep } from '../src/shared/utils/retryUtils.js';
const SRC = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');


test('retryUtils - calculateBackoff computes deterministic exponential delays when jitter is 0', () => {
    const opts = { initialDelayMs: 1000, maxDelayMs: 20000, jitterMs: 0 };
    assert.strictEqual(calculateBackoff(0, opts), 1000, 'attempt 0 = 1000ms');
    assert.strictEqual(calculateBackoff(1, opts), 2000, 'attempt 1 = 2000ms');
    assert.strictEqual(calculateBackoff(2, opts), 4000, 'attempt 2 = 4000ms');
    assert.strictEqual(calculateBackoff(3, opts), 8000, 'attempt 3 = 8000ms');
    assert.strictEqual(calculateBackoff(4, opts), 16000, 'attempt 4 = 16000ms');
    assert.strictEqual(calculateBackoff(5, opts), 20000, 'attempt 5 capped at maxDelayMs 20000ms');
});

test('retryUtils - calculateBackoff applies jitter within [base, base + jitterMs)', () => {
    const opts = { initialDelayMs: 500, maxDelayMs: 10000, jitterMs: 300 };
    for (let i = 0; i < 20; i++) {
        const delay = calculateBackoff(1, opts); // base = 500 * 2^1 = 1000
        assert.ok(delay >= 1000, `delay ${delay} >= 1000`);
        assert.ok(delay <= 1300, `delay ${delay} <= 1300`);
    }
});

test('retryUtils - calculateBackoff default values match contract (initial 2000, max 30000, jitter 1000)', () => {
    for (let i = 0; i < 10; i++) {
        const d0 = calculateBackoff(0);
        assert.ok(d0 >= 2000 && d0 <= 3000, `attempt 0 in [2000, 3000], got ${d0}`);

        const d10 = calculateBackoff(10);
        assert.strictEqual(d10, 30000, `attempt 10 capped at 30000, got ${d10}`);
    }
});

test('retryUtils - calculateBackoff honors server Retry-After floor even beyond maxDelayMs', () => {
    // When server specifies Retry-After 60s, delay should honor it
    const delayHigh = calculateBackoff(0, { initialDelayMs: 1000, maxDelayMs: 10000, retryAfterMs: 60000, jitterMs: 0 });
    assert.strictEqual(delayHigh, 60000, 'honors retryAfterMs 60000');

    // When server Retry-After is smaller than natural backoff, natural backoff is not lowered
    const delayLow = calculateBackoff(3, { initialDelayMs: 1000, maxDelayMs: 10000, retryAfterMs: 2000, jitterMs: 0 });
    assert.strictEqual(delayLow, 8000, 'does not decrease natural backoff (8000ms)');

    // Non-positive or undefined retryAfterMs is ignored
    const delayZero = calculateBackoff(0, { initialDelayMs: 1000, maxDelayMs: 10000, retryAfterMs: 0, jitterMs: 0 });
    assert.strictEqual(delayZero, 1000, 'zero retryAfterMs ignored');
    const delayNeg = calculateBackoff(0, { initialDelayMs: 1000, maxDelayMs: 10000, retryAfterMs: -500, jitterMs: 0 });
    assert.strictEqual(delayNeg, 1000, 'negative retryAfterMs ignored');
});


test('retryUtils - abortableSleep resolves immediately on non-positive ms', async () => {
    const resZero = await abortableSleep(0);
    assert.strictEqual(resZero, false, 'ms=0 resolves false');

    const resNeg = await abortableSleep(-100);
    assert.strictEqual(resNeg, false, 'ms=-100 resolves false');

    const controller = new AbortController();
    controller.abort();
    const resPreAbortedZero = await abortableSleep(0, controller.signal);
    assert.strictEqual(resPreAbortedZero, true, 'ms=0 with aborted signal resolves true');
});

test('retryUtils - abortableSleep without signal sleeps full duration and resolves false', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        let done1 = false;
        const p1 = abortableSleep(5000).then((res: boolean) => { done1 = true; return res; });
        assert.strictEqual(done1, false, 'should not resolve before delay');
        t.mock.timers.tick(5000);
        const res1 = await p1;
        assert.strictEqual(res1, false, 'undefined signal resolves false');

        let done2 = false;
        const p2 = abortableSleep(5000, null).then((res: boolean) => { done2 = true; return res; });
        assert.strictEqual(done2, false, 'should not resolve before delay');
        t.mock.timers.tick(5000);
        const res2 = await p2;
        assert.strictEqual(res2, false, 'null signal resolves false');
    } finally {
        t.mock.timers.reset();
    }
});

test('retryUtils - abortableSleep with pre-aborted signal returns true immediately', async () => {
    const controller = new AbortController();
    controller.abort();

    const res = await abortableSleep(5000, controller.signal);
    assert.strictEqual(res, true, 'pre-aborted signal resolves true');
});

test('retryUtils - abortableSleep cuts sleep short when aborted mid-way', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const controller = new AbortController();
        const sleepPromise = abortableSleep(5000, controller.signal);

        t.mock.timers.tick(100);
        controller.abort();

        const res = await sleepPromise;
        assert.strictEqual(res, true, 'aborted sleep resolves true');
    } finally {
        t.mock.timers.reset();
    }
});

test('retryUtils - abortableSleep completes normally when signal never aborts', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const controller = new AbortController();
        const sleepPromise = abortableSleep(5000, controller.signal);
        t.mock.timers.tick(5000);
        const res = await sleepPromise;
        assert.strictEqual(res, false, 'unaborted sleep resolves false');
    } finally {
        t.mock.timers.reset();
    }
});

// Shared ownership must never import real L1 implementations.
test('architecture - retryUtils.ts does not import engine or api modules', () => {
    const src = SRC('src/shared/utils/retryUtils.ts');
    assert.ok(!/from\s+['"][^'"]*engine/i.test(src), 'retryUtils must not import from engine');
    assert.ok(!/from\s+['"][^'"]*api/i.test(src), 'retryUtils must not import from api');
});
