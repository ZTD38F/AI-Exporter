import { account, key, address, seed, request, reset, records, events, deliveries, state, provider, indexes, details, contexts, references } from './helpers/applicationHarness.js';
import { ResourceHttpError } from '../src/shared/resources/resourceResult.js';
import { OperationError } from '../src/shared/errors/operationError.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runExport, shouldSkipExport } from '../src/application/export/runExport.js';
import { prepareExportResources } from '../src/application/export/prepareExportResources.js';
import { updateSettings } from '../src/application/settings/index.js';
import type { ExportRecord, ExportDiagnostic } from '../src/application/export/types.js';

test.beforeEach(reset);
test('folder basename survives title updates and intervening browser exports without crossing keys', async () => {
    seed(); seed('second');
    records.set(address(key()), { format: 'markdown', status: 'ok', exportedAt: 1, folderBaseName: 'First folder name' });
    await runExport(request({ delivery: 'folderWriter', skipUnchanged: false }));
    assert.equal(state.builtFiles.at(-1)?.plan.fileName, 'First folder name.markdown');
    await runExport(request({ delivery: 'browserDownload', format: 'html' }));
    assert.equal(records.get(address(key()))?.folderBaseName, 'First folder name');
    await runExport(request({ keys: [key(), key('second')], delivery: 'folderWriter' }));
    assert.equal(state.builtFiles.at(-2)?.plan.fileName, 'First folder name.markdown');
    assert.equal(state.builtFiles.at(-1)?.plan.fileName, 'mock-second.markdown');
});
const previous: ExportRecord = { format: 'markdown', exportedAt: 999, chatTime: 100, status: 'ok' };
test('Skip requires same format, ok record and comparable source versions; delivery options do not matter', () => {
    assert.equal(shouldSkipExport(previous, 100, request({ skipUnchanged: true })), true);
    for (const record of [{ ...previous, format: 'pdf' as const }, { ...previous, status: 'partial' as const }, { ...previous, chatTime: undefined }, { ...previous, chatTime: 99 }]) {
        assert.equal(shouldSkipExport(record, 100, request({ skipUnchanged: true })), false);
    }
    assert.equal(shouldSkipExport(previous, undefined, request({ skipUnchanged: true })), false);
    assert.equal(shouldSkipExport(previous, 100, request()), false);
    assert.equal(shouldSkipExport(previous, 100, request({ skipUnchanged: true, includeAssets: false, delivery: 'folderWriter', })), true);
});
test('Skip accepts zero epoch-ms but rejects fractional, nonfinite and unsafe source versions', () => {
    const skip = request({ skipUnchanged: true });
    assert.equal(shouldSkipExport({ ...previous, chatTime: 0 }, 0, skip), true);
    for (const invalid of [NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(shouldSkipExport({ ...previous, chatTime: invalid }, 100, skip), false);
        assert.equal(shouldSkipExport(previous, invalid, skip), false);
    }
});
for (const format of ['markdown', 'html', 'json', 'pdf'] as const) {
    test(`${format} uses local Domain, shared resources, then delivery before the minimal Record`, async () => {
        seed();
        const startedAt = Date.now();
        const result = await runExport(request({ format }));
        assert.equal(result.exported, 1); assert.equal(result.partial, 0);
        assert.deepEqual(events, ['delivery', 'record:first']);
        const record = records.get(address(key()))!;
        assert.deepEqual(Object.keys(record).sort(), ['chatTime', 'exportedAt', 'format', 'status']);
        assert.equal(record.chatTime, 100); assert.equal(record.format, format);
        assert.ok(record.exportedAt >= startedAt && record.exportedAt <= Date.now(), 'delivery record uses real epoch-ms');
        assert.equal(deliveries[0].length, 1);
        if (format === 'pdf') { assert.equal(state.disposed, 1); assert.equal(state.pdfRenderKey, 'first'); }
        else assert.deepEqual(state.rendererCalls.map(call => [call.format, call.key]), [[format, 'first']]);
        assert.equal(state.compositions.length, format === 'json' ? 0 : 1);
        assert.equal(state.jsonInputs.length, format === 'json' ? 1 : 0);
    });
    test(`${format} includeAssets=false does not acquire bytes or mark intentional omissions partial`, async () => {
        seed('first', { assets: true });
        const result = await runExport(request({ format, includeAssets: false }));
        assert.equal(result.exported, 1); assert.equal(result.partial, 0);
        assert.ok(!events.some(event => event.startsWith('acquire:')));
        if (format === 'json') {
            assert.equal(state.jsonInputs[0].detail.assets.length, 3);
            assert.deepEqual(state.rendererCalls[0].bindings, {});
        }
    });
    test(`${format} chooses only the format's required resource IDs`, async () => {
        seed('first', { assets: true });
        const result = await runExport(request({ format }));
        assert.equal(result.exported, 1);
        assert.deepEqual(events.filter(event => event.startsWith('acquire:')), format === 'json'
            ? ['acquire:image', 'acquire:file', 'acquire:unused'] : ['acquire:image', 'acquire:file']);
        if (format === 'pdf') {
            assert.deepEqual(state.browserPlans[0].preparedIds, ['image', 'file']);
            assert.deepEqual(state.browserPlans[0].fileIds, ['file']);
        } else {
            assert.deepEqual(state.folderPlans[0].preparedIds, [], 'linked paths are planned without bytes');
            assert.deepEqual(state.folderPlans[0].fileIds, format === 'json' ? [] : ['file']);
            assert.deepEqual(Object.keys(state.rendererCalls[0].bindings), format === 'json' ? ['image','file','unused'] : ['image','file']);
        }
        if (format === 'pdf') {
            assert.deepEqual(state.pdfPrepared, ['image', 'file']);
            assert.ok(state.pdfBindings.image); assert.ok(state.pdfBindings.file);
        }
        assert.equal(state.packages.length, 1);
        assert.deepEqual(state.packages[0], { delivery: 'browserDownload', groups: 1, files: format === 'pdf' ? 1 : format === 'json' ? 4 : 3 });
        assert.equal(deliveries.length, 1);
    });
}
test('PDF supplies L4 the referenced original-file IDs and all prepared bytes', async () => {
    seed('first', { assets: true });
    const result = await runExport(request({ format: 'pdf', delivery: 'folderWriter' }));
    assert.equal(result.exported, 1);
    assert.deepEqual(state.folderPlans.map(plan => plan.fileIds), [['file']]);
    assert.deepEqual(state.folderPlans[0].preparedIds, ['image', 'file']);
    assert.deepEqual(state.pdfPrepared, ['image', 'file']);
    assert.equal(state.builtFiles[0].format, 'pdf');
    assert.equal(deliveries.length, 1);
    // Emitting original files vs embedded media is L4's responsibility, not an Application unit assertion.
});
for (const format of ['markdown', 'html', 'pdf'] as const) {
    test(`${format} uses the shared Settings language for renderer-owned text`, async () => {
        await updateSettings({ language: 'zh' });
        seed();
        const result = await runExport(request({ format }));
        assert.equal(result.exported, 1);
        assert.equal(state.settingsReads, 1);
        if (format === 'pdf') assert.equal(state.pdfLocale, 'zh');
        else assert.equal(state.rendererCalls[0].locale, 'zh');
    });
}
test('Export defaults to the Chrome browser language when the user has no preference', async t => {
    const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'zh-CN' } });
    t.after(() => {
        if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
        else Reflect.deleteProperty(globalThis, 'navigator');
    });
    seed();
    const result = await runExport(request({ format: 'markdown' }));
    assert.equal(result.exported, 1);
    assert.equal(state.rendererCalls[0].locale, 'zh');
});
test('Export resolves renderer language once per task and JSON does not read renderer preferences', async () => {
    await updateSettings({ language: 'en' });
    seed(); seed('second');
    const result = await runExport(request({ keys: [key(), key('second')], delivery: 'folderWriter' }));
    assert.equal(result.exported, 2);
    assert.equal(state.settingsReads, 1);
    reset(); seed();
    assert.equal((await runExport(request({ format: 'json' }))).exported, 1);
    assert.equal(state.settingsReads, 0);
});
test('HTML warning diagnostics keep ok, while L4 content omission produces partial', async () => {
    seed();
    state.htmlDiagnostics = [{ severity: 'warning', code: 'FONT_SUBSTITUTED', message: 'fallback' }];
    const first = await runExport(request({ format: 'html' }));
    assert.equal(first.exported, 1); assert.equal(first.partial, 0);
    state.htmlDiagnostics = [{ severity: 'warning', code: 'FORMAT_CONTENT_OMITTED', message: 'omitted' }];
    const second = await runExport(request({ format: 'html' }));
    assert.equal(second.exported, 1); assert.equal(second.partial, 1);
    assert.equal(records.get(address(key()))?.status, 'partial');
});
test('PDF ordinary renderer diagnostics do not mark partial, but FORMAT_CONTENT_OMITTED does', async () => {
    seed();
    state.pdfDiagnostics = [{ severity: 'warning', code: 'TYPST_LOCAL_FONT_READ_FAILED', message: 'fallback used' }];
    const first = await runExport(request({ format: 'pdf' }));
    assert.equal(first.exported, 1); assert.equal(first.partial, 0);
    assert.equal(records.get(address(key()))?.status, 'ok');
    state.pdfDiagnostics = [{ severity: 'warning', code: 'FORMAT_CONTENT_OMITTED', message: 'content omitted' }];
    const second = await runExport(request({ format: 'pdf' }));
    assert.equal(second.exported, 1); assert.equal(second.partial, 1);
    assert.equal(records.get(address(key()))?.status, 'partial');
});
test('skipUnchanged opt-in uses the matching Record; false always performs the export', async () => {
    seed(); records.set(address(key()), previous);
    assert.equal((await runExport(request({ skipUnchanged: true }))).skipped, 1);
    assert.equal((await runExport(request())).exported, 1);
    assert.equal(events.filter(event => event === 'delivery').length, 1);
});
test('unknown source version refreshes, exports without inventing chatTime and never skips', async () => {
    const { detail } = seed(); delete detail.savedAt;
    records.set(address(key()), { ...previous, chatTime: undefined });
    const result = await runExport(request({ skipUnchanged: true }));
    assert.equal(result.exported, 1); assert.equal(result.skipped, 0);
    assert.deepEqual(events, ['refresh', 'delivery', 'record:first']);
    assert.equal(records.get(address(key()))?.chatTime, undefined);
});
test('stale refresh failure exports old Detail as partial with its actual version', async () => {
    seed('first', { savedAt: 90 });
    provider.fetchConversationDetail = async () => { events.push('refresh'); throw new Error('offline'); };
    const result = await runExport(request());
    assert.equal(result.partial, 1); assert.equal(records.get(address(key()))?.chatTime, 90);
});
test('confirmed remote Detail deletion fails the Key instead of exporting its stale local snapshot', async () => {
    seed('first', { savedAt: 90 });
    records.set(address(key()), previous);
    provider.fetchConversationDetail = async () => { events.push('refresh'); throw new Error('conversation_not_found'); };
    const result = await runExport(request());
    assert.equal(result.exported, 0);
    assert.deepEqual(result.failed, [key()]);
    assert.deepEqual(events, ['refresh']);
    assert.equal(records.get(address(key())), previous);
    assert.equal(deliveries.length, 0);
});
test('unknown Detail quality exports as partial and cannot satisfy Skip after refresh failure', async () => {
    seed('first', { quality: 'unknown' });
    provider.fetchConversationDetail = async () => { events.push('refresh'); throw new Error('offline'); };
    const first = await runExport(request({ skipUnchanged: true }));
    assert.equal(first.exported, 1);
    assert.equal(first.partial, 1);
    assert.equal(records.get(address(key()))?.status, 'partial');
    const second = await runExport(request({ skipUnchanged: true }));
    assert.equal(second.skipped, 0);
    assert.equal(second.partial, 1);
    assert.equal(events.filter(event => event === 'refresh').length, 2);
    assert.equal(events.filter(event => event === 'delivery').length, 2);
});
for (const format of ['markdown', 'html', 'json', 'pdf'] as const) {
    test(`${format} exports a valid Detail with zero messages`, async () => {
        const { detail } = seed();
        detail.messages.splice(0);
        const result = await runExport(request({ format }));
        assert.equal(result.exported, 1);
        assert.deepEqual(result.failed, []);
        if (format === 'json') assert.deepEqual(state.jsonInputs[0].detail.messages, []);
        else assert.deepEqual(state.compositions[0].detail.messages, []);
    });
}
test('Folder Writer creates one shared L4 planner and calls it once per conversation', async () => {
    seed('alpha_sameid'); seed('beta_sameid');
    const result = await runExport(request({
        keys: [key('alpha_sameid'), key('beta_sameid')], format: 'markdown', delivery: 'folderWriter',
    }));
    assert.equal(result.exported, 2);
    assert.deepEqual(state.folderPlannerCreations, ['markdown']);
    assert.deepEqual(state.folderPlans.map(plan => plan.key), ['alpha_sameid', 'beta_sameid']);
    assert.equal(state.browserPlans.length, 0);
    assert.equal(state.packages.length, 0, 'Folder groups go directly to Delivery');
});
test('refresh is void; Export rereads L2 instead of using a Provider response', async () => {
    seed('first', { savedAt: 90 });
    provider.fetchConversationDetail = async (accountId, conversationId) => {
        assert.equal(accountId, account.id); assert.equal(conversationId, 'first');
        const { detail } = seed(); detail.messages[0].content = [{ type: 'paragraph', children: [{ type: 'text', text: 'Committed replacement' }] }];
    };
    const result = await runExport(request());
    assert.equal(result.partial, 0);
    assert.match(JSON.stringify(state.compositions[0].detail.messages), /Committed replacement/);
    assert.equal(state.compositions.length, 1);
});
test('Popup with no local Index still refreshes and rereads Domain', async () => {
    provider.fetchConversationDetail = async () => { seed(); };
    assert.equal((await runExport(request())).exported, 1);
});
test('missing Detail fails only that target and preserves old record', async () => {
    records.set(address(key()), previous); seed('second');
    const result = await runExport(request({ keys: [key(), key('second')] }));
    assert.deepEqual(result.failed, [key()]); assert.equal(result.exported, 1);
    assert.equal(records.get(address(key())), previous);
});
test('failed attachments preserve delivered links and produce an explicit report', async () => {
    seed('first', { assets: true });
    provider.acquireResource = async () => { throw new Error('unavailable'); };
    const result = await runExport(request({ format: 'json' }));
    assert.equal(result.partial, 1);
    assert.deepEqual(Object.keys(state.rendererCalls[0].bindings), ['image','file','unused']);
    assert.equal(state.jsonInputs[0].detail.assets.length, 3);
    assert.equal(deliveries.length, 1, 'corrected body and failure report share the final delivery');
    assert.equal(result.attachmentIssues?.length, 3);
});
function gate() {
    let release = (): void => {};
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
}
for (const delivery of ['folderWriter', 'browserDownload'] as const) {
    test(`${delivery} prepares all bodies while the first conversation attachments remain blocked`, { timeout: 5000 }, async () => {
        const ids = ['first', 'second', 'third', 'fourth', 'fifth'];
        for (const id of ids) seed(id, { assets: true, savedAt: 90 });
        const sourceReads: string[] = [];
        const bodiesPrepared = gate();
        let preparedCount = 0;
        const bodyReceipts: string[] = [];
        const attachments = gate();
        provider.fetchConversationDetail = async (_account, id) => {
            sourceReads.push(id);
            seed(id, { assets: true });

        };
        provider.acquireResource = async (conversationKey) => {
            if (conversationKey.conversationId === 'first') await attachments.promise;
            return { bytes: Uint8Array.of(1) };
        };
        const exporting = runExport(request({ keys: ids.map(id => key(id)), delivery }), {
            onConversationPrepared: () => { if (++preparedCount === ids.length) bodiesPrepared.release(); },
            onBodyDelivered: value => { bodyReceipts.push(value.conversationId); },
        });
        try {
            await bodiesPrepared.promise;
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.deepEqual(sourceReads, ids, 'a slow attachment never stops later source reads');
            assert.deepEqual(bodyReceipts, delivery === 'folderWriter' ? ids : []);
            assert.equal(state.compositions.length, ids.length, 'all bodies have been composed and rendered independently');
            assert.equal(deliveries.length, delivery === 'folderWriter' ? ids.length : 0);
            assert.equal(records.size, 0, 'body delivery alone must not claim successful attachment delivery');
            assert.deepEqual(state.releasedKeys, [], 'readers remain alive until attachments settle');
        } finally { attachments.release(); }
        const result = await exporting;
        assert.equal(result.exported, 5);
        assert.deepEqual(state.releasedKeys, ids);
        assert.equal(state.releasedContexts, 1);
        const plans = state.folderPlans;
        assert.deepEqual(plans.map(plan => plan.key), ids);
        assert.deepEqual(events.filter(event => event.startsWith('record:')), ids.map(id => `record:${id}`));
    });
}
test('attachment pool limits parallel downloads and preserves reference order after out-of-order completion', async () => {
    const assets = Array.from({ length: 7 }, (_, i) => ({ id: `asset-${i}`, kind: 'file' as const }));
    const firstWave = gate();
    const finish = gate();
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    const progress: number[][] = [];
    const preparing = prepareExportResources(assets, new Set(assets.map(asset => asset.id)), async asset => {
        active++;
        peak = Math.max(peak, active);
        started.push(asset.id);
        if (started.length === 3) firstWave.release();
        if (asset.id === 'asset-0') await finish.promise;
        else await firstWave.promise;
        active--;
        return { bytes: Uint8Array.of(1) };
    }, undefined, (completed, total) => progress.push([completed, total]));
    await firstWave.promise;
    finish.release();
    const result = await preparing;
    assert.deepEqual(progress, Array.from({ length: 8 }, (_, completed) => [completed, 7]));
    assert.equal(peak, 3);
    assert.equal(started.length, 7);
    assert.deepEqual([...result.keys()], assets.map(asset => asset.id));
});
test('PDF keeps its complete document behind attachment completion', {timeout:5000}, async () => {
    seed('first', {assets:true});
    const started = gate();
    const finish = gate();
    const bodyReceipts: string[] = [];
    provider.acquireResource = async () => { started.release(); await finish.promise; return {bytes:Uint8Array.of(1)}; };
    const exporting = runExport(request({format:'pdf'}), {onBodyDelivered:value=>bodyReceipts.push(value.conversationId)});
    await started.promise;
    assert.equal(deliveries.length, 0);
    assert.deepEqual(bodyReceipts, []);
    assert.equal(state.pdfRenderKey, '');
    finish.release();
    assert.equal((await exporting).exported, 1);
    assert.deepEqual(bodyReceipts, ['first']);
    assert.equal(deliveries.length, 1);
});
test('one browser ZIP waits for its writer before any receipt or success record', {timeout:5000}, async () => {
    seed('first', {assets:true});
    const writerStarted = gate();
    const finish = gate();
    state.onPackage = async () => { writerStarted.release(); await finish.promise; };
    const receipts: string[] = [];
    const exporting = runExport(request(), {onBodyDelivered:value=>receipts.push(value.conversationId)});
    try {
        await writerStarted.promise;
        assert.equal(deliveries.length, 0);
        assert.deepEqual(receipts, []);
        assert.equal(records.size, 0);
    } finally { finish.release(); await exporting; }
    assert.equal(deliveries.length, 1);
    assert.deepEqual(receipts, ['first']);
    assert.equal(records.get(address(key()))?.status, 'ok');
});
for (const delivery of ['browserDownload','folderWriter'] as const) {
    test(`${delivery}: attachment delivery failure leaves the body delivered without claiming full success`, async () => {
        seed('first', {assets:true});
        records.set(address(key()), previous);
        state.failDelivery = delivery === 'folderWriter' ? 2 : 1;
        const delivered: string[] = [];
        const result = await runExport(request({delivery}), {onBodyDelivered:value=>delivered.push(value.conversationId)});
        assert.deepEqual(delivered, delivery === 'folderWriter' ? ['first'] : []);
        assert.equal(deliveries.length, delivery === 'folderWriter' ? 2 : 1);
        assert.equal(result.exported, 0);
        assert.deepEqual(result.failed, [key()]);
        assert.equal(records.get(address(key())), previous);
    });
}
test('cancelling after the complete browser ZIP delivery preserves the committed result', async () => {
    seed('first', {assets:true});
    const controller = new AbortController();
    const receipts: string[] = [];
    const result = await runExport(request(), {signal:controller.signal, onBodyDelivered:value=>{
        receipts.push(value.conversationId); controller.abort();
    }});
    assert.equal(result.aborted, true);
    assert.deepEqual(receipts, ['first']);
    assert.equal(deliveries.length, 1);
    assert.equal(result.exported, 1);
    assert.equal(records.size, 1);
});
test('cancellation drains in-flight attachments, saves prepared bodies and stops queued work', async () => {
    for (const id of ['first', 'second', 'third']) seed(id, { assets: true });
    const started = gate();
    const finish = gate();
    const controller = new AbortController();
    let acquisitions = 0;
    let active = 0;
    provider.acquireResource = async () => {
        acquisitions++;
        active++;
        if (active === 2) started.release();
        await finish.promise;
        assert.equal(state.releasedContexts, 0);
        assert.deepEqual(state.releasedKeys, []);
        active--;
        return { bytes: Uint8Array.of(1) };
    };
    const exporting = runExport(request({ keys: [key(), key('second'), key('third')] }), { signal: controller.signal });
    await started.promise;
    controller.abort();
    finish.release();
    const result = await exporting;
    assert.equal(result.aborted, true);
    assert.equal(acquisitions, 2);
    assert.equal(active, 0);
    assert.equal(state.releasedContexts, 1);
    assert.equal(deliveries.length, 1, 'prepared text is saved after acquisition stops');
    assert.equal(result.exported, 0, 'unfinished attachments do not produce a success record');
    assert.equal(records.size, 0);
});
test('resource preparation passes ConversationKey independently for identical asset IDs', async () => {
    seed('first', { assets: true }); seed('second', { assets: true });
    const acquisitions: string[] = [];
    provider.acquireResource = async (conversationKey, asset) => {
        acquisitions.push(conversationKey.conversationId + ':' + asset.id);
        return { bytes: new Uint8Array([9]) };
    };
    await runExport(request({ keys: [key(), key('second')], delivery: 'folderWriter' }));
    assert.deepEqual(acquisitions, ['first:image', 'first:file', 'second:image', 'second:file']);
    assert.equal(contexts.length, 1, 'one task-level L1 context, not one context per item');
    assert.equal(state.releasedContexts, 1);
    assert.deepEqual(state.releasedKeys, ['first', 'second']);
});
test('AST resource reference selection is delegated to L3b and forwarded by Application', async () => {
    seed('first', { assets: true });
    // The fake L3b returns a controlled set, not a traversed AST.
    const { references } = require('./helpers/applicationHarness.js') as typeof import('./helpers/applicationHarness.js');
    references.set('first', { referencedIds: ['file'], fileIds: ['file'], imageIds: [] });
    const result = await runExport(request({ format: 'markdown' }));
    assert.equal(result.exported, 1);
    assert.deepEqual(events.filter(event => event.startsWith('acquire:')), ['acquire:file']);
    assert.deepEqual(state.folderPlans[0].fileIds, ['file']);
    assert.deepEqual(Object.keys(state.rendererCalls[0].bindings), ['file']);
});
test('resource preparation retains failure results and propagates Abort', async () => {
    const controller = new AbortController();
    const prepared = await prepareExportResources([{ id: 'empty', kind: 'file' }], new Set(['empty', 'missing']),
        async () => ({ bytes: new Uint8Array() }));
    assert.equal(prepared.get('empty')?.ok, false); assert.equal(prepared.get('missing')?.ok, false);
    await assert.rejects(prepareExportResources([{ id: 'a', kind: 'file' }], new Set(['a']), async () => {
        controller.abort(); return { bytes: new Uint8Array([1]) };
    }, controller.signal), { name: 'AbortError' });
});
for (const delivery of ['browserDownload', 'folderWriter'] as const) {
    test(`${delivery} delivery failure affects only participating keys and preserves old records`, async () => {
        seed(); seed('second'); seed('skipped');
        records.set(address(key()), previous); records.set(address(key('skipped')), previous);
        state.failDelivery = 1;
        const result = await runExport(request({ keys: [key(), key('second'), key('skipped')], format: 'markdown', delivery,
            skipUnchanged: true }));
        assert.equal(result.skipped, 2); assert.equal(result.exported, 0);
        assert.deepEqual(result.failed, [key('second')]); assert.equal(records.get(address(key())), previous);
        assert.equal(events.some(event => event.startsWith('record:')), false);
    });
    test(`${delivery} cancellation after delivery finalizes only the delivered group`, async () => {
        seed(); seed('second');
        const controller = new AbortController(); state.onDelivery = () => controller.abort();
        const result = await runExport(request({ keys: [key(), key('second')], delivery, }), { signal: controller.signal });
        assert.equal(result.aborted, true); assert.equal(result.exported, delivery === 'browserDownload' ? 2 : 1); assert.deepEqual(result.failed, []);
    });
}
test('Browser with no attachments incrementally plans bodies and uses one document delivery', async () => {
    seed(); seed('second');
    const result = await runExport(request({ keys: [key(), key('second')] }));
    assert.equal(result.exported, 2);
    assert.deepEqual(state.folderPlans.map(plan => plan.key), ['first', 'second']);
    assert.equal(state.folderPlannerCreations.length, 1);
    assert.deepEqual(state.packages, [{ delivery: 'browserDownload', groups: 2, files: 2 }]);
    assert.deepEqual(events, ['delivery', 'record:first', 'record:second']);
    assert.equal(deliveries.length, 1);
});
test('L4 packaging failure prevents Browser delivery and does not overwrite previous Records', async () => {
    seed(); seed('second');
    records.set(address(key()), previous);
    state.failPackage = true;
    const result = await runExport(request({ keys: [key(), key('second')] }));
    assert.equal(result.exported, 0);
    assert.deepEqual(result.failed, [key(), key('second')]);
    assert.equal(deliveries.length, 0);
    assert.equal(records.get(address(key())), previous);
});
test('one L4 formatting failure does not block a different pending conversation', async () => {
    seed(); seed('second');
    state.failRender = 'markdown'; state.failRenderKey = 'first';
    const result = await runExport(request({ keys: [key(), key('second')] }));
    assert.deepEqual(result.failed, [key()]);
    assert.equal(result.exported, 1);
    assert.equal(deliveries.length, 1);
    assert.equal(state.packages[0].groups, 1);
    assert.equal(records.has(address(key('second'))), true);
});
test('Browser batch Record failure counts only committed records without a second delivery', async () => {
    seed(); seed('second'); state.failRecord = 'first';
    const result = await runExport(request({ keys: [key(), key('second')] }));
    assert.equal(result.exported, 1); assert.deepEqual(result.failed, [key()]); assert.equal(deliveries.length, 1);
});
test('Folder groups finalize independently; later failure preserves earlier records', async () => {
    seed(); seed('second'); state.failDelivery = 2;
    const result = await runExport(request({ keys: [key(), key('second')], delivery: 'folderWriter' }));
    assert.equal(result.exported, 1); assert.deepEqual(result.failed, [key('second')]);
    assert.deepEqual(events, ['delivery', 'record:first', 'delivery']);
});
test('Folder cancellation after first group stops later delivery and does not mark untouched keys failed', async () => {
    seed(); seed('second'); const controller = new AbortController(); state.onDelivery = () => controller.abort();
    const result = await runExport(request({ keys: [key(), key('second')], delivery: 'folderWriter' }), { signal: controller.signal });
    assert.equal(result.aborted, true); assert.equal(result.exported, 1); assert.deepEqual(result.failed, []); assert.equal(deliveries.length, 1);
});
test('cancel before final packaging delivers nothing and keeps old record', async () => {
    seed(); records.set(address(key()), previous); const controller = new AbortController();
    const result = await runExport(request(), { signal: controller.signal, onProgress() { controller.abort(); } });
    assert.equal(result.aborted, true); assert.equal(result.exported, 0); assert.deepEqual(result.failed, []);
    assert.equal(deliveries.length, 0); assert.equal(records.get(address(key())), previous);
});
test('missing Folder capability rejects initialization and never falls back to Browser Download', async () => {
    seed(); state.directory = null;
    await assert.rejects(runExport(request({ delivery: 'folderWriter' })), /directory unavailable/);
    assert.equal(deliveries.length, 0);
});
test('progress describes requested targets, not delivery completion; all-skipped does not produce ZIP', async () => {
    seed(); records.set(address(key()), previous);
    const progress: unknown[] = [];
    await runExport(request({ skipUnchanged: true }), { onProgress(value) { progress.push(value); } });
    assert.deepEqual(progress, [{ current: 1, total: 1, key: key() }]); assert.equal(deliveries.length, 0);
});
test('Storage read failure is reported, never treated as a missing snapshot followed by network refresh', async () => {
    state.failRead = true;
    const result = await runExport(request());
    assert.deepEqual(result.failed, [key()]); assert.deepEqual(events, []);
});

