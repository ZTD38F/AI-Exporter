const PREFIX = 'chatgpt-sandbox:';

export function chatGPTSandboxPath(uri: string): string | null {
    if (!uri.startsWith('sandbox:/mnt/data/')) return null;
    try { return decodeURIComponent(uri.slice('sandbox:'.length)); }
    catch { return null; }
}

export function chatGPTSandboxLocator(messageId: string, path: string): string {
    return PREFIX + new URLSearchParams({ message_id: messageId, sandbox_path: path });
}

export function readChatGPTSandboxLocator(uri: string): { messageId: string; path: string } | null {
    if (!uri.startsWith(PREFIX)) return null;
    const query = new URLSearchParams(uri.slice(PREFIX.length));
    const messageId = query.get('message_id'), path = query.get('sandbox_path');
    return messageId && path?.startsWith('/mnt/data/') && query.getAll('message_id').length === 1
        && query.getAll('sandbox_path').length === 1 ? { messageId, path } : null;
}
