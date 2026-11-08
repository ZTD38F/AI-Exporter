import { CLAUDE_SOURCE_EVENT, claudeRequest, activeClaudeOrganization } from './observation.js';

/** Observe the site's own requests. Never issue identity/source polling requests. */
export function installClaudeHook(): void {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href).href;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const request = claudeRequest(url, method);
        const owner = activeClaudeOrganization(document.cookie);
        const response = await nativeFetch(input, init);
        if (!request || !owner || owner !== request.organization || !response.ok) return response;
        const copy = response.clone();
        void (async () => {
            let responseBody: unknown = null;
            if (request.kind === 'stream') {
                const reader = copy.body?.getReader();
                if (!reader) return;
                const decoder = new TextDecoder();
                let pending = '', bytes = 0, complete = false;
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        bytes += value.byteLength;
                        if (bytes > 16 * 1024 * 1024) break;
                        pending += decoder.decode(value, { stream: true });
                        const lines = pending.split('\n'); pending = lines.pop() ?? '';
                        for (const line of lines) {
                            if (!line.startsWith('data:')) continue;
                            try { if (JSON.parse(line.slice(5)).type === 'message_stop') complete = true; } catch { /* SSE framing */ }
                        }
                        if (complete) break;
                    }
                } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
                if (!complete) return;
            } else if (request.kind !== 'delete') {
                const text = await copy.text();
                if (text.length > 8 * 1024 * 1024) return;
                responseBody = JSON.parse(text);
            }
            if (activeClaudeOrganization(document.cookie) !== owner) return;
            window.postMessage({ type: CLAUDE_SOURCE_EVENT, payload: {
                ...request, url, method, responseBody, status: response.status,
            } }, location.origin);
        })().catch(error => console.debug('[Claude source]', error));
        return response;
    };
}
installClaudeHook();
