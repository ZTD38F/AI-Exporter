// L1-owned source hook protocol tests, formerly mixed into Browser Runtime unit tests.
// Runtime tests mock the L1 bootstrap/MessageBridge v2 contracts instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { streamGen as geminiStreamGen } from './fixtures/providers/geminiStream.js';

test('MAIN hook reinjection returns before wrapping fetch or adding timers/listeners', () => {
    const vm = require('node:vm');
    const script = require('./helpers/bundleGeminiHook.cjs')();
    const window = { __gemExporterHookInstalled: true, fetch: () => {} };
    const original = window.fetch;
    vm.runInNewContext(script, { window });
    assert.equal(window.fetch, original);
});


// Completion requires an answered candidate and a complete response, not HTTP status.
// The fixture has no cloud-history persistence token. Application acquires Detail.
function hookHarness(fetcher: Function) {
    const vm = require('node:vm');
    const protocol = require('../src/l1/protocol/gemini/protocol.js');
    const messages: any[] = [];
    let intervals = 0;
    class Xhr extends EventTarget {
        status = 200; responseText = ''; nativeSendError = false;
        open() {}
        send() { if (this.nativeSendError) throw new Error('native send failed'); }
        emit(type: string) { this.dispatchEvent(new Event(type)); }
    }
    const win = Object.assign(new EventTarget(), {
        fetch: fetcher,
        postMessage: (message: unknown) => { messages.push(message); },
        setInterval: () => { intervals++; return 1; },
    });
    const location = { href: 'https://gemini.google.com/app/abcdef123456', pathname: '/app/abcdef123456', origin: 'https://gemini.google.com' };
    const script = require('./helpers/bundleGeminiHook.cjs')();
    const context = vm.createContext({ window: win, location, document: new EventTarget(),
        console, Event, URL, URLSearchParams, Request, Response, TextEncoder, TextDecoder, Uint8Array, atob,
        XMLHttpRequest: Xhr, GeminiProtocol: protocol, CrossWorldEvents: protocol.CrossWorldEvents,
        sniffUserProfileFromDom: () => ({}), geminiAccountObservation: () => ({ providerId: 'gemini', providerAccountId: 'gaia' }),

    });
    const inject = () => vm.runInContext(script, context);
    inject();
    return { win, Xhr, messages, inject, intervals: () => intervals,
        complete: () => messages.filter(message => message.type === 'GEMINI_STREAM_GENERATE_COMPLETE'),
        url: 'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
    };
}
const settleHook = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

