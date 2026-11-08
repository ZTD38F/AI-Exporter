import { createHookSandbox } from './helpers/hookSandbox.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBObjectStore } from 'fake-indexeddb';
import { indexStorage } from './helpers/indexStorage.js';
import { accountRuntime, ACCOUNT_UUID, ACCOUNT_OBSERVATION, OTHER_ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { ingestDetail, ingestIndexes } from '../src/l2/ingestion.js';
import { getDetail, getIndex, getCoverage, getExportRecord, putExportRecord, putAccount, updateCoverageAtomically } from '../src/l3a/storageService.js';
import { clearLocalScanRecords } from '../src/application/localCleanup.js';
import { handleDomainIngestionMessage } from '../src/runtime/background/domainStorageHandler.js';
import { init, handleWindowMessage } from '../src/l1/sniffer/gemini/messageBridge.js';
import { CrossWorldEvents } from '../src/l1/protocol/gemini/protocol.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { deleteGen as geminiDeleteGen } from './fixtures/providers/geminiDelete.js';
import { deleteRequestGen as geminiDeleteRequestGen } from './fixtures/providers/geminiDeleteRequest.js';
import { closeDomainResources } from '../src/l1/parsers/shared/resources/domainResourceAdapter.js';
import type { DomainConversationDetail } from '../src/l2/conversationDetail.js';

const cid = 'deadbeef00112233';
const body = (): Omit<DomainConversationDetail, 'key'> => ({ messages: [], assets: [], quality: { status: 'complete' } });
const key = (accountId = ACCOUNT_UUID) => ({ accountId, conversationId: cid });
const requestBody = geminiDeleteRequestGen('G_FROZEN_CONTRACT_DELETE_REQUEST_01');
const responseText = geminiDeleteGen('G_FROZEN_CONTRACT_DELETE_RESPONSE_01');
const deletion = (extra = {}): MessageEvent => ({ origin: location.origin, source: window,
    data: { type: CrossWorldEvents.CONVERSATION_DELETED, payload: { id: cid, slot: 'u0',
        requestAccountObservation: ACCOUNT_OBSERVATION, requestBody, responseText,
        url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute', ...extra } } }) as unknown as MessageEvent;

async function seed() {
    for (const accountId of [ACCOUNT_UUID, OTHER_ACCOUNT_UUID]) {
        await ingestDetail(accountId, cid, body());
        await putExportRecord(key(accountId), { exportedAt: 1, format: 'markdown', status: 'ok' });
    }
}

test('passive deletion commits Bridge → Runtime IPC → Background → L2 before notifying UI', async () => {
    const storage = indexStorage({ gemini_exporter_v2_initialized: true }), runtime = accountRuntime();
    const send = chrome.runtime.sendMessage;
    try {
        await putAccount({ id: ACCOUNT_UUID, ...ACCOUNT_OBSERVATION });
        await seed();
        Object.assign(chrome.runtime, { id: 'own-extension' });
        chrome.runtime.sendMessage = (async (message: unknown) => {
            if (message && typeof message === 'object' && 'action' in message && message.action === 'domainIngest') {
                return new Promise<unknown>(resolve => assert.equal(handleDomainIngestionMessage(message, {
                    id: 'own-extension', tab: { id: 1 } as chrome.tabs.Tab, frameId: 0,
                    url: 'https://gemini.google.com/app'
                }, resolve), true));
            }
            return Reflect.apply(send, chrome.runtime, [message]);
        }) as typeof chrome.runtime.sendMessage;
        let notified = false;
        init({ onConversationDeleted: () => { notified = true; } });
        await handleWindowMessage(deletion({ responseText: geminiDeleteGen('G_REGRESSION_EMPTY_DELETE_RESPONSE_01') }));
        await handleWindowMessage(deletion({ responseText: geminiDeleteGen('G_FROZEN_CONTRACT_DELETE_RESPONSE_02') }));
        await handleWindowMessage(deletion({ requestAccountObservation: null }));
        assert.ok(await getDetail(key()));
        assert.equal(notified, false);
        const hook = createHookSandbox(); hook.win.__nextResponseText = responseText;
        await hook.win.fetch('https://gemini.google.com/_/BardChatUi/data/batchexecute', { method: 'POST', body: requestBody });
        await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
        const captured = hook.posted.find(item => item.msg.type === CrossWorldEvents.CONVERSATION_DELETED);
        assert.ok(captured);
        runtime.state.observation = { providerId: 'gemini', providerAccountId: 'other-gaia' };
        await handleWindowMessage({ origin: location.origin, source: window, data: captured.msg } as unknown as MessageEvent);
        assert.equal(notified, true);
        assert.equal(await getIndex(key()), null);
        assert.equal(await getDetail(key()), null);
        assert.equal(await getExportRecord(key()), null);
        assert.ok(await getDetail(key(OTHER_ACCOUNT_UUID)));
        assert.ok(await getExportRecord(key(OTHER_ACCOUNT_UUID)));
    } finally { runtime.restore(); storage.restore(); }
});

test('confirmed deletion waits for an earlier capture to settle even when that admission fails', async () => {
    const storage = indexStorage(), runtime = accountRuntime();
    const send = chrome.runtime.sendMessage;
    let release!: () => void, started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    try {
        await seed();
        chrome.runtime.sendMessage = (async (message: Record<string, unknown>) => {
            if (message.action === 'domainIngest' && message.operation === 'indexes') {
                started(); await blocked; throw new Error('earlier capture failed');
            }
            return Reflect.apply(send, chrome.runtime, [message]);
        }) as typeof chrome.runtime.sendMessage;
        let notified = false;
        init({ onConversationDeleted: () => { notified = true; } });
        const earlier = handleWindowMessage({ origin: location.origin, source: window, data: {
            type: CrossWorldEvents.NETWORK_BATCHEXECUTE,
            payload: { slot: 'u0', requestAccountObservation: ACCOUNT_OBSERVATION,
                url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute',
                text: geminiListGen('G_FROZEN_CONTRACT_LIST_01'),
                requestedAt: 100, truncated: false }
        } } as unknown as MessageEvent);
        const failedCapture = assert.rejects(earlier, /earlier capture failed/);
        await entered;
        const removed = handleWindowMessage(deletion());
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(notified, false);
        assert.ok(await getDetail(key()));
        release(); await failedCapture; await removed;
        assert.equal(notified, true);
        assert.equal(await getIndex(key()), null);
        assert.equal(await getDetail(key()), null);
        assert.equal(await getExportRecord(key()), null);
    } finally { release(); runtime.restore(); storage.restore(); }
});

test('failed passive deletion keeps all local facts and emits no committed callback', async () => {
    const storage = indexStorage(), runtime = accountRuntime(), originalDelete = IDBObjectStore.prototype.delete;
    try {
        await seed(); let notified = false;
        init({ onConversationDeleted: () => { notified = true; } });
        IDBObjectStore.prototype.delete = function(query: IDBValidKey | IDBKeyRange) {
            if (this.name === 'details') throw new Error('delete failed');
            return originalDelete.call(this, query);
        };
        await assert.rejects(handleWindowMessage(deletion()), /delete failed/);
        assert.equal(notified, false);
        assert.ok(await getIndex(key())); assert.ok(await getDetail(key())); assert.ok(await getExportRecord(key()));
    } finally { IDBObjectStore.prototype.delete = originalDelete; runtime.restore(); storage.restore(); }
});

test('Coverage uses independent source activity keys even when Index.updatedAt is absent or different', async () => {
    const storage = indexStorage();
    try {
        for (const [streamId, fields] of [['absent', {}], ['different', { updatedAt: 1 }]] as const) {
            await ingestIndexes(ACCOUNT_UUID, [{ conversationId: cid, fields }], {
                streamId, requestCursor: null, nextCursor: null, requestedAt: 10,
                requestKnown: true, valid: true, ordered: true, keys: [{ id: cid, time: 99 }],
            });
            assert.deepEqual((await getCoverage(ACCOUNT_UUID, streamId))?.range,
                { head: { id: cid, time: 99 }, tail: { id: cid, time: 99 } });
        }
        await ingestIndexes(ACCOUNT_UUID, [{ conversationId: cid, fields: {} }], {
            streamId: 'foreign-key', requestCursor: null, nextCursor: null, requestedAt: 10,
            requestKnown: true, valid: true, ordered: true, keys: [{ id: 'other', time: 99 }],
        });
        assert.equal((await getCoverage(ACCOUNT_UUID, 'foreign-key'))?.range, null);
    } finally { storage.restore(); }
});

const signed = 'https://storage.googleapis.com/image?X-Goog-Signature=secret&X-Goog-Expires=60';
test('temporary signed URLs remain acquisition hints; durable source query semantics are retained', async () => {
    const storage = indexStorage();
    try {
        const stable = 'https://example.test/resource?id=authored&variant=original';
        const resources = closeDomainResources('gemini', [], [{ input: { attachments: [
            { type: 'image', sourceUrl: stable, resolvedUrl: signed },
            { type: 'image', url: signed.replace('/image?', '/other?') },
        ] } }]);
        assert.equal(resources.assets[0].sourceUri, stable);
        const refreshed = closeDomainResources('gemini', [], [{ input: { attachments: [
            { type: 'image', sourceUrl: stable, resolvedUrl: signed.replace('secret', 'refreshed-signature') },
        ] } }]);
        assert.equal(refreshed.assets[0].id, resources.assets[0].id, 'rotating a download credential does not change durable resource identity');
        assert.equal(resources.acquisitionHints[resources.assets[0].id].resolvedUrl, signed);
        assert.equal(resources.assets[1].sourceUri, undefined);
        assert.equal(resources.acquisitionHints[resources.assets[1].id].url, signed.replace('/image?', '/other?'));
        await ingestDetail(ACCOUNT_UUID, cid, { ...body(), assets: resources.assets });
        assert.ok(!JSON.stringify(await getDetail(key())).includes('secret'));
        await assert.rejects(ingestDetail(ACCOUNT_UUID, cid, { ...body(), assets: [{ id: 'bad', kind: 'image', sourceUri: signed }] }), /Domain contract/);
    } finally { storage.restore(); }
});

test('L2 omits undefined optional facts and rejects empty generation/document before persistence', async () => {
    const storage = indexStorage();
    try {
        await ingestDetail(ACCOUNT_UUID, cid, { ...body(), savedAt: undefined,
            messages: [{ role: 'user', content: [], model: undefined, attachmentIds: [] }],
            assets: [{ id: 'valid', kind: 'image', name: undefined, generation: { prompt: 'draw', time: undefined } }] });
        const stored = await getDetail(key()); assert.ok(stored);
        assert.equal(Object.hasOwn(stored, 'savedAt'), false);
        assert.equal(Object.hasOwn(stored.messages[0], 'model'), false);
        assert.deepEqual(stored.messages[0].attachmentIds, []);
        assert.deepEqual(stored.assets[0].generation, { prompt: 'draw' });
        for (const asset of [{ id: 'bad', kind: 'image' as const, generation: { prompt: undefined } },
            { id: 'bad', kind: 'file' as const, document: { id: undefined } }]) {
            await assert.rejects(ingestDetail(ACCOUNT_UUID, cid, { ...body(), assets: [asset] }), /Domain contract/);
            assert.deepEqual(await getDetail(key()), stored);
        }
    } finally { storage.restore(); }
});

test('scan cleanup aborts both Coverage and ExportRecords when either deletion fails', async () => {
    const storage = indexStorage(), originalDelete = IDBObjectStore.prototype.delete;
    try {
        await seed();
        await updateCoverageAtomically(ACCOUNT_UUID, 'recent', () => ({ next: { range: null }, result: undefined }));
        IDBObjectStore.prototype.delete = function(query: IDBValidKey | IDBKeyRange) {
            if (this.name === 'exportRecords') throw new Error('cleanup failed');
            return originalDelete.call(this, query);
        };
        await assert.rejects(clearLocalScanRecords(ACCOUNT_UUID), /cleanup failed/);
        assert.deepEqual(await getCoverage(ACCOUNT_UUID, 'recent'), { range: null });
        assert.ok(await getExportRecord(key())); assert.ok(await getDetail(key()));
    } finally { IDBObjectStore.prototype.delete = originalDelete; storage.restore(); }
});

test('Detail IPC rejects malformed graphs and mismatched identity, then admits canonical facts', async () => {
    const storage = indexStorage({ gemini_exporter_v2_initialized: true });
    try {
        await ingestDetail(ACCOUNT_UUID, cid, body());
        const before = await getDetail(key());
        Object.assign(chrome.runtime, { id: 'own-extension' });
        const malformed: unknown[] = [
            { ...body(), assets: 'not an array' },
            { ...body(), messages: [{ role: 'assistant', content: [{ type: 'image', assetId: 'missing' }] }] },
            { ...body(), key: key(OTHER_ACCOUNT_UUID) },
            { ...body(), key: { ...key(), conversationId: 'another' } },
        ];
        for (const detail of malformed) {
            const response = await new Promise<unknown>(resolve => {
                assert.equal(handleDomainIngestionMessage({ action: 'domainIngest', operation: 'detail',
                    accountId: ACCOUNT_UUID, conversationId: cid, detail }, {
                    id: 'own-extension', tab: { id: 1 } as chrome.tabs.Tab, frameId: 0,
                    url: 'https://gemini.google.com/app'
                }, resolve), true);
            });
            assert.ok(response && typeof response === 'object' && 'ok' in response);
            assert.equal(response.ok, false);
            assert.deepEqual(await getDetail(key()), before);
        }
        const response = await new Promise<unknown>(resolve => {
            assert.equal(handleDomainIngestionMessage({ action: 'domainIngest', operation: 'detail',
                accountId: ACCOUNT_UUID, conversationId: cid,
                detail: { ...body(), messages: [{ role: 'assistant', content: [], model: undefined }] } }, {
                id: 'own-extension', tab: { id: 1 } as chrome.tabs.Tab, frameId: 0,
                url: 'https://gemini.google.com/app'
            }, resolve), true);
        });
        assert.deepEqual(response, { ok: true, result: { accepted: true, changed: true } });
        const stored = await getDetail(key()); assert.ok(stored);
        assert.deepEqual(stored.messages, [{ role: 'assistant', content: [] }]);
    } finally { storage.restore(); }
});
