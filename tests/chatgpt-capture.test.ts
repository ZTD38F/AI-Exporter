import test from 'node:test';
import assert from 'node:assert/strict';
import { chatGPTRequest, confirmedChatGPTDeletion, chatGPTStreamEvent } from '../src/l1/sniffer/chatgpt/observation.js';
// The MAIN-world entry installs on import; load it only after installing the browser fixture.
function installChatGPTHook(): void {
    const entry = require.resolve('../src/l1/sniffer/chatgpt/hook.js');
    delete require.cache[entry];
    require(entry);
}
import { streamGen } from './fixtures/providers/chatgptStream.js';
import { listGen as chatgptListGen } from './fixtures/providers/chatgpt.js';
import { sessionGen as chatgptSessionGen } from './fixtures/providers/chatgptSession.js';
import { detailGen as chatgptDetailGen } from './fixtures/providers/chatgptDetail.js';
import { deleteGen as chatgptDeleteGen } from './fixtures/providers/chatgptDelete.js';
import { chatGPTSidebarPage } from '../src/l1/sniffer/chatgpt/sidebar.js';

const cid = '6acffdc5-c4d0-83e8-8e1b-ba60979a618a';
const session = chatgptSessionGen('C_CAPTURE_SESSION_04');

test('capture binds exact ChatGPT endpoints and rejects lookalikes, prepare and invalid IDs', () => {
    assert.deepEqual(chatGPTRequest('https://chatgpt.com/backend-api/f/conversation', 'POST'), { kind: 'stream' });
    assert.deepEqual(chatGPTRequest('https://chatgpt.com/backend-api/conversation/'+cid, 'GET'), { kind: 'detail', conversationId: cid });
    assert.deepEqual(chatGPTRequest('https://chatgpt.com/backend-api/conversations?offset=0&limit=28', 'GET'), { kind: 'list' });
    for (const [url, method] of [
        ['https://chatgpt.com.evil.test/backend-api/conversation/'+cid, 'GET'],
        ['http://chatgpt.com/backend-api/conversation/'+cid, 'GET'],
        ['https://chatgpt.com/backend-api/conversation/invalid', 'PATCH'],
        ['https://chatgpt.com/backend-api/f/conversation/prepare', 'POST'],
        ['https://chatgpt.com/backend-api/conversations', 'POST'],
        ['https://chatgpt.com/backend-api/conversations/invalid', 'GET'],
    ]) assert.equal(chatGPTRequest(url, method), null);
    assert.equal(confirmedChatGPTDeletion({ is_visible: false }, chatgptDeleteGen('C_CAPTURE_PATCH_CONFIRMED_01')), true);
    for (const [request, response] of [
        [{ is_visible: true }, chatgptDeleteGen('C_CAPTURE_PATCH_VISIBLE_01')],
        [{ is_visible: false }, chatgptDeleteGen('C_CAPTURE_PATCH_REJECTED_01')],
        [{ is_visible: false }, chatgptDeleteGen('C_CAPTURE_PATCH_EMPTY_01')],
        [{ is_visible: false }, chatgptDeleteGen('C_CAPTURE_PATCH_STRING_SUCCESS_01')],
    ] as const) assert.equal(confirmedChatGPTDeletion(request, response), false);
});