test('Fetch: answered frames without a persistence token notify once, reinjection and replay do not duplicate', async () => {
    const harness = hookHarness(async () => new Response(geminiStreamGen('G_STREAM_ANSWERED_01')));
    const fetch = harness.win.fetch;
    harness.inject(); assert.equal(harness.win.fetch, fetch); assert.equal(harness.intervals(), 1);
    const response = await harness.win.fetch(harness.url);
    await response.text(); await settleHook();
    assert.equal(harness.complete().length, 1);
    assert.equal(harness.complete()[0].payload.id, 'abcdef123456');
    await (await harness.win.fetch(harness.url)).text(); await settleHook();
    assert.equal(harness.complete().length, 1);
});
for (const status of [400, 500]) test(`Fetch: HTTP ${status} never completes even with final-looking body`, async () => {
    const harness = hookHarness(async () => new Response(geminiStreamGen('G_STREAM_ANSWERED_01'), { status }));
    await (await harness.win.fetch(harness.url)).text(); await settleHook();
    assert.equal(harness.complete().length, 0);
    assert.equal((harness.win as any).__geminiIsStreaming, false);
});
test('Fetch: rejected Abort clears transient generation state without completing', async () => {
    const harness = hookHarness(async () => { throw new DOMException('cancelled', 'AbortError'); });
    await assert.rejects(harness.win.fetch(harness.url), /cancelled/);
    assert.equal(harness.complete().length, 0);
    assert.equal((harness.win as any).__geminiIsStreaming, false);
});
test('Fetch: body reader failure never falls back to successful text or completes', async () => {
    const harness = hookHarness(async () => ({ ok: true, clone: () => ({
        body: { getReader: () => ({ read: async () => { throw new Error('read failed'); }, releaseLock() {} }) },
        text: () => assert.fail('Do not reinterpret failed reader as successful text'),
    }) }));
    await harness.win.fetch(harness.url); await settleHook();
    assert.equal(harness.complete().length, 0);
    assert.equal((harness.win as any).__geminiIsStreaming, false);
});
test('Fetch: capped response cannot complete even when its prefix contains completion markers', async () => {
    let reads = 0, cancels = 0;
    const harness = hookHarness(async () => ({ ok: true, clone: () => ({ body: { getReader: () => ({
        read: async () => ({ done: false, value: new TextEncoder().encode(geminiStreamGen('G_STREAM_OVER_101_MIB_01')) }),
        cancel: () => { cancels++; return new Promise<void>(() => {}); }, releaseLock() { reads++; },
    }) } }) }));
    await harness.win.fetch(harness.url); await settleHook();
    assert.equal(reads, 1); assert.equal(cancels, 1);
    assert.equal(harness.complete().length, 0);
});
for (const key of ['G_STREAM_UNANSWERED_01', 'G_STREAM_INVALID_EMPTY_01',
    'G_STREAM_EXTRA_LENGTH_01', 'G_STREAM_ERROR_TRAILER_01'] as const) {
    const wire = geminiStreamGen(key);
    test('Fetch: HTTP 200 without unambiguous successful protocol termination is ignored: ' + wire.slice(-22), async () => {
        const harness = hookHarness(async () => new Response(wire));
        await (await harness.win.fetch(harness.url)).text(); await settleHook();
        assert.equal(harness.complete().length, 0);
    });
}
test('Fetch: clone failure and signal aborted after headers do not complete', async () => {
    const failedClone = hookHarness(async () => ({ ok: true, clone: () => { throw new Error('clone failed'); } }));
    await failedClone.win.fetch(failedClone.url); await settleHook(); assert.equal(failedClone.complete().length, 0);
    const controller = new AbortController();
    const aborted = hookHarness(async () => { controller.abort(); return new Response(geminiStreamGen('G_STREAM_ANSWERED_01')); });
    await (await aborted.win.fetch(aborted.url, { signal: controller.signal })).text(); await settleHook();
    assert.equal(aborted.complete().length, 0);
});
test('XHR: successful final frames on load notify once; loadend/reinjection/replay cannot duplicate', () => {
    const harness = hookHarness(async () => new Response(geminiStreamGen('G_STREAM_EMPTY_HTTP_01')));
    harness.inject(); assert.equal(harness.intervals(), 1);
    const xhr = new harness.Xhr();
    (xhr.open as Function)('POST', harness.url); xhr.responseText = geminiStreamGen('G_STREAM_ANSWERED_01'); xhr.send();
    xhr.emit('load'); xhr.emit('loadend'); xhr.emit('load');
    assert.equal(harness.complete().length, 1);
    // Reusing the object must not retain old listeners, and a new response id is a new turn.
    (xhr.open as Function)('POST', harness.url); xhr.responseText = geminiStreamGen('G_STREAM_DIFFERENT_REQUEST_01'); xhr.send(); xhr.emit('load'); xhr.emit('loadend');
    assert.equal(harness.complete().length, 2);
});
for (const event of ['abort', 'error', 'timeout', 'loadend']) test(`XHR: ${event} is request termination, never generation completion`, () => {
    const harness = hookHarness(async () => new Response(geminiStreamGen('G_STREAM_EMPTY_HTTP_01')));
    const xhr = new harness.Xhr(); (xhr.open as Function)('POST', harness.url); xhr.responseText = geminiStreamGen('G_STREAM_ANSWERED_01'); xhr.send();
    xhr.emit(event); xhr.emit('loadend'); xhr.emit('load');
    assert.equal(harness.complete().length, 0);
    assert.equal((harness.win as any).__geminiIsStreaming, false);
});
for (const status of [0, 403, 503]) test(`XHR: status ${status} with load cannot complete`, () => {
    const harness = hookHarness(async () => new Response(geminiStreamGen('G_STREAM_EMPTY_HTTP_01')));
    const xhr = new harness.Xhr(); (xhr.open as Function)('POST', harness.url); xhr.status = status; xhr.responseText = geminiStreamGen('G_STREAM_ANSWERED_01'); xhr.send(); xhr.emit('load'); xhr.emit('loadend');
    assert.equal(harness.complete().length, 0);
});
test('XHR: 200 without completion markers, oversized body and synchronous send failure cannot complete', () => {
    const harness = hookHarness(async () => new Response(geminiStreamGen('G_STREAM_EMPTY_HTTP_01')));
    for (const body of [geminiStreamGen('G_STREAM_UNANSWERED_01'), geminiStreamGen('G_STREAM_OVER_101_MIB_01')]) {
        const xhr = new harness.Xhr(); (xhr.open as Function)('POST', harness.url); xhr.responseText = body; xhr.send(); xhr.emit('load'); xhr.emit('loadend');
    }
    const xhr = new harness.Xhr(); (xhr.open as Function)('POST', harness.url); xhr.nativeSendError = true;
    assert.throws(() => xhr.send(), /native send failed/); xhr.responseText = geminiStreamGen('G_STREAM_ANSWERED_01'); xhr.emit('load');
    assert.equal(harness.complete().length, 0);
});