test('completed reply refreshes even matching cached versions and exports committed replacement', async () => {
    seed(); records.set(address(key()), previous);
    provider.fetchConversationDetail = async () => {
        events.push('refresh');
        const { detail } = seed();
        detail.messages[0].content = [{ type: 'paragraph', children: [{ type: 'text', text: 'New completed reply' }] }];
    };
    const result = await runExport(request({ skipUnchanged: true }), { refreshDetail: true });
    assert.equal(result.exported, 1); assert.equal(result.skipped, 0);
    assert.deepEqual(events, ['refresh', 'delivery', 'record:first']);
    assert.match(JSON.stringify(state.compositions[0]), /New completed reply/);
});
test('completed reply refresh failure cannot claim the cached matching version is current', async () => {
    seed();
    provider.fetchConversationDetail = async () => { throw new Error('offline'); };
    const result = await runExport(request(), { refreshDetail: true });
    assert.equal(result.exported, 1); assert.equal(result.partial, 1);
    assert.equal(records.get(address(key()))?.status, 'partial');
});

for (const cached of [true, false]) {
    test(`source HTTP failure retains its cause with ${cached ? 'a cached body' : 'no local body'}`, async () => {
        seed();
        if (!cached) details.delete(address(key()));
        provider.fetchConversationDetail = async () => { throw new OperationError('SOURCE_HTTP_ERROR', 'API request rejected', 403); };
        const diagnostics: ExportDiagnostic[] = [];
        const result = await runExport(request(), { refreshDetail: true, onDiagnostic: diagnostic => diagnostics.push(diagnostic) });
        const issues = diagnostics.filter(diagnostic => diagnostic.issue);
        assert.equal(issues.length, 1, 'one source failure must not also produce a missing-body symptom');
        assert.equal(issues[0].issue?.code, 'SOURCE_HTTP_ERROR');
        assert.equal(issues[0].issue?.httpStatus, 403);
        assert.equal(issues[0].severity, cached ? 'warning' : 'error');
        assert.equal(result.exported, cached ? 1 : 0);
        assert.equal(result.failed.length, cached ? 0 : 1);
    });
}


