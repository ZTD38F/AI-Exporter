import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertUiNodeIsolation, installUiV2Mocks } from './helpers/uiV2Mocks.js';

// Stub external owners before loading any UI module (including its transitive imports).
installUiV2Mocks();
const { ConversationViewState } = require('../src/ui/options/state/conversationsStore.js') as
    typeof import('../src/ui/options/state/conversationsStore.js');
const { startSync } = require('../src/ui/options/controllers/syncController.js') as
    typeof import('../src/ui/options/controllers/syncController.js');
const { handleTakeoutImport } = require('../src/ui/options/controllers/takeoutController.js') as
    typeof import('../src/ui/options/controllers/takeoutController.js');
const { bindDelayedActions } = require('../src/ui/guidance/tourSteps.js') as
    typeof import('../src/ui/guidance/tourSteps.js');
const { getLatestEligibleFeature } = require('../src/ui/guidance/featureReleases.js') as
    typeof import('../src/ui/guidance/featureReleases.js');
assertUiNodeIsolation();

const A = { id: '11111111-1111-4111-8111-111111111111', providerId: 'gemini', providerAccountId: 'A' };
const B = { ...A, id: '22222222-2222-4222-8222-222222222222', providerAccountId: 'B' };
const row = (accountId: string, conversationId: string) => ({ key: { accountId, conversationId }, title: '<unsafe>', updatedAt: 20 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
test('UI: single account, explicit selection, record-only filters and visible selection', async () => {
    const state = new ConversationViewState({ listAccounts: async () => [A],
        listIndexes: async () => [row(A.id, 'one'), row(A.id, 'two')],
        listExportRecords: async () => ({ one: { status: 'partial', format: 'pdf', exportedAt: 1 } }) });
    await state.refresh(); assert.equal(state.accountId, A.id); assert.equal(state.selected.size, 0);
    state.filter = 'has_record'; assert.deepEqual(state.visible().map(row => row.key.conversationId), ['one']);
    state.selectVisible(); assert.deepEqual(state.keys(), [{ accountId: A.id, conversationId: 'one' }]);
    state.filter = 'no_record'; assert.deepEqual(state.visible().map(row => row.key.conversationId), ['two']);
    state.selectAccount(B.id); assert.equal(state.selected.size, 0); assert.equal(state.indexes.length, 0);
});
test('UI: Select All replaces previously selected hidden rows', async () => {
    const state = new ConversationViewState({ listAccounts: async () => [A],
        listIndexes: async () => [row(A.id, 'one'), row(A.id, 'two')],
        listExportRecords: async () => ({ one: { status: 'partial', format: 'pdf', exportedAt: 1 } }) });
    await state.refresh();
    state.selected.add('one');
    state.filter = 'no_record';
    state.selectVisible();
    assert.deepEqual(state.keys(), [{ accountId: A.id, conversationId: 'two' }]);
});
test('UI: delayed account A read cannot replace account B', async () => {
    const old = deferred<ReturnType<typeof row>[]>();
    const state = new ConversationViewState({ listAccounts: async () => [A, B],
        listIndexes: id => id === A.id ? old.promise : Promise.resolve([]), listExportRecords: async () => ({}) });
    state.selectAccount(A.id); const first = state.refresh(); await new Promise(resolve => setImmediate(resolve));
    state.selected.add('one'); state.selectAccount(B.id); await state.refresh();
    old.resolve([row(A.id, 'one')]); await first;
    assert.equal(state.accountId, B.id); assert.deepEqual(state.indexes, []); assert.equal(state.keys().length, 0);
});
test('UI: zero accounts stays empty and never creates an account while browsing', async () => {
    const state = new ConversationViewState({ listAccounts: async () => [], listIndexes: async () => { throw Error('unexpected'); }, listExportRecords: async () => { throw Error('unexpected'); } });
    await state.refresh(); assert.equal(state.accountId, null); assert.deepEqual(state.indexes, []);
});
test('UI: Scan resolves real source, switches view, and forwards committed progress and forceFull', async () => {
    const events: unknown[] = []; const controller = new AbortController();
    const result = await startSync(B.id, { signal: controller.signal, forceFull: true,
        onTarget: async id => { events.push(['view', id]); }, onProgress: progress => events.push(progress) }, {
        resolveScanTarget: async hint => { assert.equal(hint, B.id); return A.id; },
        scanAll: async (request, options) => { events.push(request); assert.equal(options?.signal, controller.signal);
            options?.onProgress?.({ pagesFetched: 2, conversationsFetched: 151 });
            return { status: 'partial_limit', reason: 'max_pages', pagesFetched: 2, conversationsFetched: 151 }; }
    });
    assert.deepEqual(events, [['view', A.id], { accountId: A.id, forceFull: true }, { pagesFetched: 2, conversationsFetched: 151 }]);
    assert.equal(result.reason, 'max_pages');
});
test('UI: cancelling while source resolution is pending never starts Scan', async () => {
    const source = deferred<string>(); const controller = new AbortController();
    let called = false;
    const operation = startSync(undefined, { signal: controller.signal, onTarget: async () => { called = true; } }, {
        resolveScanTarget: () => source.promise, scanAll: async () => { called = true; throw Error('unexpected'); }
    });
    controller.abort(); source.resolve(A.id); await assert.rejects(operation, { name: 'AbortError' }); assert.equal(called, false);
});
test('UI: Takeout uses selected account and marks the prompt before an import failure', async () => {
    const events: unknown[] = [];
    await assert.rejects(handleTakeoutImport({} as File, B.id, { onTarget: async id => { events.push(id); } }, {
        listAccounts: async () => [A, B], getAccount: async id => id === B.id ? B : A,
        getOrCreateAccount: async () => { throw Error('unexpected'); },
        updateSettings: async patch => { events.push(patch); },
        importTakeout: async (_file, id) => { events.push(['import', id]); throw Error('bad zip'); }
    }), /bad zip/);
    assert.deepEqual(events, [B.id, { takeoutPromptCompleted: true }, ['import', B.id]]);
});
test('UI: first selected ZIP creates default only when all local accounts are absent', async () => {
    let created = 0;
    const result = await handleTakeoutImport({} as File, null, { onTarget: async id => assert.equal(id, A.id) }, {
        listAccounts: async () => [], getAccount: async () => null,
        getOrCreateAccount: async (provider, subject) => { assert.equal(provider, 'gemini'); assert.equal(subject, 'default'); created++; return A; },
        updateSettings: async () => {}, importTakeout: async () => ({ imported: 0, status: 'partial' as const })
    });
    assert.equal(created, 1); assert.equal(result.imported, 0); assert.equal(result.status, 'partial');
});
test('UI: foreign Provider Takeout target is rejected without prompt writes or default creation', async () => {
    await assert.rejects(handleTakeoutImport({} as File, B.id, { onTarget: async () => { throw Error('unexpected'); } }, {
        listAccounts: async () => [B], getAccount: async () => ({ ...B, providerId: 'chatgpt' }),
        getOrCreateAccount: async () => { throw Error('unexpected'); }, updateSettings: async () => { throw Error('unexpected'); }, importTakeout: async () => { throw Error('unexpected'); }
    }), /Select a Gemini account/);
});
test('UI: leaving a Tour step cancels its delayed advancement and listener', async () => {
    const target = new EventTarget(); let advanced = 0;
    const cleanup = bindDelayedActions([[target, 'click']], () => advanced++, 20);
    target.dispatchEvent(new Event('click')); cleanup(); await new Promise(resolve => setTimeout(resolve, 40));
    target.dispatchEvent(new Event('click')); await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(advanced, 0);
});
test('UI: a step can schedule advancement only once', async () => {
    const target = new EventTarget(); let advanced = 0;
    const cleanup = bindDelayedActions([[target, 'click']], () => advanced++, 5);
    target.dispatchEvent(new Event('click')); target.dispatchEvent(new Event('click'));
    await new Promise(resolve => setTimeout(resolve, 15)); cleanup(); assert.equal(advanced, 1);
});
test('UI: missing or unusable Spotlight baseline does not replay announcements', () => {
    for (const value of ['', 'invalid', '1.0']) assert.equal(getLatestEligibleFeature(value, '1.8.1'), null);
    assert.equal(getLatestEligibleFeature('1.5.0', '1.8.1'), null);
});
