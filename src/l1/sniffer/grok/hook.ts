import { GROK_SOURCE_EVENT, grokRequest } from './observation.js';
import { grokAccount } from '../../parsers/grok/source.js';

/** Only completed native reads trigger acquisition. Request identity is checked at both ends. */
export function installGrokHook(): void {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href).href;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const request = grokRequest(url, method);
        const identity = async () => {
            const response = await nativeFetch('/rest/auth/get-user', { credentials: 'include' });
            if (!response.ok) throw new Error('Grok identity unavailable');
            return grokAccount(await response.json()).providerAccountId;
        };
        // Start before the native request. Never delay or reject the website's request for capture.
        const owner = request ? identity().catch(() => null) : Promise.resolve(null);
        const response = await nativeFetch(input, init);
        if (!request || !response.ok) return response;
        const copy = response.clone();
        void (async () => {
            const captured = await owner;
            if (!captured) return;
            const reader = copy.body?.getReader();
            if (!reader) return;
            const decoder = new TextDecoder(); let text = '', bytes = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    bytes += value.byteLength;
                    if (bytes > 16 * 1024 * 1024) return;
                    if (request.kind === 'list') text += decoder.decode(value, { stream: true });
                }
                text += decoder.decode();
            } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
            if (await identity() !== captured) return;
            window.postMessage({ type: GROK_SOURCE_EVENT, payload: { url, method, owner: captured,
                status: response.status, responseBody: request.kind === 'list' ? JSON.parse(text) : null } }, location.origin);
        })().catch(error => console.debug('[Grok source]', error));
        return response;
    };
}
installGrokHook();