test('Fetch: relative StreamGenerate URL completes; unrelated BardFrontend RPC never does', async () => {
    const relative = hookHarness(async () => new Response(geminiStreamGen('G_STREAM_ANSWERED_01')));
    await (await relative.win.fetch(new URL(relative.url).pathname)).text(); await settleHook();
    assert.equal(relative.complete().length, 1);
    const unrelated = hookHarness(async () => new Response(geminiStreamGen('G_STREAM_ANSWERED_01')));
    await (await unrelated.win.fetch(unrelated.url.replace('/StreamGenerate', '/OtherRpc'))).text(); await settleHook();
    assert.equal(unrelated.complete().length, 0);
});


test('Fetch: live newline-inclusive frame lengths are accepted and corrupt lengths are rejected', async () => {
    const wire = geminiStreamGen('G_STREAM_INCLUSIVE_01');
    const valid = hookHarness(async () => new Response(wire));
    await (await valid.win.fetch(valid.url)).text(); await settleHook();
    assert.equal(valid.complete().length, 1);
    const corrupt = hookHarness(async () => new Response(geminiStreamGen('G_STREAM_CORRUPT_LENGTH_01')));
    await (await corrupt.win.fetch(corrupt.url)).text(); await settleHook();
    assert.equal(corrupt.complete().length, 0);
});

test('Fetch: sanitized live answered frame with newline-inclusive length triggers completion', async () => {
    const wire = geminiStreamGen('G_STREAM_CAPTURED_ANSWERED_01');
    const harness = hookHarness(async () => new Response(wire));
    await (await harness.win.fetch(harness.url)).text(); await settleHook();
    assert.equal(harness.complete().length, 1);
    assert.equal(harness.complete()[0].payload.id, 'abcdef123456');
});

test('Fetch: live Unicode frame lengths count UTF-16 units rather than UTF-8 bytes', async () => {
    const wire = geminiStreamGen('G_STREAM_UNICODE_INCLUSIVE_01');
    const frame = wire.split('\n').find(value => value.startsWith('[['));
    assert.ok(frame);
    assert.notEqual(frame.length, Buffer.byteLength(frame));
    const harness = hookHarness(async () => new Response(wire));
    await (await harness.win.fetch(harness.url)).text(); await settleHook();
    assert.equal(harness.complete().length, 1);
});

for (const transport of ['Fetch', 'XHR']) test(`${transport}: cumulative stream above 3 MiB reaches the final answered frame`, async () => {
    // Repeated growing snapshots make a modest answer a large cumulative stream.
    const wire = geminiStreamGen('G_STREAM_CUMULATIVE_3_MIB_01');
    assert.ok(Buffer.byteLength(wire) > 3 * 1024 * 1024);
    const harness = hookHarness(async () => new Response(wire));
    if (transport === 'Fetch') {
        await (await harness.win.fetch(harness.url)).text(); await settleHook();
    } else {
        const xhr = new harness.Xhr(); (xhr.open as Function)('POST', harness.url);
        xhr.responseText = wire; xhr.send(); xhr.emit('load');
    }
    assert.equal(harness.complete().length, 1);
    assert.equal(harness.complete()[0].payload.id, 'abcdef123456');
});


