/**
 * ChatGPT image-asset resolution, ported from pionxzh/chatgpt-exporter (MIT).
 * Chain: `sediment://<fileId>` -> `GET /backend-api/files/download/:id`
 * -> signed estuary `download_url` -> bytes -> base64 Domain asset.
 * @unverified-provider-scaffold Verified live via 9222 (2.1MB PNG, 2026-10-14).
 */

interface ChatGPTParsedDownload {
    downloadUrl: string;
    fileName?: string;
    byteLength?: number;
    mimeType?: string;
}

export function fileIdFromPointer(pointer: string): string | null {
    const prefix = ['sediment://', 'file-service://'].find(prefix => pointer.startsWith(prefix));
    if (!prefix) return null;
    const id = pointer.slice(prefix.length);
    return id ? id : null;
}

export function buildFileDownloadPath(fileId: string, conversationId: string): string {
    // File access can depend on the conversation scope, including Project uploads.
    // The native frontend maps composite image separators to stars before routing.
    const query = new URLSearchParams({ conversation_id: conversationId, inline: 'false', download_intent: 'true' });
    return `/files/download/${encodeURIComponent(fileId.replaceAll('#', '*'))}?${query}`;
}

export function buildAttachmentDownloadPath(fileId: string, conversationId: string): string {
    return `/conversation/${encodeURIComponent(conversationId)}/attachment/${encodeURIComponent(fileId)}/download`;
}

export function buildSandboxDownloadPath(conversationId: string, messageId: string, path: string): string {
    const query = new URLSearchParams({ message_id: messageId, sandbox_path: path, download_intent: 'true' });
    return `/conversation/${encodeURIComponent(conversationId)}/interpreter/download?${query}`;
}

/** Both native download exchanges return a signed URL; status may be omitted. */
export function parseFileDownloadPayload(value: unknown): ChatGPTParsedDownload | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if ('status' in value && value.status !== 'success') return null;
    const downloadUrl = 'download_url' in value ? value.download_url : undefined;
    if (typeof downloadUrl !== 'string' || !downloadUrl) return null;
    const parsed: ChatGPTParsedDownload = { downloadUrl };
    if ('file_name' in value && typeof value.file_name === 'string' && value.file_name) {
        parsed.fileName = value.file_name;
    }
    if ('file_size_bytes' in value && typeof value.file_size_bytes === 'number' && Number.isFinite(value.file_size_bytes)) {
        parsed.byteLength = Math.round(value.file_size_bytes);
    }
    if ('mime_type' in value && typeof value.mime_type === 'string' && value.mime_type) {
        parsed.mimeType = value.mime_type;
    }
    return parsed;
}
