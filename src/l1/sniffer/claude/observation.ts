export const CLAUDE_SOURCE_EVENT = 'gemini-exporter:claude-source-v1';
export const claudeUuid = (value: string | null | undefined): value is string => value != null
    && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
export function claudeRequest(url: string, method: string) {
    const source = new URL(url);
    if (source.origin !== 'https://claude.ai') return null;
    const match = source.pathname.match(/^\/api\/organizations\/([^/]+)\/chat_conversations(?:_v2)?(?:\/([^/]+))?(?:\/((?:retry_)?completion2?))?$/);
    if (!match || !claudeUuid(match[1]) || match[2] && !claudeUuid(match[2])) return null;
    const kind = method === 'GET' && !match[3] ? (match[2] ? 'detail' : 'list')
        : method === 'DELETE' && match[2] && !match[3] ? 'delete'
            : method === 'POST' && match[2] && match[3] ? 'stream' : null;
    return kind ? { kind, organization: match[1], conversationId: match[2] } : null;
}
export function activeClaudeOrganization(cookie: string): string | null {
    try {
        const value = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('lastActiveOrg='))?.slice(14);
        const id = value ? decodeURIComponent(value) : null;
        return claudeUuid(id) ? id : null;
    } catch { return null; }
}
