import { grokObject, grokTimestamp, grokUuid } from './source.js';
export function parseGrokList(raw: unknown) {
    const data = grokObject(raw);
    if (!Array.isArray(data.conversations)) throw new TypeError('Invalid Grok conversation list');
    const nextPageToken = data.nextPageToken;
    if (nextPageToken !== undefined && (typeof nextPageToken !== 'string'
        || nextPageToken && !grokUuid(nextPageToken))) throw new TypeError('Invalid Grok page token');
    const seen = new Set<string>();
    const conversations = data.conversations.map(value => {
        const row = grokObject(value);
        if (!grokUuid(row.conversationId) || seen.has(row.conversationId)) throw new TypeError('Invalid or duplicate Grok conversation');
        seen.add(row.conversationId);
        const updatedAt = grokTimestamp(row.modifyTime), createdAt = grokTimestamp(row.createTime);
        if (updatedAt === undefined) throw new TypeError('Missing Grok activity timestamp');
        return { id: row.conversationId, updatedAt, ...(createdAt !== undefined ? { createdAt } : {}),
            ...(typeof row.title === 'string' && row.title.trim() ? { title: row.title.trim(), titleSource: 'provider' as const } : {}) };
    });
    return { conversations, keys: conversations.map(row => ({ id: row.id, time: row.updatedAt })),
        nextCursor: nextPageToken || null };
}
