import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { accountRuntime, ACCOUNT_UUID, ACCOUNT_OBSERVATION } from './helpers/accountRuntime.js';
import { init, handleWindowMessage } from '../src/l1/sniffer/gemini/messageBridge.js';
import { runCleanups } from '../src/runtime/content/cleanupRegistry.js';
import { getDetail } from '../src/l3a/storageService.js';
import { extractConversationIdFromUrl } from '../src/shared/utils/pathUtils.js';
import { resolveCurrentAccount } from '../src/runtime/content/accountContext.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';

// The old DOM/debounce LiveSaveObserver is retired. Actual passive admissions
// commit Detail; stream completion requests Application acquisition without inventing DOM Detail.
async function host(t: import('node:test').TestContext) {
    const storage = indexStorage(), runtime = accountRuntime();
    await resolveCurrentAccount(ACCOUNT_OBSERVATION, 'u0');
    const changed: string[] = [], completed: string[] = [];
    init({ onDetailChanged: key => changed.push(key.conversationId), onStreamComplete: key => completed.push(key.conversationId) });
    t.after(() => { runCleanups(); runtime.restore(); storage.restore(); });
    const event = (type: string, extra: Record<string, unknown> = {}) => ({ source: window, origin: location.origin,
        data: { type, payload: { id: 'passive123', slot: 'u0', requestAccountObservation: ACCOUNT_OBSERVATION, ...extra } } }) as unknown as MessageEvent;
    return { changed, completed, event };
}
test('active conversation extraction supports account routes and excludes reserved pages', () => {
    assert.equal(extractConversationIdFromUrl('/app/82a15f0bc2e'), '82a15f0bc2e');
    assert.equal(extractConversationIdFromUrl('/u/1/app/999abcdef'), '999abcdef');
    assert.equal(extractConversationIdFromUrl('/app'), null);
    assert.equal(extractConversationIdFromUrl('/app/trash'), null);
});
test('stream lifecycle notifications do not save unfinished or uncommitted DOM content', async t => {
    const h = await host(t);
    await handleWindowMessage(h.event('GEMINI_STREAM_GENERATE_START'));
    await handleWindowMessage(h.event('GEMINI_STREAM_GENERATE_COMPLETE'));
    assert.deepEqual(h.changed, []);
    assert.deepEqual(h.completed, ['passive123']);
    assert.equal(await getDetail({ accountId: ACCOUNT_UUID, conversationId: 'passive123' }), null);
});
test('a real completed passive Detail triggers after storage commit and duplicate captures do not retrigger', async t => {
    const h = await host(t);
    const text = geminiDetailGen('G_LIVE_SAVE_OBSERVER_01');
    const event = h.event('GEMINI_NETWORK_BATCHEXECUTE', { text, requestedAt: 1700000000000, truncated: false,
        url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute', detailRequest: { conversationId: 'passive123', requestCursor: null } });
    await handleWindowMessage(event);
    assert.equal((await getDetail({ accountId: ACCOUNT_UUID, conversationId: 'passive123' }))?.quality.status, 'complete');
    assert.deepEqual(h.changed, ['passive123']);
    await handleWindowMessage(event);
    assert.deepEqual(h.changed, ['passive123']);
});
test('foreign origin and foreign window notifications cannot trigger completion', async t => {
    const h = await host(t);
    await handleWindowMessage({ ...h.event('GEMINI_STREAM_GENERATE_COMPLETE'), origin: 'https://evil.test' } as MessageEvent);
    await handleWindowMessage({ ...h.event('GEMINI_STREAM_GENERATE_COMPLETE'), source: {} } as MessageEvent);
    assert.deepEqual(h.completed, []); assert.deepEqual(h.changed, []);
});
test('cleanup removes passive dispatch and reinitialization installs one current listener', async t => {
    const h = await host(t);
    runCleanups();
    await handleWindowMessage(h.event('GEMINI_STREAM_GENERATE_COMPLETE'));
    assert.deepEqual(h.completed, []);
    init({ onStreamComplete: key => h.completed.push(key.conversationId) });
    await handleWindowMessage(h.event('GEMINI_STREAM_GENERATE_COMPLETE'));
    assert.deepEqual(h.completed, ['passive123']);
});