test('a fresh cached Detail rehydrates task-owned generated file bytes on each asset export', async () => {
    const { detail } = seed('first', { assets: true });
    delete detail.assets[1].sourceUri;
    await runExport(request());
    await runExport(request({ format: 'html' }));
    assert.equal(events.filter(event => event === 'refresh').length, 2);
});

test('metadata-only export does not reacquire inline file bytes', async () => {
    const { detail } = seed('first', { assets: true });
    delete detail.assets[1].sourceUri;
    await runExport(request({ includeAssets: false }));
    assert.equal(events.includes('refresh'), false);
});

for (const status of [401, 403, 404, 410]) {
    test(`cached resource HTTP ${status} refreshes once and exports the committed replacement identity`, async () => {
        seed('first', { assets: true });
        provider.acquireResource = async (_key, asset) => {
            events.push('acquire:' + asset.id);
            if (asset.id === 'image') throw new ResourceHttpError(status);
            return { bytes: new Uint8Array([4, 5, 6]) };
        };
        provider.fetchConversationDetail = async () => {
            events.push('refresh');
            const { detail } = seed('first', { assets: true });
            detail.assets[0].id = 'replacement';
            detail.assets[0].sourceUri = 'https://example.com/fresh.png';
            references.set('first', { referencedIds: ['replacement', 'file'], imageIds: ['replacement'], fileIds: ['file'] });
        };
        const result = await runExport(request());
        assert.equal(result.partial, 0);
        assert.equal(records.get(address(key()))?.status, 'ok');
        assert.equal(events.filter(event => event === 'refresh').length, 1);
        assert.ok(state.rendererCalls[0].bindings.image, 'initial document can be delivered immediately');
        assert.ok(state.rendererCalls.at(-1)?.bindings.replacement);
        assert.equal(state.rendererCalls.at(-1)?.bindings.image, undefined);
        assert.equal(state.builtFiles[0].plan.fileName, state.builtFiles.at(-1)?.plan.fileName, 'correction replaces the original document when packages are merged');
        assert.equal(deliveries.length, 1);
    });
}
test('persistent resource restriction stays partial after one refresh; server failures do not refresh', async () => {
    for (const status of [403, 500]) {
        reset(); seed('first', { assets: true });
        provider.acquireResource = async () => { throw new ResourceHttpError(status); };
        const result = await runExport(request());
        assert.equal(result.partial, 1);
        assert.equal(events.filter(event => event === 'refresh').length, status === 403 ? 1 : 0);
    }
});
for (const reason of ['offline', 'conversation_not_found', 'abort']) {
    test(`resource recovery refresh ${reason} preserves failure and cancellation semantics`, async () => {
        seed('first', { assets: true });
        provider.acquireResource = async () => { throw new ResourceHttpError(403); };
        provider.fetchConversationDetail = async () => {
            if (reason === 'abort') throw new DOMException('Aborted', 'AbortError');
            throw new Error(reason);
        };
        const result = await runExport(request());
        assert.equal(result.exported, reason === 'offline' ? 1 : 0);
        assert.equal(result.partial, reason === 'offline' ? 1 : 0);
        assert.equal(result.otherPartial ?? 0, 0);
        assert.equal(result.aborted, reason === 'abort');
        assert.equal(deliveries.length, reason === 'conversation_not_found' ? 0 : 1, 'only retained conversations enter the final package');
    });
}

