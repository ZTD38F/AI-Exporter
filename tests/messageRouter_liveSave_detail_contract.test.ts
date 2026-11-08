import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { accountRuntime, ACCOUNT_UUID, OTHER_ACCOUNT_UUID, ACCOUNT_OBSERVATION } from './helpers/accountRuntime.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { sourceDetail, sourceList } from './helpers/l1SourceFixture.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { ConfirmedGeminiConversationNotFound } from '../src/l1/client/gemini/geminiClient.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { getDetail, getIndex, getExportRecord, putExportRecord } from '../src/l3a/storageService.js';
import { init as initBridge, handleWindowMessage } from '../src/l1/sniffer/gemini/messageBridge.js';
import { CrossWorldEvents } from '../src/l1/protocol/gemini/protocol.js';
import { init as initLive, cleanup as cleanupLive, executeLiveSave } from '../src/runtime/content/liveSaveCoordinator.js';
import { init as initRouter } from '../src/runtime/content/messageRouter.js';
import { resolveCurrentAccount } from '../src/runtime/content/accountContext.js';
import { runCleanups } from '../src/runtime/content/cleanupRegistry.js';
import { AssetFetcher } from '../src/runtime/capabilities/assetFetcher.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';

// The v1 getConversationDetail router, DOM fallback and Live Save detail resolver
// are gone. Detail belongs to L1 -> L2; only committed passive changes request
// the unified Export through Content -> Background IPC.
const account = fixtureAccount();
const sourceClient = (getDetailFromSource: () => ReturnType<typeof sourceDetail> | Promise<ReturnType<typeof sourceDetail>>) => ({
    getConversationList: async () => sourceList('G_SOURCE_EMPTY_01'),
    getConversationDetail: async () => getDetailFromSource(),
});
const route = async () => 'u0';
const paragraph = (text: string) => ({ type: 'paragraph' as const, children: [{ type: 'text' as const, text }] });

test('v2 detail: L1 commits title, model, reasoning, citations and asset references to L2 without transport evidence', async () => {
    const environment = indexStorage();
    try {
        const parsed = sourceDetail({ id: 'detail123', title: 'Research', updatedAt: 1700000000000 });
        parsed.conversation.detail.quality = { status: 'complete' };
        parsed.conversation.detail.assets = [
            { id: 'generated-image', kind: 'image', name: 'generated.png', sourceUri: 'https://lh3.googleusercontent.com/image' },
        ];
        parsed.conversation.detail.messages = [{
            id: 'answer', role: 'assistant', model: 'Model', timestamp: 1700000000000,
            content: [
                { type: 'paragraph', children: [{ type: 'text', text: 'Research answer' }, { type: 'citationRef', citationId: 'cite' }] },
                { type: 'image', assetId: 'generated-image' },
            ],
            reasoning: [paragraph('thought')],
            citations: [{ id: 'cite', title: 'Citation', url: 'https://example.com/source' }],
            attachmentIds: ['generated-image'],
        }];
        parsed.transport.decodedPayload = { wire: ['raw-only-evidence'] };
        const expected = structuredClone(parsed.conversation.detail);
        const provider = new GeminiProvider({
            getConversationList: async () => sourceList('G_SOURCE_EMPTY_01'),
            getConversationDetail: async (id, slot, owner) => {
                assert.equal(id, 'detail123');
                assert.equal(slot, 'u0');
                assert.equal(owner?.id, account.id);
                return parsed;
            },
        }, route);

        assert.equal(await provider.fetchConversationDetail(account.id, 'detail123'), undefined);
        const key = { accountId: account.id, conversationId: 'detail123' };
        const committed = await getDetail(key);
        assert.ok(committed);
        assert.deepEqual(committed.messages, expected.messages);
        assert.deepEqual(committed.assets, expected.assets);
        assert.deepEqual(committed.quality, expected.quality);
        assert.equal(committed.savedAt, 1700000000000);
        assert.equal((await getIndex(key))?.title, 'Research');
        assert.equal((await getIndex(key))?.titleSource, 'provider');
        assert.equal((await getIndex(key))?.updatedAt, 1700000000000);
        assert.equal(Object.hasOwn(committed, 'transport'), false, 'raw RPC/debug payload is not trusted Domain');
        assert.equal(JSON.stringify(committed).includes('raw-only-evidence'), false);
    } finally {
        environment.restore();
    }
});

