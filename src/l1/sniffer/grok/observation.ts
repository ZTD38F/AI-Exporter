import { grokUuid } from '../../parsers/grok/source.js';
export const GROK_SOURCE_EVENT = 'gemini-exporter:grok-source-v1';
export function grokRequest(url: string, method: string) {
    let source: URL;
    try { source = new URL(url); } catch { return null; }
    if (source.origin !== 'https://grok.com') return null;
    const match = source.pathname.match(/^\/rest\/app-chat\/conversations(?:_v2)?(?:\/([^/]+))?(?:\/(response-node|load-responses|responses))?$/);
    if (!match || match[1] && !grokUuid(match[1])) return null;
    const kind = method === 'GET' && !match[1] ? 'list'
        : method === 'DELETE' && match[1] && !match[2] ? 'delete'
            : match[1] && (method === 'POST' && ['load-responses', 'responses'].includes(match[2])
                || method === 'GET' && match[2] === 'response-node') ? 'refresh' : null;
    return kind ? { kind, conversationId: match[1] } : null;
}