test('successful resource recovery also resolves an earlier transient body refresh failure', async () => {
    seed('first', { assets: true, savedAt: 99 });
    let calls = 0;
    provider.fetchConversationDetail = async () => {
        if (++calls === 1) throw new Error('transient offline');
        seed('first', { assets: true });
    };
    provider.acquireResource = async () => {
        if (calls === 1) throw new ResourceHttpError(403);
        return { bytes: new Uint8Array([1]) };
    };
    const result = await runExport(request());
    assert.equal(calls, 2);
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
});


test('renewable provider resource locators export all formats without redundant body refreshes', async t => {
    const {detail}=seed('first',{assets:true});
    detail.assets[0].sourceUri='sediment://file-image';
    detail.assets[1].sourceUri='file-download:file-document';
    provider.canAcquireResourceDirectly=asset=>/^(sediment:\/\/|file-download:)/.test(asset.sourceUri??'');
    t.after(()=>{delete provider.canAcquireResourceDirectly;});
    provider.fetchConversationDetail=async()=>{events.push('refresh');throw new Error('429: unnecessary body refresh');};
    for(const format of ['markdown','html','json','pdf'] as const){
        const result=await runExport(request({format}));assert.equal(result.exported,1);assert.equal(result.partial,0);
    }
    assert.equal(events.includes('refresh'),false);
    assert.equal(events.filter(e=>e==='acquire:image').length,4,'each task still actually acquires the image');
});

