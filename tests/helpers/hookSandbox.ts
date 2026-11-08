import vm from 'node:vm';
import * as protocol from '../../src/l1/protocol/gemini/protocol.js';
import { geminiAccountObservation } from '../../src/l1/client/gemini/accountObservation.js';
import { parseGeminiRequest } from '../../src/l1/parsers/gemini/rpc/request.js';
import { parseConfirmedGeminiDeletion } from '../../src/l1/parsers/gemini/rpc/parseDeletion.js';
import type { sniffUserProfileFromDom } from '../../src/l1/parsers/gemini/dom/accountSniffer.js';

/** Real MAIN Hook and pure decoders; only browser IO/profile discovery is substituted. */
export function createHookSandbox(sniffProfile?: typeof sniffUserProfileFromDom) {
    const posted: { msg: { type: string; payload: Record<string, unknown> }; origin: string }[] = [];
    const win = {
        __nextResponseText: '',
        postMessage(msg: (typeof posted)[number]['msg'], origin: string) { posted.push({ msg, origin }); },
        addEventListener() {}, setInterval() { return 0; },
        async fetch(_input?: unknown, _init?: RequestInit) { return new Response(win.__nextResponseText); },
    };
    class MockXhr { open(_method: string, _url: string) {} send(_body?: XMLHttpRequestBodyInit | Document | null) {} addEventListener() {} }
    const script = require('./bundleGeminiHook.cjs')();
    vm.runInNewContext(script, { window: win,
        location: { origin: 'https://gemini.google.com', href: 'https://gemini.google.com/app', pathname: '/app' },
        document: { querySelectorAll: () => [], addEventListener() {} },
        console, URL, URLSearchParams, Request, Response, TextEncoder, TextDecoder, Uint8Array, XMLHttpRequest: MockXhr,
        GeminiProtocol: protocol.GeminiProtocol, CrossWorldEvents: protocol.CrossWorldEvents,
        sniffUserProfileFromDom: sniffProfile ?? (() => ({ gaiaId: '10000000001' })),
        geminiAccountObservation, parseGeminiRequest, parseConfirmedGeminiDeletion,
    });
    posted.length = 0;
    return { posted, win, Xhr: MockXhr };
}