test('v2 detail: unknown source times remain absent instead of inventing chatTime or savedAt', async () => {
    const environment = indexStorage();
    try {
        const parsed = sourceDetail({ id: 'no_time', updatedAt: null });
        const provider = new GeminiProvider(sourceClient(() => parsed), route);
        await provider.fetchConversationDetail(account.id, 'no_time');
        const key = { accountId: account.id, conversationId: 'no_time' };
        const stored = await getDetail(key);
        const index = await getIndex(key);
        assert.ok(stored && index);
        assert.equal(Object.hasOwn(stored, 'savedAt'), false);
        assert.equal(Object.hasOwn(stored, 'chatTime'), false);
        assert.equal(Object.hasOwn(index, 'updatedAt'), false);
        assert.equal(Object.hasOwn(index, 'createdAt'), false);
    } finally {
        environment.restore();
    }
});

test('v2 detail: transient/ambiguous failures leave local data intact; confirmed Not Found deletes only the matching key', async () => {
    const environment = indexStorage();
    try {
        const id = 'deadbeef00112233';
        const key = { accountId: account.id, conversationId: id };
        const otherKey = { accountId: OTHER_ACCOUNT_UUID, conversationId: id };
        const body = { quality: { status: 'complete' as const }, assets: [], messages: [
            { role: 'assistant' as const, content: [paragraph('Previously saved answer')] },
        ] };
        await ingestDetail(key.accountId, id, body, { title: 'Previously saved', titleSource: 'provider' });
        await ingestDetail(otherKey.accountId, id, body, { title: 'Other account', titleSource: 'provider' });
        await putExportRecord(key, { exportedAt: 1700000000000, format: 'markdown', status: 'ok' });
        const oldDetail = await getDetail(key);
        const oldRecord = await getExportRecord(key);

        let failure: Error = new Error('temporary failure');
        const provider = new GeminiProvider({
            getConversationList: async () => sourceList('G_SOURCE_EMPTY_01'),
            getConversationDetail: async () => { throw failure; },
        }, route);
        for (const error of [new Error('temporary failure'), new Error('HTTP 404'),
            new ConfirmedGeminiConversationNotFound('c_different_conversation')]) {
            failure = error;
            await assert.rejects(provider.fetchConversationDetail(account.id, id));
            assert.deepEqual(await getDetail(key), oldDetail);
            assert.deepEqual(await getExportRecord(key), oldRecord);
        }

        failure = new ConfirmedGeminiConversationNotFound('c_' + id);
        await assert.rejects(provider.fetchConversationDetail(account.id, id), /conversation_not_found/);
        assert.equal(await getDetail(key), null);
        assert.equal(await getIndex(key), null);
        assert.equal(await getExportRecord(key), null);
        assert.ok(await getDetail(otherKey), 'another Account must not be deleted');
    } finally {
        environment.restore();
    }
});

test('v2 Live Save: only a committed, changed passive Detail requests a single keyed export', async () => {
    const environment = indexStorage();
    const runtime = accountRuntime();
    const forward = chrome.runtime.sendMessage.bind(chrome.runtime);
    const sent: unknown[] = [];
    const feedback: string[] = [];
    const jobs: Array<Promise<unknown>> = [];
    try {
        await resolveCurrentAccount(ACCOUNT_OBSERVATION, 'u0');
        chrome.runtime.sendMessage = (async (message: { action: string; key?: unknown }) => {
            if (message.action === 'runLiveSave') {
                sent.push(message);
                return { ok: true, result: { exported: 1, skipped: 0, partial: 0, failed: [], aborted: false } };
            }
            return forward(message);
        }) as typeof chrome.runtime.sendMessage;
        initLive({ badge: { showLiveSaveResult: (_result, accountId) => { feedback.push(accountId); } } });
        initBridge({ onDetailChanged: key => { jobs.push(executeLiveSave(key)); } });

        const id = 'source_sniff_123';
        const key = { accountId: ACCOUNT_UUID, conversationId: id };
        const wire = geminiDetailGen('G_MESSAGE_ROUTER_LIVE_SAVE_01');
        const captured = (extra: Record<string, unknown> = {}): MessageEvent => ({
            source: window, origin: location.origin, data: {
                type: CrossWorldEvents.NETWORK_BATCHEXECUTE,
                payload: {
                    text: wire, slot: 'u0', requestedAt: 1700000000000, truncated: false,
                    url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute',
                    requestAccountObservation: ACCOUNT_OBSERVATION,
                    detailRequest: { conversationId: id, requestCursor: null }, ...extra,
                },
            },
        }) as unknown as MessageEvent;
        const admit = async (extra: Record<string, unknown> = {}) => {
            await handleWindowMessage(captured(extra));
            await Promise.all(jobs.splice(0));
        };

        await admit();
        const initial = await getDetail(key);
        assert.ok(initial);
        assert.equal(initial.quality.status, 'complete');
        assert.deepEqual(sent, [{ action: 'runLiveSave', key }]);
        assert.deepEqual(feedback, [ACCOUNT_UUID]);

        await admit(); // A duplicate candidate is accepted but not changed.
        await admit({ truncated: true }); // A partial candidate cannot replace complete Detail.
        assert.deepEqual(await getDetail(key), initial);
        assert.equal(sent.length, 1, 'no second Export for unchanged or rejected Detail');
    } finally {
        runCleanups();
        cleanupLive();
        runtime.restore();
        environment.restore();
    }
});