test('workbench ZIP readers supply offline bytes without a source refresh and stay caller-owned', async () => {
    const { detail } = seed('first', { assets: true });
    for (const asset of detail.assets) asset.sourceUri = `sediment://${asset.id}`;
    const acquired: string[] = [];
    const importedResources: import('../src/l1/resources/sourceResources.js').SourceResourceContext = {
        retain() {}, retainParsed() {},
        has: (conversationKey, assetId) => conversationKey.accountId === account.id && ['image', 'file', 'unused'].includes(assetId),
        async acquire(_key, asset) { acquired.push(asset.id); return { bytes: Uint8Array.of(4, 5, 6) }; },
        release() { throw new Error('export must not release caller-owned ZIP readers'); },
        releaseConversation() { throw new Error('export must not release caller-owned ZIP readers'); },
    };
    const result = await runExport(request(), { importedResources });
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
    assert.equal(events.includes('refresh'), false);
    assert.deepEqual(acquired, ['image', 'file']);
    assert.equal(events.some(event => event.startsWith('acquire:')), false);
});


test('duplicate conversation keys wait for earlier readers and folder records before reacquisition', async () => {
    seed('first', { assets: true });
    let reads = 0;
    provider.fetchConversationDetail = async () => {
        if (reads++) {
            assert.deepEqual(state.releasedKeys, ['first']);
            assert.equal(records.has(address(key())), true);
        }
        seed('first', { assets: true });
    };
    const result = await runExport(request({ keys: [key(), key()], delivery: 'folderWriter' }), { refreshDetail: true });
    assert.equal(result.exported, 2);
    assert.equal(reads, 2);
    assert.deepEqual(state.releasedKeys, ['first', 'first']);
});

