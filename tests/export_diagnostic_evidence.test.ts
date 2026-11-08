import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatGPTProvider } from '../src/l1/client/chatgpt/chatgptProvider.js';
import { acquireSourceResource } from '../src/l1/resources/sourceResources.js';
import type { Diagnostic } from '../src/shared/diagnostics/diagnostic.js';
import { getOrCreateAccount } from '../src/runtime/api/accountRegistry.js';
import { useIndexStorage } from './helpers/indexStorage.js';
import { sessionGen } from './fixtures/providers/chatgptSession.js';
import { fileDownloadGen } from './fixtures/providers/chatgptFileDownload.js';
import { detailGen } from './fixtures/providers/chatgptDetail.js';
import { attemptResource, resourceIssueKind } from '../src/shared/resources/resourceResult.js';
import { parseChatGPTConversation } from '../src/l1/parsers/chatgpt/parseConversation.js';
import { decodeChatGPTDetail } from '../src/l1/parsers/chatgpt/decodeDetail.js';

useIndexStorage();

for (const failure of ['locator', 'payload', 'signed', 'body'] as const) {
    test(`ChatGPT acquisition diagnostics identify ${failure} failure without signed URL disclosure`, async () => {
        const account = await getOrCreateAccount('chatgpt', 'default');
        const diagnostics: Diagnostic[] = [];
        const provider = new ChatGPTProvider({ fetchFn: async url => {
            if (url.endsWith('/api/auth/session')) return Response.json(sessionGen('C_FILE_DOWNLOAD_SESSION_01'));
            if (url.includes('/backend-api/')) {
                if (failure === 'locator') throw new TypeError('Failed to fetch');
                return Response.json(fileDownloadGen(failure === 'payload'
                    ? 'C_FILE_DOWNLOAD_ACQUIRE_02' : 'C_DIAGNOSTIC_SIGNED_DOWNLOAD_01'));
            }
            if (failure === 'signed') throw new TypeError('Failed to fetch');
            return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('Body read failed')); } }));
        } });
        await assert.rejects(provider.acquireResource({ accountId: account.id, conversationId: 'diagnostic-resource' },
            { id: 'file', kind: 'file', sourceUri: 'file-download:file_diagnostic' }, undefined, d => diagnostics.push(d)));
        const failed = diagnostics.find(d => d.code === 'CHATGPT_RESOURCE_REQUEST_FAILED');
        assert.ok(failed);
        assert.ok(failed.details && typeof failed.details === 'object' && !Array.isArray(failed.details));
        assert.equal(failed.details.phase, { locator: 'download_locator', payload: 'download_payload', signed: 'resource_fetch', body: 'read_body' }[failure]);
        assert.equal(failed.details.origin, failure === 'signed' || failure === 'body' ? 'https://files.example' : 'https://chatgpt.com');
        if (failure === 'payload') {
            const invalid = diagnostics.find(d => d.code === 'CHATGPT_DOWNLOAD_PAYLOAD_INVALID');
            assert.ok(invalid?.details && typeof invalid.details === 'object' && !Array.isArray(invalid.details));
            assert.deepEqual(invalid.details.responseKeys, ['status']);
            assert.equal(invalid.details.downloadUrlPresent, false);
        }
        assert.doesNotMatch(JSON.stringify(diagnostics), /do-not-log|private-path|accessToken/);
    });
}

