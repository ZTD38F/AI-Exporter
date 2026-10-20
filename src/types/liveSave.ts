export interface LiveSaveConfig {
    enabledDisk: boolean;
    format: 'markdown' | 'json';
    includeAssets: boolean;
    dirName?: string;
    lastSavedAt?: number;
    lastSavedTitle?: string;
    dirError?: string | null;
}

export interface LiveConversationRecord {
    id: string;
    title: string;
    messages: any[];
    timestamp: number;
    updatedAt?: number;
    savedAt: number;
    turnCount: number;
    accountSlot?: string;
    format?: string;
    hasImages?: boolean;
}

export type LiveSaveState = 'IDLE' | 'GENERATING' | 'COOLING_DOWN' | 'SAVING' | 'ERROR';

export interface LiveSaveStatusEvent {
    state: LiveSaveState;
    conversationId?: string;
    title?: string;
    error?: string;
    timestamp: number;
}