test('a worker AbortError drains siblings without starting remaining attachment downloads', async () => {
    const assets = Array.from({ length: 6 }, (_, i) => ({ id: `asset-${i}`, kind: 'file' as const }));
    const siblings = gate();
    const aborting = gate();
    const started: string[] = [];
    const preparing = prepareExportResources(assets, new Set(assets.map(asset => asset.id)), async asset => {
        started.push(asset.id);
        if (asset.id === 'asset-0') {
            aborting.release();
            throw new DOMException('Aborted', 'AbortError');
        }
        await siblings.promise;
        return { bytes: Uint8Array.of(1) };
    });
    const rejected = assert.rejects(preparing, { name: 'AbortError' });
    await aborting.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    siblings.release();
    await rejected;
    assert.deepEqual(started, ['asset-0', 'asset-1', 'asset-2']);
});


for (const code of ['RESOURCE_LOCATOR_UNAVAILABLE', 'RESOURCE_SOURCE_EXPIRED'] as const) {
    test(`${code} distinguishes a missing native download locator from an expired signed response`, async () => {
        seed('first', { assets: true });
        const acquisitions: string[] = [];
        provider.acquireResource = async (_key, asset) => {
            acquisitions.push(asset.id);
            if (asset.id === 'file') throw new OperationError(code, 'HTTP 404', 404);
            return { bytes: Uint8Array.of(1) };
        };
        const result = await runExport(request());
        assert.equal(result.exported, 1);
        assert.equal(result.partial, 1);
        assert.equal(result.aborted, false);
        const attempts = code === 'RESOURCE_LOCATOR_UNAVAILABLE' ? 1 : 2;
        assert.equal(events.filter(event => event === 'refresh').length, attempts - 1);
        assert.equal(acquisitions.filter(id => id === 'image').length, 1, 'successful attachments are never downloaded again');
        assert.equal(acquisitions.filter(id => id === 'file').length, attempts);
        assert.equal(records.get(address(key()))?.attachmentIssues?.[0].code, code);
        assert.equal(result.expiredConversations, 1);
        assert.equal(result.otherPartial, 0);
        acquisitions.length = 0;
        const repeated = await runExport(request({ skipUnchanged: true }));
        assert.equal(repeated.skipped, 1);
        assert.equal(repeated.exported, 0);
        assert.equal(acquisitions.length, 0, 'attachment 404 warnings do not trigger downloads on unchanged exports');
        const forced = await runExport(request({ skipUnchanged: false }));
        assert.equal(forced.exported, 1);
        assert.ok(acquisitions.includes('file'), 'disabling Skip permits retrying unavailable attachments');
    });
}