test('external request diagnostics preserve the original failure and redact URL paths', async t => {
    const failure = new TypeError('Failed to fetch');
    t.mock.method(globalThis, 'fetch', async () => { throw failure; });
    const diagnostics: Diagnostic[] = [];
    await assert.rejects(acquireSourceResource({ id: 'external', kind: 'image',
        sourceUri: 'https://images.example/private?signature=secret' }, undefined, d => diagnostics.push(d)), error => error instanceof Error && error.cause === failure && 'code' in error && error.code === 'RESOURCE_DOWNLOAD_FAILED');
    const failed = diagnostics.find(d => d.code === 'RESOURCE_FETCH_FAILED');
    assert.ok(failed?.details && typeof failed.details === 'object' && !Array.isArray(failed.details));
    assert.equal(failed.details.origin, 'https://images.example');
    assert.equal(failed.details.phase, 'fetch');
    assert.equal(failed.details.errorName, 'TypeError');
    assert.equal(failed.details.httpStatus, null);
    assert.equal(failed.details.credentials, 'omit');
    assert.doesNotMatch(JSON.stringify(diagnostics), /private|signature|secret/);
    const result = await attemptResource('external', () => acquireSourceResource({ id: 'external', kind: 'image',
        sourceUri: 'https://images.example/private?signature=secret' }));
    if (result.ok) assert.fail('browser transport failure cannot produce attachment bytes');
    assert.equal(result.code, 'RESOURCE_DOWNLOAD_FAILED');
    assert.equal(resourceIssueKind(result), 'download');
});

test('source images recover from wildcard CORS without breaking authenticated downloads', async t => {
    const attempts: RequestCredentials[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
        const credentials = init?.credentials ?? 'same-origin';
        attempts.push(credentials);
        if (credentials === 'include') throw new TypeError('Failed to fetch');
        return new Response('public-image');
    });
    const result = await acquireSourceResource({ id: 'public', kind: 'image', sourceUri: 'https://raw.githubusercontent.com/image.png' });
    assert.equal(new TextDecoder().decode(result.bytes), 'public-image');
    assert.deepEqual(attempts, ['include', 'omit']);
    t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(init?.credentials, 'include');
        return new Response('authenticated-image');
    });
    assert.equal(new TextDecoder().decode((await acquireSourceResource({ id: 'private', kind: 'image',
        sourceUri: 'https://lh3.googleusercontent.com/image' })).bytes), 'authenticated-image');
});

test('source acquisition never retries an HTTP error or a cancelled request without credentials', async t => {
    const controller = new AbortController();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 403 }); });
    await assert.rejects(acquireSourceResource({ id: 'restricted', kind: 'image', sourceUri: 'https://images.example/image' }));
    assert.equal(calls, 1);
    t.mock.method(globalThis, 'fetch', async () => { calls++; controller.abort(); throw new TypeError('Failed to fetch'); });
    await assert.rejects(acquireSourceResource({ id: 'cancelled', kind: 'image', sourceUri: 'https://images.example/image' }, controller.signal),
        { name: 'AbortError' });
    assert.equal(calls, 2);
});

test('native sandbox expiration remains distinct from HTTP 404 and does not disclose the error body', async () => {
    const account = await getOrCreateAccount('chatgpt', 'default');
    const diagnostics: Diagnostic[] = [];
    const provider = new ChatGPTProvider({ fetchFn: async url => Response.json(url.endsWith('/api/auth/session')
        ? sessionGen('C_FILE_DOWNLOAD_SESSION_01') : fileDownloadGen('C_DIAGNOSTIC_EXPIRED_SANDBOX_01')) });
    const result = await attemptResource('expired', () => provider.acquireResource(
        { accountId: account.id, conversationId: 'expired' }, { id: 'expired', kind: 'file', sourceUri: 'file-download:file_expired' },
        undefined, d => diagnostics.push(d)));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'RESOURCE_SOURCE_EXPIRED');
    assert.equal(resourceIssueKind(result), 'expired');
    assert.equal(result.httpStatus, undefined);
    assert.match(result.reason, /ace_pod_expired/);
    const invalid = diagnostics.find(d => d.code === 'CHATGPT_DOWNLOAD_PAYLOAD_INVALID');
    assert.ok(invalid?.details && typeof invalid.details === 'object' && !Array.isArray(invalid.details));
    assert.equal(invalid.details.errorCode, 'ace_pod_expired');
    assert.equal(invalid.details.errorType, 'GetDownloadLinkError');
    assert.doesNotMatch(JSON.stringify(diagnostics), /do-not-log|private-path|secret/);
});

