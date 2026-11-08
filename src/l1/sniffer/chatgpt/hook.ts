import { chatGPTRequest, CHATGPT_SOURCE_EVENT, chatGPTObservedIdentity, chatGPTConversationId, chatGPTStreamEvent } from './observation.js';
import { installChatGPTSidebarCapture } from './sidebar.js';

/** MAIN-world acquisition only. Tokens never cross the world/message boundary. */
export function installChatGPTHook(): void {
    const original = window.fetch;
    const nativeFetch = original.bind(window);
    const identity = async (): Promise<string | null> => {
        try {
            const response = await nativeFetch('/api/auth/session', { credentials: 'include' });
            return response.ok ? chatGPTObservedIdentity(await response.json()) : null;
        } catch { return null; }
    };
    // The current site embeds the initial history in router loader data; no
    // /conversations fetch occurs for that first sidebar page.
    if (typeof document !== 'undefined') installChatGPTSidebarCapture(identity,
        payload => window.postMessage({ type: CHATGPT_SOURCE_EVENT, payload }, location.origin));
    window.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href).href;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const request = chatGPTRequest(url, method);
        if (!request) return nativeFetch(input, init);
        const requestIdentity = await identity();
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        const workspace = headers.get('ChatGPT-Account-ID');
        const identityMatchesWorkspace = !workspace || !!requestIdentity && JSON.parse(requestIdentity)[1] === workspace;
        let body: unknown;
        try {
            const text = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : '';
            body = text ? JSON.parse(text) : null;
        } catch { body = null; }
        const response = await nativeFetch(input, init);
        if (response.ok && requestIdentity && identityMatchesWorkspace) {
            const copy = response.clone();
            void (async () => {
                let responseBody: unknown, conversationId = request.conversationId;
                if (request.kind === 'stream') {
                    const reader = copy.body?.getReader();
                    if (!reader) return;
                    let pending = '', bytes = 0, completed = false;
                    const decoder = new TextDecoder();
                    try {
                        for (;;) {
                            const { done, value } = await reader.read();
                            if (done) {
                                const event = chatGPTStreamEvent(pending);
                                if (event.conversationId) conversationId = event.conversationId;
                                completed = event.done;
                                break;
                            }
                            bytes += value.byteLength;
                            if (bytes > 16 * 1024 * 1024) { void reader.cancel().catch(() => {}); return; }
                            pending += decoder.decode(value, { stream: true });
                            const lines = pending.split('\n'); pending = lines.pop() ?? '';
                            for (const line of lines) {
                                const event = chatGPTStreamEvent(line);
                                if (event.conversationId) conversationId = event.conversationId;
                                if (event.done) { completed = true; break; }
                            }
                            if (completed) {
                                // Never await tee cancellation: its other branch is owned by ChatGPT.
                                void reader.cancel().catch(() => {});
                                break;
                            }
                        }
                    } finally { reader.releaseLock(); }
                    if (!completed) return;
                    responseBody = null;
                    if (!conversationId && body && typeof body === 'object' && 'conversation_id' in body && chatGPTConversationId(body.conversation_id)) conversationId = body.conversation_id;
                } else {
                    const text = await copy.text();
                    if (text.length > 8 * 1024 * 1024) return;
                    responseBody = JSON.parse(text);
                }
                if ((request.kind !== 'list' && !conversationId) || await identity() !== requestIdentity) return;
                window.postMessage({ type: CHATGPT_SOURCE_EVENT, payload: { ...request, conversationId,
                    requestIdentity, url, requestBody: request.kind === 'delete' ? body : null, responseBody } }, location.origin);
            })().catch(error => console.debug('[ChatGPT source]', error));
        }
        return response;
    };
}

installChatGPTHook();
