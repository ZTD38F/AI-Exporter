import type { Account } from '../../../l2/accountRegistry.js';
import { sniffUserProfileFromDom } from '../../parsers/gemini/dom/accountSniffer.js';
import { geminiAccountObservation } from '../../client/gemini/accountObservation.js';
import { CrossWorldEvents } from '../../protocol/gemini/protocol.js';
import type { GeminiCredentialsPayload } from '../../protocol/gemini/events.js';
import { createGeminiResponseRouter } from './responses/router.js';

declare global {
    interface Window {
        __geminiIsStreaming?: boolean;
        __geminiLastStreamStart?: number;
        __geminiActiveStreamConvId?: string;
        __geminiLastStreamComplete?: number;
        __gemExporterHookInstalled?: boolean;
    }
    interface XMLHttpRequest {
        __hookUrl?: string;
    }
}

(() => {
    if (window.__gemExporterHookInstalled) return;

    window.__gemExporterHookInstalled = true;
    const Events = CrossWorldEvents;

    // MAIN-world discovery can read Wiz globals; the isolated content script cannot.
    // Discovery is independent of whether Gemini has sent a credential-bearing RPC.
    let publishedAccount: string | undefined;
    const publishAccount = (requestId?: string) => {
        const observation = geminiAccountObservation(sniffUserProfileFromDom());
        const slot = getSlotFromUrl(location.href);
        const signature = JSON.stringify([slot, observation]);
        if (requestId === undefined && signature === publishedAccount) return;
        if (requestId === undefined) publishedAccount = signature;
        window.postMessage({ type: Events.ACCOUNT_OBSERVED,
            payload: { observation, slot, ...(requestId ? { requestId } : {}) } }, location.origin);
    };
    publishAccount();
    document.addEventListener('DOMContentLoaded', () => publishAccount(), { once: true });
    window.addEventListener('load', () => publishAccount(), { once: true });
    window.addEventListener('pageshow', () => publishAccount());
    window.addEventListener('popstate', () => publishAccount());
    // WIZ can change without navigation or a credential-bearing request.
    // Publish only changed stable identity/profile evidence, including loss of Gaia.
    window.setInterval(() => publishAccount(), 1000);
    window.addEventListener('message', (event: MessageEvent) => {
        const raw: unknown = event.data;
        if (event.source !== window || event.origin !== location.origin || !raw || typeof raw !== 'object'
            || !('type' in raw) || raw.type !== Events.ACCOUNT_REQUESTED || !('payload' in raw)
            || !raw.payload || typeof raw.payload !== 'object' || !('requestId' in raw.payload)) return;
        const requestId: unknown = raw.payload.requestId;
        if (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128) publishAccount(requestId);
    });

    const routeResponse = createGeminiResponseRouter();
    const origFetch = window.fetch;
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    function isDev(): boolean {
        return Boolean(window.__gemExporterDevMode);
    }

    function toUrlString(url: string | URL | Request): string {
        if (!url) return '';
        const raw = typeof url === 'string' ? url
            : url instanceof Request ? url.url : url.toString();
        try { return new URL(raw, location.href).href; } catch { return raw; }
    }

    function captureFromUrl(u: string, body: string): void {
        try {
            if (!u.includes('batchexecute')) return;
            publishAccount();
            const rawAt = /[?&]at=(?<token>[^&]+)/.exec(u)?.groups?.token;
            const at = rawAt ? decodeURIComponent(rawAt) : new URLSearchParams(body).get('at') ?? '';
            const sidMatch = u.match(/[?&]f\.sid=([^&]+)/) || u.match(/f\.sid=([^&]+)/);
            const blMatch = u.match(/[?&]bl=([^&]+)/);
            if (at || sidMatch) {
                const slot = getSlotFromUrl(u);
                const payload: GeminiCredentialsPayload = {
                    at,
                    sid: sidMatch ? decodeURIComponent(sidMatch[1]) : '',
                    bl: blMatch ? decodeURIComponent(blMatch[1]) : '',
                    accountSlot: slot,
                    accountObservation: slot === getSlotFromUrl(location.href) ? geminiAccountObservation(sniffUserProfileFromDom()) ?? undefined : undefined,
                    lastUsed: Date.now(),
                    url: location.href
                };
                // broadcast, not a private channel; targetOrigin is locked to page origin.
                window.postMessage({
                    type: Events.CREDENTIALS,
                    payload
                }, location.origin);
            }
        } catch (e) {
            if (isDev()) console.debug('[GemExporter:hook]', e);
        }
    }

    function getSlotFromUrl(url: string): string {
        let slot = 'u0';
        const m = url.match(/\/u\/(\d+)\//);
        if (m && m[1]) slot = 'u' + m[1];
        else {
            const m2 = location.pathname.match(/\/u\/(\d+)(?:\/|$)/);
            if (m2 && m2[1]) slot = 'u' + m2[1];
        }
        return slot;
    }

    // Capture request ownership without decoding endpoint response semantics.
    function captureRequestAccount(url: string): Omit<Account, 'id'> | null {
        if (getSlotFromUrl(url) !== getSlotFromUrl(location.href)) return null;
        return geminiAccountObservation(sniffUserProfileFromDom());
    }

    async function readCappedText(response: Response, cap: number, progress?: (chunk: string) => void): Promise<{ text: string; truncated: boolean }> {
        const body = response.body;
        if (body) {
            const reader = body.getReader();
            const chunks: Uint8Array[] = [];
            const decoder = new TextDecoder();
            let received = 0;
            let truncated = false;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value && value.length) {
                        progress?.(decoder.decode(value, { stream: true }));
                        const room = cap - received;
                        if (room <= 0) { truncated = true; break; }
                        if (value.length > room) {
                            chunks.push(value.slice(0, room));
                            received += room;
                            truncated = true;
                            break;
                        }
                        chunks.push(value);
                        received += value.length;
                    }
                }
            } finally {
                try {
                    if (truncated) void reader.cancel().catch(() => {});
                } catch { /* best effort */ }
                try { reader.releaseLock(); } catch { /* best effort */ }
            }
            const merged = new Uint8Array(received);
            let off = 0;
            for (const c of chunks) { merged.set(c, off); off += c.length; }
            const decoded = new TextDecoder().decode(merged);
            return { text: decoded, truncated };
        }
        const txt = await response.text();
        return txt.length > cap ? { text: txt.slice(0, cap), truncated: true } : { text: txt, truncated: false };
    }

    window.fetch = async function(
        this: unknown,
        input: RequestInfo | URL,
        init?: RequestInit
    ): Promise<Response> {
        const requestedAt = Date.now();
        const url = toUrlString(input);
        const endpoint = routeResponse(url);
        const handler = endpoint?.({ url, slot: getSlotFromUrl(url), pagePath: location.pathname,
            requestedAt, requestAccountObservation: captureRequestAccount(url) });
        const request = input instanceof Request ? input : undefined;
        const body = (init && init.body) || request?.body;
        const requestBody = typeof body === 'string' ? body
            : body instanceof URLSearchParams ? body.toString() : '';
        let capturedBody = Promise.resolve(requestBody);
        if (typeof body !== 'string' && request && handler) {
            try { capturedBody = request.clone().text().catch(() => ''); } catch { /* metadata unavailable */ }
        }

        try {
            captureFromUrl(url, requestBody);
            handler?.start(requestBody);
        } catch (e) {
            if (isDev()) console.debug('[GemExporter:hook]', e);
        }

        let response: Response;
        try { response = await origFetch.call(this, input, init); }
        catch (error) {
            handler?.end();
            throw error;
        }

        if (handler) {
            const selected = handler;
            try {
                void readCappedText(response.clone(), selected.captureLimit, selected.progress ? chunk => {
                    if (response.ok && !init?.signal?.aborted && !request?.signal.aborted) selected.progress?.(chunk);
                } : undefined).then(async ({ text, truncated }) => {
                    const aborted = init?.signal?.aborted
                        || request?.signal.aborted;
                    selected.complete(await capturedBody, text, truncated || !!aborted, response.ok);
                }).catch((error: unknown) => {
                    if (isDev()) console.debug('[GemExporter:hook]', error);
                }).finally(() => selected.end());
            } catch { selected.end(); }
        }

        return response;
    };


    type XhrOpenArgs =
        | [method: string, url: string | URL]
        | [method: string, url: string | URL, async: boolean, username?: string | null, password?: string | null];
    const hookedOpen = function(this: XMLHttpRequest, ...args: XhrOpenArgs): void {
        try {
            this.__hookUrl = toUrlString(args[1]);
        } catch (e) {
            if (isDev()) console.debug('[GemExporter:hook]', e);
        }
        Reflect.apply(origOpen, this, args);
    };
    XMLHttpRequest.prototype.open = hookedOpen;

    XMLHttpRequest.prototype.send = function(this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>): void {
        let cancelStream = () => {};
        try {
            const sourceUrl = this.__hookUrl ?? '';
            const body = args[0];
            const requestedAt = Date.now();
            const endpoint = routeResponse(sourceUrl);
            const handler = endpoint?.({ url: sourceUrl, slot: getSlotFromUrl(sourceUrl), pagePath: location.pathname,
                requestedAt, requestAccountObservation: captureRequestAccount(sourceUrl) });
            const requestBody = typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : '';
            captureFromUrl(sourceUrl, requestBody);
            if (handler) {
                const selected = handler;
                selected.start(requestBody);
                let ended = false;
                let offset = 0;
                const progress = () => {
                    if (this.status < 200 || this.status >= 300 || !selected.progress) return;
                    const text = this.responseText;
                    selected.progress(text.slice(offset));
                    offset = text.length;
                };
                this.addEventListener('progress', progress);
                const handleEnd = (event: Event) => {
                    if (ended) return;
                    ended = true;
                    this.removeEventListener('progress', progress);
                    for (const name of ['load', 'loadend', 'abort', 'error', 'timeout']) this.removeEventListener(name, handleEnd);
                    try {
                        if (event.type === 'load') {
                            progress();
                            const text = this.responseText;
                            selected.complete(requestBody, text.slice(0, selected.captureLimit), text.length > selected.captureLimit,
                                this.status >= 200 && this.status < 300);
                        }
                    } catch (error) { if (isDev()) console.debug('[GemExporter:hook]', error); }
                    finally { selected.end(); }
                };
                for (const name of ['load', 'loadend', 'abort', 'error', 'timeout']) this.addEventListener(name, handleEnd);
                cancelStream = () => handleEnd(new Event('error'));
            }
        } catch (e) {
            if (isDev()) console.debug('[GemExporter:hook]', e);
        }
        try { origSend.apply(this, args); }
        catch (error) { cancelStream(); throw error; }
    };

    if (isDev()) console.log('[Gemini Exporter] MAIN world credentials hook initialized');

})();

export {};
