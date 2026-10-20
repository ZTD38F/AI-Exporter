import type { Conversation } from './conversation.js';
import type { LiveSaveConfig } from './liveSave.js';

export const MESSAGE_ACTIONS = {
    SYNC_UPDATE: 'syncUpdate',
    SCAN_PROGRESS: 'scanProgress',
    OPEN_OPTIONS: 'openOptions',
    GET_CONVERSATION_DETAIL: 'getConversationDetail',
    FETCH_BATCH: 'fetchBatch',
    FETCH_CHAT: 'fetchChat',
    CANCEL_EXPORT: 'cancelExport',
    DOWNLOAD_ASSET_DIRECT: 'downloadAssetDirect',
    ABORT_SYNC: 'abortSync',
    DEEP_SCAN: 'deepScan',
    STOP_DEEP_SCAN: 'stopDeepScan',
    EXPORT_PROGRESS: 'exportProgress',
    PING: 'ping',
    OPEN_GEMINI_PAGE: 'openGeminiPage',
    RELOAD_GEMINI_TAB: 'reloadGeminiTab',
    LIVE_SAVE_VIA_HANDLE: 'liveSaveViaHandle',
    GET_FILE_BLOB: 'getFileBlob',
    GET_IMAGE_BLOB: 'getImageBlob',
    GET_SCROLL_CONTAINER: 'getScrollContainer'
} as const;

export type MessageAction = typeof MESSAGE_ACTIONS[keyof typeof MESSAGE_ACTIONS];

export interface BaseMessage {
    action: MessageAction;
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
    targetSid?: string;
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

export interface LiveSaveAsset {
    fileName: string;
    subDir?: string;
    base64?: string;
}

export interface LiveSaveViaHandlePayload {
    chat: Conversation;
    safeTitle: string;
    nid: string;
    config?: LiveSaveConfig;
    fileName?: string;
    assets?: LiveSaveAsset[];
}

export interface LiveSaveViaHandleMessage extends BaseMessage {
    action: 'liveSaveViaHandle';
    payload: LiveSaveViaHandlePayload;
    accountSlot?: string;
}

export interface FetchChatMessage extends BaseMessage {
    action: 'fetchChat';
    conversationId: string;
    accountSlot?: string;
}

export interface GetFileBlobMessage extends BaseMessage {
    action: 'getFileBlob';
    url: string;
    token?: string;
}

export interface GetImageBlobMessage extends BaseMessage {
    action: 'getImageBlob';
    url: string;
}

export interface GetScrollContainerMessage extends BaseMessage {
    action: 'getScrollContainer';
}

export interface FetchBatchMessage extends BaseMessage {
    action: 'fetchBatch';
    ids?: (string | { id: string; title?: string; url?: string })[];
    format?: string;
    skipExported?: boolean;
    globalOffset?: number;
    globalTotal?: number;
    accountSlot?: string;
}

export interface AbortSyncMessage extends BaseMessage {
    // Kept for backward compatibility even though no direct UI sender currently exists
    action: 'abortSync';
    accountSlot?: string;
}

export interface DeepScanMessage extends BaseMessage {
    action: 'deepScan';
    mode?: 'incremental' | 'full' | 'auto';
    maxIter?: number;
    accountSlot?: string;
}

export interface StopDeepScanMessage extends BaseMessage {
    action: 'stopDeepScan';
    accountSlot?: string;
}

export interface PingMessage extends BaseMessage {
    action: 'ping';
}

export interface OpenOptionsMessage extends BaseMessage {
    action: 'openOptions';
}

export interface OpenGeminiPageMessage extends BaseMessage {
    action: 'openGeminiPage';
}

export interface ReloadGeminiTabMessage extends BaseMessage {
    action: 'reloadGeminiTab';
    tabId?: number;
}