test('export counters track ready bodies and successful attachments across conversations and recovery', async () => {
    seed('first', { assets: true }); seed('second', { assets: true });
    const prepared: string[] = [];
    const downloads: number[] = [];
    let firstImage = true;
    provider.acquireResource = async (conversationKey, asset) => {
        if (conversationKey.conversationId === 'first' && asset.id === 'image' && firstImage) {
            firstImage = false;
            throw new ResourceHttpError(403);
        }
        return { bytes: Uint8Array.of(1) };
    };
    const result = await runExport(request({ keys: [key(), key('second')] }), {
        onConversationPrepared: value => prepared.push(value.conversationId),
        onResourceProgress: value => downloads.push(value.downloaded),
    });
    assert.equal(result.exported, 2);
    assert.equal(result.partial, 0);
    assert.deepEqual(prepared, ['first', 'second']);
    assert.equal(downloads[0], 0);
    assert.equal(downloads.at(-1), 4, 'equal asset IDs in different conversations count separately, retries count once');
    assert.ok(downloads.every((count, index) => index === 0 || count >= downloads[index - 1]));
    assert.equal(events.filter(event => event === 'refresh').length, 1);
});

test('skipped targets and failed resources do not inflate ready or downloaded counters', async () => {
    seed('first', { assets: true }); seed('second');
    records.set(address(key('second')), previous);
    const prepared: string[] = [];
    const downloads: number[] = [];
    provider.acquireResource = async (_key, asset) => {
        if (asset.id === 'image') throw new ResourceHttpError(500);
        return { bytes: Uint8Array.of(1) };
    };
    const result = await runExport(request({ keys: [key(), key('second')], skipUnchanged: true }), {
        onConversationPrepared: value => prepared.push(value.conversationId),
        onResourceProgress: value => downloads.push(value.downloaded),
    });
    assert.equal(result.skipped, 1);
    assert.equal(result.partial, 1);
    assert.deepEqual(prepared, ['first']);
    assert.equal(downloads.at(-1), 1);
});