for (const origin of ['https://chatgpt.com', 'https://chat.openai.com']) test(`relative downloads resolve against provider origin ${origin}`, async () => {
    const account = await getOrCreateAccount('chatgpt', 'default');
    const diagnostics: Diagnostic[] = [];
    const requests: string[] = [];
    const provider = new ChatGPTProvider({ origin, fetchFn: async url => {
        requests.push(url);
        if (url.endsWith('/api/auth/session')) return Response.json(sessionGen('C_FILE_DOWNLOAD_SESSION_01'));
        if (url.includes('/backend-api/')) return Response.json(fileDownloadGen('C_DIAGNOSTIC_RELATIVE_DOWNLOAD_01'));
        assert.equal(url, `${origin}/private-path?token=do-not-log`);
        return new Response('uploaded-file-bytes');
    } });
    const result = await provider.acquireResource({ accountId: account.id, conversationId: 'relative' },
        { id: 'relative', kind: 'file', sourceUri: 'file-download:file_relative' }, undefined, d => diagnostics.push(d));
    assert.equal(new TextDecoder().decode(result.bytes), 'uploaded-file-bytes');
    assert.equal(requests.length, 3);
    const shape = diagnostics.find(d => d.code === 'CHATGPT_DOWNLOAD_URL_SHAPE');
    assert.ok(shape?.details && typeof shape.details === 'object' && !Array.isArray(shape.details));
    assert.deepEqual(shape.details.shape, { kind: 'root_relative', scheme: null, length: 30, surroundingWhitespace: false });
    assert.equal(shape.details.origin, origin);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private-path|do-not-log/);
});

test('internal tool termination is a tool step without claiming missing snapshot content', () => {
    const raw = detailGen('C_DETAIL_L1_SOURCE_01');
    const conversation = decodeChatGPTDetail(raw, raw.id);
    const leaf = conversation.mapping.get(conversation.current_node);
    assert.ok(leaf?.message);
    leaf.message.end_turn = false;
    leaf.message.recipient = 'python';
    leaf.message.channel = 'analysis';
    const parsed = parseChatGPTConversation({ conversation, assetsByNode: new Map() });
    assert.deepEqual(parsed.conversation.detail.quality, { status: 'complete', sourceTurn: 'tool_pending' });
    assert.ok(!parsed.diagnostics.some(d => d.code === 'CHATGPT_BRANCH_COVERAGE_INCOMPLETE'));
    const observation = parsed.diagnostics.find(d => d.code === 'CHATGPT_SOURCE_TURN_STATUS');
    assert.ok(observation?.details && typeof observation.details === 'object' && !Array.isArray(observation.details));
    assert.equal(observation.details.recipient, 'python');
    assert.equal(observation.details.channel, 'analysis');
    assert.equal(observation.details.sourceTurn, 'tool_pending');
    assert.equal('content' in observation.details, false);
});

test('diagnostic observers cannot break successful downloads or detail admission', async t => {
    t.mock.method(console, 'warn', () => {});
    const account = await getOrCreateAccount('chatgpt', 'default');
    const provider = new ChatGPTProvider({ fetchFn: async url => {
        if (url.endsWith('/api/auth/session')) return Response.json(sessionGen('C_FILE_DOWNLOAD_SESSION_01'));
        if (url.includes('/conversation/source-chatgpt-1')) return Response.json(detailGen('C_DETAIL_L1_SOURCE_01'));
        if (url.includes('/backend-api/')) return Response.json(fileDownloadGen('C_DIAGNOSTIC_SIGNED_DOWNLOAD_01'));
        return new Response('attachment');
    } });
    const admission: Diagnostic[] = [];
    await provider.fetchConversationDetail(account.id, 'source-chatgpt-1', undefined, d => admission.push(d));
    const observation = admission.find(d => d.code === 'CHATGPT_DETAIL_ADMISSION');
    assert.ok(observation?.details && typeof observation.details === 'object' && !Array.isArray(observation.details));
    assert.equal(observation.details.accepted, true);
    assert.equal(observation.details.quality, 'complete');
    const result = await provider.acquireResource({ accountId: account.id, conversationId: 'diagnostic-resource' },
        { id: 'file', kind: 'file', sourceUri: 'file-download:file_diagnostic' }, undefined, () => { throw new Error('Observer failed'); });
    assert.equal(new TextDecoder().decode(result.bytes), 'attachment');
});
