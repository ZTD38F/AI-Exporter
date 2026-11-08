import { chatgptAccountObservation } from '../../client/chatgpt/accountObservation.js';

export const CHATGPT_SOURCE_EVENT = 'gemini-exporter:chatgpt-source-v1';
export const chatGPTConversationId = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

export function chatGPTRequest(url: string, method: string): { kind: 'list' | 'detail' | 'stream' | 'delete'; conversationId?: string; method?: 'DELETE' } | null {
    const source = new URL(url);
    if (source.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(source.hostname)) return null;
    if (method === 'GET' && source.pathname === '/backend-api/conversations') return { kind: 'list' };
    const deletion = /^\/backend-api\/conversation\/id\/([a-f0-9-]+)$/.exec(source.pathname);
    if (method === 'DELETE' && deletion && chatGPTConversationId(deletion[1])) return {kind:'delete',conversationId:deletion[1],method:'DELETE'};
    const match = /^\/backend-api\/(f\/)?conversation(?:\/([a-f0-9-]+))?$/.exec(source.pathname);
    if (!match) return null;
    if (match[2] && !chatGPTConversationId(match[2])) return null;
    if (method === 'GET' && match[2] && !match[1]) return { kind: 'detail', conversationId: match[2] };
    if (method === 'PATCH' && match[2] && !match[1]) return { kind: 'delete', conversationId: match[2] };
    if (method === 'POST' && !match[2]) return { kind: 'stream' };
    return null;
}

/** Request-bound acknowledgement, never a sidebar/URL disappearance heuristic. */
export function confirmedChatGPTDeletion(requestBody: unknown, responseBody: unknown, method = 'PATCH'): boolean {
    if (method === 'DELETE') return !!responseBody && typeof responseBody === 'object' && !Array.isArray(responseBody) && Reflect.get(responseBody, 'success') === true;
    if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)
        || !responseBody || typeof responseBody !== 'object' || Array.isArray(responseBody)) return false;
    return Reflect.get(requestBody, 'is_visible') === false && Reflect.get(responseBody, 'success') === true;
}

export function chatGPTObservedIdentity(session: unknown): string | null {
    return chatgptAccountObservation(session)?.providerAccountId ?? null;
}


/** SSE completion is explicit: providers may keep the HTTP stream open after [DONE]. */
export function chatGPTStreamEvent(line: string): { done: boolean; conversationId?: string } {
    if (!line.startsWith('data:')) return { done: false };
    const data = line.slice(5).trim();
    if (data === '[DONE]') return { done: true };
    try {
        const event: unknown = JSON.parse(data);
        if (!event || typeof event !== 'object' || Array.isArray(event)) return { done: false };
        const direct = Reflect.get(event, 'conversation_id');
        const value: unknown = Reflect.get(event, 'v');
        const nested = value && typeof value === 'object' && !Array.isArray(value) ? Reflect.get(value, 'conversation_id') : undefined;
        const id = chatGPTConversationId(direct) ? direct : chatGPTConversationId(nested) ? nested : undefined;
        return { done: false, ...(id ? { conversationId: id } : {}) };
    } catch { return { done: false }; }
}