for (const format of ['markdown', 'html', 'json'] as const) {
    test(`${format}: folder reuses existing attachments before acquisition and preserves bindings on partial failure`, async () => {
        seed('first', { assets: true });
        state.existingFiles.add('mock/image');
        provider.acquireResource = async (_key, asset) => {
            events.push('acquire:' + asset.id);
            throw new Error('Source unavailable');
        };
        const result = await runExport(request({ format, delivery: 'folderWriter' }));
        assert.equal(result.exported, 1);
        assert.equal(result.partial, 1);
        assert.ok(!events.includes('acquire:image'));
        assert.equal(state.rendererCalls.at(-1)?.bindings.image, 'mock/image');
        assert.ok(!records.get(address(key()))?.attachmentIssues?.some(issue => issue.resourceId === 'image'));
    });
}

test('Folder preflight overlaps independent attachment lookups before acquiring missing bytes', async () => {
    seed('first', { assets: true });
    let active = 0;
    let maximum = 0;
    const probed: string[] = [];
    Object.defineProperty(state.existingFiles, 'has', { value: async (path: string) => {
        probed.push(path);
        active++;
        maximum = Math.max(maximum, active);
        await new Promise<void>(resolve => setImmediate(resolve));
        active--;
        return path === 'mock/image';
    } });
    const result = await runExport(request({ format: 'json', delivery: 'folderWriter' }));
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
    assert.equal(maximum, 3, 'independent path existence checks should overlap');
    assert.deepEqual(probed, ['mock/image', 'mock/file', 'mock/unused']);
    assert.deepEqual(events.filter(event => event.startsWith('acquire:')), ['acquire:file', 'acquire:unused']);
});
