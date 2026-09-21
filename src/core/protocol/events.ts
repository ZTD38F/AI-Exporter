// src/core/protocol/events.ts - Cross-World and Inter-process event constants and payload contracts
import { CrossWorldEvents, type CrossWorldEventType } from './protocol.js';

export { CrossWorldEvents, type CrossWorldEventType };

export interface GeminiCredentialsPayload {
    at: string;
    sid: string;
    bl: string;
    accountSlot: string;
    lastUsed: number;
    url: string;
}

export interface GeminiConversationDeletedPayload {
    id: string;
    slot: string;
}

export interface GeminiNetworkBatchexecutePayload {
    text: string;
    slot: string;
    url: string;
}

export interface GeminiStreamStartPayload {
    id: string | null;
    slot: string;
}

export interface GeminiStreamCompletePayload {
    id: string | null;
    slot: string;
    url?: string;
}

export interface GeminiLiveSaveTriggerPayload {
    cid: string;
    reason?: string;
    [key: string]: any;
}

export interface CrossWorldEventMap {
    [CrossWorldEvents.CREDENTIALS]: GeminiCredentialsPayload;
    [CrossWorldEvents.CONVERSATION_DELETED]: GeminiConversationDeletedPayload;
    [CrossWorldEvents.NETWORK_BATCHEXECUTE]: GeminiNetworkBatchexecutePayload;
    [CrossWorldEvents.STREAM_START]: GeminiStreamStartPayload;
    [CrossWorldEvents.STREAM_COMPLETE]: GeminiStreamCompletePayload;
    [CrossWorldEvents.LIVE_SAVE_TRIGGER]: GeminiLiveSaveTriggerPayload;
}