test('MAIN capture never consumes the page response or exposes tokens, and rejects switched sessions', async t => {
    const session = chatgptSessionGen('C_CAPTURE_SESSION_01');
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    t.after(() => {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
        if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation); else Reflect.deleteProperty(globalThis, 'location');
    });
    for (const switched of [false, true]) {
        const events: unknown[] = [];
        let sessions = 0;
        const windowMock = { fetch: async (input: RequestInfo | URL) => {
            if (String(input).endsWith('/api/auth/session')) {
                sessions++;
                return Response.json(switched && sessions > 1 ? chatgptSessionGen('C_CAPTURE_SESSION_02') : session);
            }
            return Response.json(chatgptDetailGen('C_CAPTURE_EMPTY_DETAIL_01'));
        }, postMessage: (message: unknown) => events.push(message) };
        Object.defineProperty(globalThis, 'window', { configurable: true, value: windowMock });
        Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://chatgpt.com/c/'+cid, origin: 'https://chatgpt.com' } });
        installChatGPTHook();
        const response = await windowMock.fetch('https://chatgpt.com/backend-api/conversation/'+cid);
        assert.equal(response.bodyUsed, false);
        assert.equal((await response.json()).id, cid);
        for (let i = 0; i < 30 && sessions < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(events.length, switched ? 0 : 1);
        assert.equal(JSON.stringify(events).includes(String(session.accessToken)), false);
        if (!switched) assert.equal(Reflect.get(Reflect.get(events[0] as object, 'payload'), 'requestIdentity'), '["subject","workspace"]');
    }
});


test('SSE recognizes explicit completion and delta envelopes without treating prose as identity', () => {
    assert.deepEqual(chatGPTStreamEvent(streamGen('C_STREAM_EVENT_01')), {done:true});
    assert.deepEqual(chatGPTStreamEvent(streamGen('C_STREAM_EVENT_02')), {done:false,conversationId:cid});
    assert.deepEqual(chatGPTStreamEvent(streamGen('C_STREAM_EVENT_03')), {done:false,conversationId:cid});
    for (const key of ['C_STREAM_EVENT_INVALID_01', 'C_STREAM_EVENT_INVALID_02',
        'C_STREAM_EVENT_INVALID_03', 'C_STREAM_EVENT_INVALID_04'] as const)
        assert.deepEqual(chatGPTStreamEvent(streamGen(key)), {done:false});
});

test('sidebar list capture preserves pagination and all items without requiring a conversation id', async t => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    t.after(() => {
        for (const [key, descriptor] of [['window', previousWindow], ['location', previousLocation]] as const) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    });
    const page = chatgptListGen('C_CAPTURE_LIST_01');
    for (const mode of ['accepted', 'switched', 'workspace-mismatch', 'failed']) {
        const events: { payload: Record<string, unknown> }[] = [];
        let sessions = 0;
        const mock = {
            fetch: async (input: RequestInfo | URL, _init?: RequestInit) => {
                if (String(input).endsWith('/api/auth/session')) {
                    sessions++;
                    return Response.json(mode === 'switched' && sessions > 1
                        ? chatgptSessionGen('C_CAPTURE_SESSION_05') : session);
                }
                return Response.json(page, { status: mode === 'failed' ? 500 : 200 });
            },
            postMessage: (event: { payload: Record<string, unknown> }) => events.push(event),
        };
        Object.defineProperty(globalThis, 'window', { configurable: true, value: mock });
        Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' } });
        installChatGPTHook();
        const response = await mock.fetch('https://chatgpt.com/backend-api/conversations?offset=28&limit=28',
            mode === 'workspace-mismatch' ? { headers: { 'ChatGPT-Account-ID': 'other' } } : undefined);
        assert.equal(response.bodyUsed, false);
        assert.deepEqual(await response.json(), page);
        for (let i = 0; i < 30 && !events.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(events.length, mode === 'accepted' ? 1 : 0, mode);
        if (mode === 'accepted') {
            assert.equal(events[0].payload.kind, 'list');
            assert.deepEqual(events[0].payload.responseBody, page);
            assert.equal(events[0].payload.conversationId, undefined);
        }
        assert.equal(JSON.stringify(events).includes(String(session.accessToken)), false);
    }
});

