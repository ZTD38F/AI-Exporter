/**
 * src/types/messages.ts
 * Centralized Schema for Chrome extension runtime and tab messages.
 */

import type { Conversation, Attachment } from './conversation.js';

export type MessageAction =
    | 'syncUpdate'
    | 'scanProgress'
    | 'openOptions'
    | 'getConversationDetail'
    | 'fetchBatch'
    | 'cancelExport'
    | 'downloadAssetDirect'
    | 'abortSync'
    | 'deepScan'
    | 'stopDeepScan'
    | 'exportProgress'
    | 'ping'
    | 'openGeminiPage'
    | 'reloadGeminiTab'
    | 'startExport'
    | 'liveSaveViaHandle';

export interface BaseMessage {
    action: MessageAction;
    [key: string]: any;
}

export interface SyncUpdateMessage extends BaseMessage {
    action: 'syncUpdate';
    slot: string;
    count?: number;
    from?: string;
    conversations?: Conversation[];
}

export interface ScanProgressMessage extends BaseMessage {
    action: 'scanProgress';
    slot?: string;
    scanned?: number;
    total?: number;
    status?: string;
    stoppedEarly?: boolean;
}

export interface DownloadAssetDirectMessage extends BaseMessage {
    action: 'downloadAssetDirect';
    url: string;
    referer?: string;
    preferBuffer?: boolean;
    timeoutMs?: number;
}

export interface DownloadAssetResponse {
    success: boolean;
    dataBuffer?: ArrayBuffer | ArrayBufferView;
    blobBuffer?: ArrayBuffer | ArrayBufferView;
    dataBase64?: string;
    blobBase64?: string;
    mime?: string;
    contentType?: string;
    size?: number;
    finalUrl?: string;
    error?: string;
}

export interface GetConversationDetailMessage extends BaseMessage {
    action: 'getConversationDetail';
    conversationId: string;
    accountSlot?: string;
}

export interface CancelExportMessage extends BaseMessage {
    action: 'cancelExport';
}

export interface ExportProgressMessage extends BaseMessage {
    action: 'exportProgress';
    pct?: number;
    current?: number;
    total?: number;
    title?: string;
    assetsDownloaded?: number;
    assetsTotal?: number;
}

export interface LiveSaveViaHandlePayload {
    chat: any;
    safeTitle: string;
    nid: string;
    config?: any;
    fileName?: string;
}

export interface LiveSaveViaHandleMessage extends BaseMessage {
    action: 'liveSaveViaHandle';
    payload: LiveSaveViaHandlePayload;
    accountSlot?: string;
}