for (const transport of ['fetch', 'xhr']) test(`${transport}: endpoint dispatch rejects foreign hosts and misleading query parameters`, async () => {
    const wire = geminiStreamGen('G_STREAM_ANSWERED_01');
    const harness = hookHarness(async () => new Response(wire));
    for (const url of [
        harness.url.replace('gemini.google.com', 'example.com'),
        'https://gemini.google.com/telemetry?next=/StreamGenerate',
        'https://gemini.google.com/telemetry?next=/batchexecute',
    ]) {
        if (transport === 'fetch') {
            await (await harness.win.fetch(url)).text(); await settleHook();
        } else {
            const xhr = new harness.Xhr(); (xhr.open as Function)('POST', url);
            xhr.responseText = wire; xhr.send(); xhr.emit('load');
        }
    }
    assert.equal(harness.messages.filter(message => message.type !== 'GEMINI_ACCOUNT_OBSERVED').length, 0);
});

for (const transport of ['fetch', 'xhr']) test(`${transport}: identical stream frames go only to the selected endpoint handler`, async () => {
    const wire = geminiStreamGen('G_STREAM_ANSWERED_01');
    const harness = hookHarness(async () => new Response(wire));
    const batchUrl = 'https://gemini.google.com/_/BardChatUi/data/batchexecute';
    for (const url of [batchUrl, harness.url]) {
        if (transport === 'fetch') {
            await (await harness.win.fetch(url)).text(); await settleHook();
        } else {
            const xhr = new harness.Xhr(); (xhr.open as Function)('POST', url);
            xhr.responseText = wire; xhr.send(); xhr.emit('load'); xhr.emit('loadend');
        }
        assert.equal(harness.complete().length, url === batchUrl ? 0 : 1);
    }
    assert.equal(harness.messages.filter(message => message.type === 'GEMINI_NETWORK_BATCHEXECUTE').length, 0);
});

test('Fetch: normalized URL is reused for routing, account ownership and credentials', async () => {
    const harness = hookHarness(async () => new Response(geminiStreamGen('G_STREAM_EMPTY_HTTP_01')));
    const url = new URL('https://gemini.google.com/u/1/_/BardChatUi/data/batchexecute?f.sid=session&at=token');
    let conversions = 0;
    url.toString = () => { conversions++; return url.href; };
    await harness.win.fetch(url);
    await settleHook();
    const credentials = harness.messages.filter(message => message.type === 'GEMINI_CREDENTIALS');
    assert.equal(credentials.length, 1);
    assert.equal(credentials[0].payload.accountSlot, 'u1');
    assert.equal(conversions, 1);
});

test('XHR: credential ownership uses the URL snapshot captured at open', () => {
    const harness = hookHarness(async () => new Response(geminiStreamGen('G_STREAM_EMPTY_HTTP_01')));
    const xhr = new harness.Xhr();
    const url = new URL('https://gemini.google.com/u/1/_/BardChatUi/data/batchexecute?f.sid=session&at=token');
    (xhr.open as Function)('POST', url);
    url.pathname = url.pathname.replace('/u/1/', '/u/2/');
    url.searchParams.set('at', 'later-token');
    xhr.send();
    const credentials = harness.messages.filter(message => message.type === 'GEMINI_CREDENTIALS');
    assert.equal(credentials.length, 1);
    assert.equal(credentials[0].payload.accountSlot, 'u1');
    assert.equal(credentials[0].payload.at, 'token');
});

