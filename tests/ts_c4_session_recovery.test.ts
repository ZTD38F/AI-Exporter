import { account, key, address, seed, request, reset, records, events, deliveries, state, provider, indexes, details } from './helpers/applicationHarness.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runExport } from '../src/application/export/runExport.js';
import type { ExportRecord } from '../src/application/export/types.js';
import type { ConversationKey } from '../src/l2/conversationKey.js';

// C4 originally tested the removed v1 SessionRecovery/SessionStore pipeline.
// In v2 a new runExport invocation recovers from the latest per-ConversationKey
// ExportRecord; only a completed final delivery may create or replace that record.
// External modules are mocked at their frozen v2 ports by applicationHarness.
test.beforeEach(reset);

const oldRecord: ExportRecord = {
    exportedAt: 50,
    format: 'markdown',
    status: 'ok',
    chatTime: 50,
};

test('C4-v2-1: batch records are committed only after the final Browser delivery', async () => {
    seed('first');
    seed('second');
    records.set(address(key()), oldRecord);

    let deliveryCalls = 0;
    state.onDelivery = () => {
        deliveryCalls++;
        assert.strictEqual(records.get(address(key())), oldRecord, 'delivery has not committed the new record');
        assert.equal(records.has(address(key('second'))), false, 'second record cannot be written before delivery');
    };

    const result = await runExport(request({ keys: [key(), key('second')] }));
    assert.equal(result.exported, 2);
    assert.deepEqual(result.failed, []);
    assert.equal(deliveryCalls, 1, 'Browser batch triggers a single final delivery');
    assert.equal(deliveries.length, 1);
    assert.deepEqual(events, ['delivery', 'record:first', 'record:second']);
    for (const target of [key(), key('second')]) {
        const record = records.get(address(target))!;
        assert.deepEqual(Object.keys(record).sort(), ['chatTime', 'exportedAt', 'format', 'status']);
        assert.equal(record.status, 'ok');
        assert.equal(record.chatTime, 100);
    }
});

test('C4-v2-2: failed Browser delivery preserves old records; a new run recovers via ExportRecord', async () => {
    seed('first');
    seed('second');
    records.set(address(key()), oldRecord);
    state.failDelivery = 1;

    const failed = await runExport(request({ keys: [key(), key('second')] }));
    assert.equal(failed.exported, 0);
    assert.deepEqual(failed.failed, [key(), key('second')]);
    assert.strictEqual(records.get(address(key())), oldRecord);
    assert.equal(records.has(address(key('second'))), false);
    assert.equal(events.filter(event => event.startsWith('record:')).length, 0);

    state.failDelivery = 0;
    const recovered = await runExport(request({ keys: [key(), key('second')], skipUnchanged: true }));
    assert.equal(recovered.exported, 2, 'stale or absent records cannot skip a retry');
    assert.equal(recovered.skipped, 0);
    assert.deepEqual(recovered.failed, []);

    const next = await runExport(request({ keys: [key(), key('second')], skipUnchanged: true }));
    assert.equal(next.exported, 0);
    assert.equal(next.skipped, 2, 'a later run skips only the successfully recorded versions');
    assert.equal(deliveries.length, 2, 'skipped conversations do not trigger another delivery');
});

test('C4-v2-3: ExportRecord persistence failure is reported without replacing a previous record', async () => {
    seed();
    records.set(address(key()), oldRecord);
    state.failRecord = 'first';

    const failed = await runExport(request());
    assert.equal(failed.exported, 0);
    assert.deepEqual(failed.failed, [key()]);
    assert.strictEqual(records.get(address(key())), oldRecord);
    assert.deepEqual(events, ['delivery', 'record:first'], 'record write is attempted only after delivery');

    state.failRecord = '';
    const retried = await runExport(request());
    assert.equal(retried.exported, 1);
    assert.deepEqual(retried.failed, []);
    assert.equal(records.get(address(key()))?.status, 'ok');
    assert.equal(records.get(address(key()))?.chatTime, 100);
});

test('C4-v2-4: failed resource bytes produce a partial record that must be retried, not skipped', async () => {
    seed('first', { assets: true });
    provider.acquireResource = async () => { throw new Error('Resource temporarily unavailable'); };

    const partial = await runExport(request({ skipUnchanged: true }));
    assert.equal(partial.exported, 1);
    assert.equal(partial.partial, 1);
    assert.equal(records.get(address(key()))?.status, 'partial');
    assert.equal(records.get(address(key()))?.chatTime, 100);
    assert.deepEqual(Object.keys(state.rendererCalls[0].bindings), ['image','file']);

    provider.acquireResource = async () => ({ bytes: new Uint8Array([1, 2, 3]) });
    const retried = await runExport(request({ skipUnchanged: true }));
    assert.equal(retried.exported, 1);
    assert.equal(retried.skipped, 0, 'partial records are never eligible for skip');
    assert.equal(retried.partial, 0);
    assert.equal(records.get(address(key()))?.status, 'ok');

    const unchanged = await runExport(request({ skipUnchanged: true }));
    assert.equal(unchanged.exported, 0);
    assert.equal(unchanged.skipped, 1);
    assert.equal(deliveries.length, 2);
});

