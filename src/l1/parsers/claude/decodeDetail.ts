import { claudeTimestamp } from './parseList.js';
import { record } from './toolValues.js';

/** Verified Claude wire fields. Individual tool schemas are decoded by parseTools. */
export interface ClaudeSourceFile {
    name: string;
    fileName?: string;
    extractedContent?: string;
    fileId?: string;
    success: boolean;
    fileKind?: string;
    downloadSource?: string;
    sizeBytes?: number;
}

export type ClaudeResultPart =
    | { kind: 'text'; text: string }
    | { kind: 'knowledge'; title: string; url?: string; text?: string; isMissing: boolean }
    | { kind: 'unsupported'; sourceType: string };

export interface ClaudeToolUse {
    name: string;
    input: Record<string, unknown> | null;
}
export interface ClaudeToolResult {
    name: string;
    isError: boolean;
    references: string[];
    parts: ClaudeResultPart[] | null;
}
export type ClaudeContentBlock =
    | { kind: 'text'; text: string }
    | { kind: 'thinking'; thinking: string }
    | ({ kind: 'tool_use' } & ClaudeToolUse)
    | ({ kind: 'tool_result' } & ClaudeToolResult)
    | { kind: 'redacted_thinking' }
    | { kind: 'invalid' }
    | { kind: 'unsupported'; sourceType: string };

export interface ClaudeSourceMessage {
    uuid: string;
    sender: 'human' | 'assistant' | null;
    /** Null is an absent/root parent; undefined signals an invalid parent. */
    parentId: string | null | undefined;
    sortIndex: number;
    createdAt?: number;
    model?: string;
    truncated: boolean;
    stopReason?: string;
    text?: string;
    content: ClaudeContentBlock[] | null;
    attachments: Array<ClaudeSourceFile | null>;
    files: Array<ClaudeSourceFile | null>;
}
export interface ClaudeDetailEvidence {
    messages: ClaudeSourceMessage[];
    currentLeafId: string | null;
    model?: string;
    name?: string;
    createdAt?: number;
    updatedAt?: number;
}

const ROOT_ID = '00000000-0000-4000-8000-000000000000';
function uuid(value: unknown): value is string {
    return typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
}
function text(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}
function decodeFile(raw: unknown): ClaudeSourceFile | null {
    const source = record(raw);
    if (!source) return null;
    const fileId = source.file_uuid ?? source.uuid;
    const name = text(source.file_name) ?? text(source.name) ?? 'attachment';
    return {
        name,
        ...(text(source.file_name) !== undefined ? { fileName: text(source.file_name) } : {}),
        ...(text(source.extracted_content) !== undefined ? { extractedContent: text(source.extracted_content) } : {}),
        ...(uuid(fileId) ? { fileId } : {}),
        success: source.success === true,
        ...(text(source.file_kind) !== undefined ? { fileKind: text(source.file_kind) } : {}),
        ...(text(source.download_source) !== undefined ? { downloadSource: text(source.download_source) } : {}),
        ...(typeof source.size_bytes === 'number' && Number.isSafeInteger(source.size_bytes)
            && source.size_bytes >= 0 ? { sizeBytes: source.size_bytes } : {}),
    };
}
function decodeResultPart(raw: unknown): ClaudeResultPart {
    const source = record(raw);
    if (source?.type === 'text' && typeof source.text === 'string')
        return { kind: 'text', text: source.text };
    if (source?.type === 'knowledge' && typeof source.title === 'string') {
        return { kind: 'knowledge', title: source.title,
            ...(text(source.url) !== undefined ? { url: text(source.url) } : {}),
            ...(text(source.text) !== undefined ? { text: text(source.text) } : {}),
            isMissing: source.is_missing === true };
    }
    return { kind: 'unsupported', sourceType: String(source?.type ?? 'unknown') };
}
function decodeBlock(raw: unknown): ClaudeContentBlock {
    const source = record(raw);
    if (!source) return { kind: 'invalid' };
    if (source.type === 'text' && typeof source.text === 'string')
        return { kind: 'text', text: source.text };
    if (source.type === 'thinking' && typeof source.thinking === 'string')
        return { kind: 'thinking', thinking: source.thinking };
    if (source.type === 'tool_use') {
        return { kind: 'tool_use', name: text(source.name) ?? '', input: record(source.input) };
    }
    if (source.type === 'tool_result') {
        const rawParts = typeof source.content === 'string'
            ? [{ type: 'text', text: source.content }] : source.content;
        const meta = record(source.meta);
        const references = Array.isArray(meta?.tool_references)
            ? meta.tool_references.filter((value): value is string => typeof value === 'string') : [];
        return { kind: 'tool_result', name: text(source.name) ?? '',
            isError: source.is_error === true, references,
            parts: Array.isArray(rawParts) ? rawParts.map((part: unknown) => decodeResultPart(part)) : null };
    }
    if (source.type === 'redacted_thinking') return { kind: 'redacted_thinking' };
    return { kind: 'unsupported', sourceType: String(source.type) };
}
function decodeMessage(raw: unknown): ClaudeSourceMessage {
    const source = record(raw);
    if (!source || !uuid(source.uuid)) throw new TypeError('Invalid Claude message tree');
    const parent = source.parent_message_uuid;
    const parentId = parent == null || parent === ROOT_ID ? null : uuid(parent) ? parent : undefined;
    const createdAt = claudeTimestamp(source.created_at);
    const model = text(source.model);
    return {
        uuid: source.uuid,
        sender: source.sender === 'human' || source.sender === 'assistant' ? source.sender : null,
        parentId, sortIndex: Number(source.index ?? 0),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(model?.trim() ? { model } : {}),
        truncated: source.truncated === true,
        ...(text(source.stop_reason) !== undefined ? { stopReason: text(source.stop_reason) } : {}),
        ...(text(source.text) !== undefined ? { text: text(source.text) } : {}),
        content: Array.isArray(source.content) ? source.content.map((part: unknown) => decodeBlock(part)) : null,
        attachments: Array.isArray(source.attachments) ? source.attachments.map((file: unknown) => decodeFile(file)) : [],
        files: Array.isArray(source.files) ? source.files.map((file: unknown) => decodeFile(file)) : [],
    };
}

/** Sole Claude Detail ingress: validate IDs and normalize fields before branch/tool processing. */
export function decodeClaudeDetail(raw: unknown, requestedId: string): ClaudeDetailEvidence {
    const source = record(raw);
    if (!source || !uuid(requestedId) || source.uuid !== undefined && source.uuid !== requestedId)
        throw new TypeError('Claude detail identity mismatch');
    if (!Array.isArray(source.chat_messages)) throw new TypeError('Claude detail has no chat_messages');
    const createdAt = claudeTimestamp(source.created_at), updatedAt = claudeTimestamp(source.updated_at);
    const model = text(source.model);
    return {
        messages: source.chat_messages.map((message: unknown) => decodeMessage(message)),
        currentLeafId: uuid(source.current_leaf_message_uuid) ? source.current_leaf_message_uuid : null,
        ...(model?.trim() ? { model } : {}),
        ...(text(source.name) !== undefined ? { name: text(source.name) } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
    };
}