test('MAIN emits on [DONE] even when the source stream remains open, without consuming the page branch', async t => {
    const session = chatgptSessionGen('C_CAPTURE_SESSION_03');
    const priorWindow=Object.getOwnPropertyDescriptor(globalThis,'window'), priorLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const source=new ReadableStream<Uint8Array>({start(c){controller=c;}});
    const events: unknown[]=[];
    const mock={fetch:async(input: RequestInfo | URL, _init?: RequestInit)=>String(input).endsWith('/api/auth/session')?Response.json(session):new Response(source),
        postMessage:(event:unknown)=>events.push(event)};
    Object.defineProperty(globalThis,'window',{configurable:true,value:mock});
    Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://chatgpt.com/',origin:'https://chatgpt.com'}});
    t.after(()=>{controller.close();if(priorWindow)Object.defineProperty(globalThis,'window',priorWindow);else Reflect.deleteProperty(globalThis,'window');
        if(priorLocation)Object.defineProperty(globalThis,'location',priorLocation);else Reflect.deleteProperty(globalThis,'location');});
    installChatGPTHook();
    const response=await mock.fetch('https://chatgpt.com/backend-api/f/conversation',{method:'POST'});
    const data=streamGen('C_STREAM_CAPTURE_CHUNK_01');
    controller!.enqueue(new TextEncoder().encode(data.slice(0,20)));
    controller!.enqueue(new TextEncoder().encode(data.slice(20)));
    for(let i=0;i<50&&!events.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(events.length,1,'completion does not wait for HTTP EOF or tee cancellation');
    assert.equal(response.bodyUsed,false);
    const reader=response.body!.getReader();const first=await reader.read();assert.ok(first.value!.length>0);reader.releaseLock();
    assert.ok(!JSON.stringify(events).includes(String(session.accessToken)));
});


test('native ChatGPT DELETE binds its exact id endpoint and requires explicit success', () => {
    assert.deepEqual(chatGPTRequest('https://chatgpt.com/backend-api/conversation/id/'+cid,'DELETE'),{kind:'delete',conversationId:cid,method:'DELETE'});
    assert.equal(chatGPTRequest('https://chatgpt.com/backend-api/conversation/'+cid,'DELETE'),null);
    assert.equal(confirmedChatGPTDeletion(null, chatgptDeleteGen('C_CAPTURE_DELETE_CONFIRMED_01'), 'DELETE'), true);
    for (const key of [
        'C_CAPTURE_DELETE_NULL_01',
        'C_CAPTURE_DELETE_EMPTY_01',
        'C_CAPTURE_DELETE_REJECTED_01',
        'C_CAPTURE_DELETE_STRING_SUCCESS_01',
    ] as const) assert.equal(confirmedChatGPTDeletion(null, chatgptDeleteGen(key), 'DELETE'), false);
});

test('SSR sidebar capture awaits native loader data, binds its workspace and strips unrelated fields', async () => {
    const identity = async () => '["subject","workspace"]';
    const page = chatgptListGen('C_CAPTURE_SIDEBAR_LIST_01');
    const history = { accountId: 'workspace', chats: Promise.resolve(page), session: { accessToken: 'private-token' } };
    const captured = await chatGPTSidebarPage(history, identity);
    assert.equal(captured?.responseBody.items.length, 1);
    assert.equal(captured?.responseBody.total, 1);
    assert.equal(captured?.requestIdentity, await identity());
    assert.ok(!JSON.stringify(captured).includes('private-token'));
    assert.ok(!JSON.stringify(captured).includes('not-list-data'));
    assert.equal(await chatGPTSidebarPage({ ...history, accountId: 'other' }, identity), null);
    let reads = 0;
    assert.equal(await chatGPTSidebarPage(history, async () => ++reads === 1 ? await identity() : '["other","workspace"]'), null);
    assert.equal(await chatGPTSidebarPage(history, async () => null), null);
    assert.equal(await chatGPTSidebarPage({ accountId: 'workspace', chats: Promise.resolve({ ...page,
        items: [{ id: 'invalid' }] }) }, identity), null);
    assert.equal(await chatGPTSidebarPage({ accountId: 'workspace', chats: Promise.resolve({ ...page,
        items: [null] }) }, identity), null);
    assert.equal(await chatGPTSidebarPage({ accountId: 'workspace', chats: Promise.resolve({ ...page,
        items: [123] }) }, identity), null);
    assert.equal(await chatGPTSidebarPage({ chats: page }, identity), null);
});