test('C4-v2-5: Folder delivery failure leaves only that ConversationKey unrecorded', async () => {
    seed('first');
    seed('second');
    records.set(address(key()), oldRecord);
    state.failDelivery = 1;

    const result = await runExport(request({
        keys: [key(), key('second')],
        delivery: 'folderWriter',
    }));
    assert.equal(result.exported, 1);
    assert.deepEqual(result.failed, [key()]);
    assert.strictEqual(records.get(address(key())), oldRecord);
    assert.equal(records.get(address(key('second')))?.status, 'ok');
    assert.deepEqual(events, ['delivery', 'delivery', 'record:second']);
    assert.equal(deliveries.length, 2);
    assert.deepEqual(state.releasedKeys, ['first', 'second']);
});

test('C4-v2-6: cancellation after a Folder delivery retains its record but does not process the next key', async () => {
    seed('first');
    seed('second');
    const controller = new AbortController();
    state.onDelivery = () => controller.abort();

    const result = await runExport(request({
        keys: [key(), key('second')],
        delivery: 'folderWriter',
    }), { signal: controller.signal });

    assert.equal(result.aborted, true);
    assert.equal(result.exported, 1);
    assert.deepEqual(result.failed, []);
    assert.equal(records.get(address(key()))?.status, 'ok');
    assert.equal(records.has(address(key('second'))), false);
    assert.deepEqual(events, ['delivery', 'record:first']);
    assert.equal(deliveries.length, 1);
});

test('C4-v2-7: identical conversation IDs in different accounts receive independent records', async () => {
    const { index, detail } = seed('first');
    const otherKey: ConversationKey = {
        accountId: '10000000-0000-4000-8000-000000000002',
        conversationId: 'first',
    };
    assert.notEqual(otherKey.accountId, account.id);
    indexes.set(address(otherKey), { ...index, key: otherKey });
    details.set(address(otherKey), { ...detail, key: otherKey });

    const result = await runExport(request({
        keys: [key(), otherKey],
        delivery: 'folderWriter',
    }));
    assert.equal(result.exported, 2);
    assert.deepEqual(result.failed, []);
    assert.equal(records.size, 2);
    assert.equal(records.get(address(key()))?.status, 'ok');
    assert.equal(records.get(address(otherKey))?.status, 'ok');
    assert.notStrictEqual(records.get(address(key())), records.get(address(otherKey)));
});


test('C4-v2-8: Browser staging reports prepared items without claiming delivery', async () => {
    seed('first');
    seed('second');
    const updates: string[] = [];
    state.onDelivery = () => {
        assert.deepEqual(updates, ['prepared:first', 'prepared:second']);
        assert.equal(records.size, 0, 'ZIP handoff must precede ExportRecords');
    };

    const result = await runExport(request({ keys: [key(), key('second')] }), {
        onItemUpdate: update => {
            updates.push(update.status + ':' + update.key.conversationId);
            if (update.status === 'prepared') {
                assert.equal(records.has(address(update.key)), false);
            } else if (update.status === 'exported') {
                assert.strictEqual(records.get(address(update.key)), update.record);
            }
        },
    });
    assert.equal(result.exported, 2);
    assert.deepEqual(updates, ['prepared:first', 'prepared:second', 'exported:first', 'exported:second']);
});

test('C4-v2-9: Folder reports committed results before delivering the next item', async () => {
    seed('first');
    seed('second');
    const updates: string[] = [];
    let deliveryCount = 0;
    state.onDelivery = () => {
        if (++deliveryCount === 2) {
            assert.deepEqual(updates, ['exported:first']);
            assert.equal(records.has(address(key())), true);
            assert.equal(records.has(address(key('second'))), false);
        }
    };
    const result = await runExport(request({ keys: [key(), key('second')], delivery: 'folderWriter' }), {
        onItemUpdate: update => {
            updates.push(update.status + ':' + update.key.conversationId);
            assert.equal(update.status, 'exported');
            if (update.status === 'exported') {
                assert.strictEqual(records.get(address(update.key)), update.record);
            }
        },
    });
    assert.equal(result.exported, 2);
    assert.deepEqual(updates, ['exported:first', 'exported:second']);
    assert.deepEqual(events, ['delivery', 'record:first', 'delivery', 'record:second']);
});

test('C4-v2-10: Failed ZIP delivery never promotes prepared items to exported', async () => {
    seed('first');
    seed('second');
    state.failDelivery = 1;
    const updates: string[] = [];
    const result = await runExport(request({ keys: [key(), key('second')] }), {
        onItemUpdate: update => updates.push(update.status + ':' + update.key.conversationId),
    });
    assert.equal(result.exported, 0);
    assert.deepEqual(result.failed, [key(), key('second')]);
    assert.equal(records.size, 0);
    assert.deepEqual(updates, ['prepared:first', 'prepared:second', 'failed:first', 'failed:second']);
});

test('C4-v2-11: Skipped items report settlement without staging or new receipts', async () => {
    seed('first');
    seed('second');
    records.set(address(key()), { ...oldRecord, chatTime: 100 });
    const updates: string[] = [];
    const result = await runExport(request({ keys: [key(), key('second')], skipUnchanged: true }), {
        onItemUpdate: update => updates.push(update.status + ':' + update.key.conversationId),
    });
    assert.equal(result.skipped, 1);
    assert.equal(result.exported, 1);
    assert.deepEqual(updates, ['skipped:first', 'prepared:second', 'exported:second']);
});