test('v2 Live Save: a changed Account prevents dispatch and suppresses late badge feedback', async () => {
    const runtime = accountRuntime();
    const forward = chrome.runtime.sendMessage.bind(chrome.runtime);
    const key = { accountId: ACCOUNT_UUID, conversationId: 'detail123' };
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const feedback: string[] = [];
    let dispatched = 0;
    try {
        await resolveCurrentAccount(ACCOUNT_OBSERVATION, 'u0');
        chrome.runtime.sendMessage = (async (message: { action: string }) => {
            if (message.action === 'runLiveSave') {
                dispatched++;
                await pending;
                return { ok: true, result: { exported: 1, skipped: 0, partial: 0, failed: [], aborted: false } };
            }
            return forward(message);
        }) as typeof chrome.runtime.sendMessage;
        initLive({ badge: { showLiveSaveResult: (_result, id) => { feedback.push(id); } } });
        const inFlight = executeLiveSave(key);
        assert.equal(dispatched, 1);
        runtime.state.observation = { providerId: 'gemini', providerAccountId: 'other-gaia' };
        await resolveCurrentAccount(runtime.state.observation, 'u0');
        release();
        await inFlight;
        assert.deepEqual(feedback, []);
        assert.equal(await executeLiveSave(key), null);
        assert.equal(dispatched, 1);
    } finally {
        release();
        cleanupLive();
        runtime.restore();
    }
});

test('v2 messageRouter: resource IPC rejects foreign Accounts/hosts and never leaks bytes across an Account switch', async () => {
    const runtime = accountRuntime();
    const originalFetch = AssetFetcher.handleGetFileBlob;
    type Listener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];
    let listener: Listener | undefined;
    let downloads = 0;
    try {
        await resolveCurrentAccount(ACCOUNT_OBSERVATION, 'u0');
        Object.assign(chrome.runtime, {
            id: 'own-extension',
            onMessage: {
                addListener(fn: Listener) { listener = fn; },
                removeListener() {},
            },
        });
        AssetFetcher.handleGetFileBlob = async (_message, reply) => {
            downloads++;
            runtime.state.observation = { providerId: 'gemini', providerAccountId: 'other-gaia' };
            reply({ success: true, dataBase64: 'AQID', size: 3 });
        };
        initRouter();
        assert.ok(listener);
        const request = (message: unknown) => new Promise<Record<string, unknown>>(resolve => {
            const handled = listener!(message, { id: 'own-extension' } as chrome.runtime.MessageSender,
                response => resolve(response as Record<string, unknown>));
            assert.equal(handled, true);
        });
        const url = 'https://lh3.googleusercontent.com/asset';
        assert.equal((await request({ action: 'getFileBlob', accountId: OTHER_ACCOUNT_UUID, url })).success, false);
        assert.equal((await request({ action: 'getFileBlob', accountId: ACCOUNT_UUID, url: 'https://evil.example/a' })).success, false);
        assert.equal(downloads, 0);
        const switched = await request({ action: 'getFileBlob', accountId: ACCOUNT_UUID, url });
        assert.equal(switched.success, false);
        assert.match(String(switched.error), /Account changed/);
        assert.equal(Object.hasOwn(switched, 'dataBase64'), false);
        assert.equal(downloads, 1);
    } finally {
        runCleanups();
        AssetFetcher.handleGetFileBlob = originalFetch;
        runtime.restore();
    }
});