test('Account requests: only same-window, same-origin messages with bounded string ids are answered', () => {
    const harness = hookHarness(async () => new Response(geminiStreamGen('G_STREAM_EMPTY_HTTP_01')));
    const origin = 'https://gemini.google.com';
    const before = harness.messages.length;
    const dispatch = (data: unknown, source: unknown = harness.win, messageOrigin = origin) => {
        const event = new Event('message');
        Object.defineProperties(event, { data: { value: data }, source: { value: source }, origin: { value: messageOrigin } });
        harness.win.dispatchEvent(event);
    };
    const valid = { type: 'GEMINI_ACCOUNT_REQUESTED', payload: { requestId: 'request-1' } };
    dispatch(valid, {});
    dispatch(valid, harness.win, 'https://example.com');
    for (const data of [null, false, 7, 'message', [], {}, { type: 'other', payload: valid.payload },
        { type: valid.type }, { type: valid.type, payload: null }, { type: valid.type, payload: 'payload' },
        { type: valid.type, payload: {} }]) dispatch(data);
    for (const requestId of [null, false, 7, {}, [], '', 'x'.repeat(129)]) {
        dispatch({ type: valid.type, payload: { requestId } });
    }
    assert.equal(harness.messages.length, before);
    for (const requestId of ['request-1', 'x'.repeat(128)]) {
        dispatch({ type: valid.type, payload: { requestId } });
        assert.equal(harness.messages.at(-1).type, 'GEMINI_ACCOUNT_OBSERVED');
        assert.equal(harness.messages.at(-1).payload.requestId, requestId);
    }
    assert.equal(harness.messages.length, before + 2);
});

test('Fetch: borrowed receiver, native response and non-Error rejection retain their identity', async () => {
    const receiver = { owner: 'page-wrapper' };
    const response = new Response(geminiStreamGen('G_STREAM_EMPTY_HTTP_01'));
    const harness = hookHarness(function(this: unknown) {
        assert.equal(this, receiver);
        return Promise.resolve(response);
    });
    assert.equal(await harness.win.fetch.call(receiver, 'https://gemini.google.com/telemetry'), response);
    const rejection = { reason: 'native rejection' };
    const failed = hookHarness(async () => { throw rejection; });
    await assert.rejects(failed.win.fetch(failed.url), error => error === rejection);
    assert.equal(failed.complete().length, 0);
    assert.equal((failed.win as any).__geminiIsStreaming, false);
});

const {processSessionGen} = require('./fixtures/providers/geminiProcessSession.js');
const processWire = {partial: processSessionGen('partial'), answered: processSessionGen('complete')};
const processUrl = 'https://geminiweb-pa.clients6.google.com/v1/processSession';
test('processSession: XHR progress completes before channel EOF, exactly once across replay', () => {
    const h = hookHarness(async () => new Response(geminiStreamGen('G_STREAM_EMPTY_HTTP_01')));
    const xhr = new h.Xhr();
    (xhr.open as Function)('GET', processUrl); xhr.send();
    const wire = processWire.partial + processWire.answered;
    for (let i = 1; i <= wire.length; i++) {
        xhr.responseText = wire.slice(0, i); xhr.emit('progress');
        assert.equal(h.complete().length, i === wire.length ? 1 : 0);
    }
    assert.equal(h.complete()[0].payload.id, 'abcdef123456');
    xhr.responseText += processWire.answered; xhr.emit('progress'); xhr.emit('load');
    assert.equal(h.complete().length, 1);
});
for (const body of [processWire.partial, processSessionGen('answered'), processSessionGen('receipt'), processSessionGen('truncated'), processSessionGen('malformed'), processSessionGen('oversized')]) {
    test('processSession: partial or malformed protocol never completes: ' + body.slice(0, 12), async () => {
        const h = hookHarness(async () => new Response(body));
        await (await h.win.fetch(processUrl)).text(); await settleHook();
        assert.equal(h.complete().length, 0);
    });
}
test('processSession: fetch chunks use the same positive completion and reject HTTP errors', async () => {
    for (const status of [200, 429]) {
        const h = hookHarness(async () => new Response(processWire.answered, {status}));
        await (await h.win.fetch(processUrl)).text(); await settleHook();
        assert.equal(h.complete().length, status === 200 ? 1 : 0);
    }
});

test('processSession: final frame and answered candidate are independently required', async () => {
    for (const missing of ['missing-final', 'missing-answered', 'missing-identity']) {
        const h = hookHarness(async () => new Response(processSessionGen(missing)));
        await (await h.win.fetch(processUrl)).text(); await settleHook();
        assert.equal(h.complete().length, 0, missing);
    }
});

test('processSession: a fetch already aborted after headers cannot complete', async () => {
    const controller = new AbortController();
    const h = hookHarness(async () => { controller.abort(); return new Response(processWire.answered); });
    await (await h.win.fetch(processUrl, {signal: controller.signal})).text(); await settleHook();
    assert.equal(h.complete().length, 0);
});
