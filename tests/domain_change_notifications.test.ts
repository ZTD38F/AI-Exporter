import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyDomainChanged, observeDomainChanges } from '../src/runtime/api/domainChanges.js';

test('committed change notifications never wait for slow or failing UI observers', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen: string[] = [];
    const stopSlow = observeDomainChanges(async id => { seen.push(`started:${id}`); await gate; seen.push(`finished:${id}`); });
    const stopThrowing = observeDomainChanges(() => { throw new Error('view closed'); });
    const stopRejecting = observeDomainChanges(async () => { throw new Error('view read failed'); });
    const stopHealthy = observeDomainChanges(id => { seen.push(`healthy:${id}`); });
    try {
        assert.equal(notifyDomainChanged('first'), undefined);
        assert.equal(seen.length, 0);
        await Promise.resolve();
        assert.deepEqual(seen, ['started:first', 'healthy:first']);
        notifyDomainChanged('second');
        await Promise.resolve();
        assert.deepEqual(seen, ['started:first', 'healthy:first', 'started:second', 'healthy:second']);
        release();
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        assert.ok(seen.includes('finished:first'));
        assert.ok(seen.includes('finished:second'));
    } finally { release(); stopSlow(); stopThrowing(); stopRejecting(); stopHealthy(); }
    const count = seen.length;
    notifyDomainChanged('after-close');
    await Promise.resolve();
    assert.equal(seen.length, count);
});
