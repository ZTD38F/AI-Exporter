import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    handleHttp429,
    interruptibleSleep
} from '../src/l1/client/gemini/api/retryPolicy.js';

const SRC = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');


test('retryPolicy - interruptibleSleep delegates to abortableSleep when isAborted is omitted', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const fullPromise = interruptibleSleep(5000);
        t.mock.timers.tick(5000);
        const full = await fullPromise;
        assert.strictEqual(full, false, 'unaborted resolves false');

        const controller = new AbortController();
        const cutPromise = interruptibleSleep(5000, controller.signal);
        t.mock.timers.tick(100);
        controller.abort();
        const cut = await cutPromise;
        assert.strictEqual(cut, true, 'aborted resolves true');
    } finally {
        t.mock.timers.reset();
    }
});

test('retryPolicy - interruptibleSleep polling handles custom isAborted predicate', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
        let abortedFlag = true;
        const resInit = await interruptibleSleep(5000, undefined, () => abortedFlag);
        assert.strictEqual(resInit, true, 'initially aborted returns true');

        abortedFlag = false;
        const pPoll = interruptibleSleep(5000, undefined, () => abortedFlag);
        t.mock.timers.tick(50);
        abortedFlag = true;
        t.mock.timers.tick(50);
        const resPoll = await pPoll;
        assert.strictEqual(resPoll, true, 'polling aborted returns true');

        abortedFlag = false;
        const pNormal = interruptibleSleep(5000, undefined, () => abortedFlag);
        t.mock.timers.tick(5000);
        const resNormal = await pNormal;
        assert.strictEqual(resNormal, false, 'non-aborted predicate resolves false');
    } finally {
        t.mock.timers.reset();
    }
});

test('retryPolicy - handleHttp429 honors Retry-After header and backoff options', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const resPromise = handleHttp429({
            resp: {
                status: 429,
                headers: { get: (h: string) => (h === 'retry-after' ? '1' : null) }
            },
            retryCount: 0,
            maxRetries: 3,
            label: 'test-429'
        });
        t.mock.timers.tick(35000);
        const res = await resPromise;
        assert.strictEqual(res.shouldRetry, true);
        assert.strictEqual(res.nextRetryCount, 1);
        assert.ok(typeof res.delayMs === 'number' && res.delayMs >= 2000, `delayMs >= 2000 (was ${res.delayMs})`);
    } finally {
        t.mock.timers.reset();
    }
});





test('architecture - retryPolicy.ts does not import export engine or rateLimiter', () => {
    const src = SRC('src/l1/client/gemini/api/retryPolicy.ts');
    assert.ok(!/from\s+['"][^'"]*engine/i.test(src), 'retryPolicy must not import from engine');
    assert.ok(!/from\s+['"][^'"]*rateLimiter/i.test(src), 'retryPolicy must not import rateLimiter');
    assert.ok(src.includes('retryUtils'), 'retryPolicy imports from retryUtils');
});

