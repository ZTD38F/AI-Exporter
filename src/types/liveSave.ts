/**
 * src/types/liveSave.ts
 * Types for Live Auto-Save system.
 */

export interface LiveSaveConfig {
    enabledDisk: boolean;       // Direct disk auto-save (default: false)
    format: 'markdown' | 'json'; // Format for disk auto-save (default: 'markdown')
    includeAssets: boolean;     // Download images to assets/ (default: true)
    dirName?: string;           // Display name of saved directory
    lastSavedAt?: number;       // Timestamp of last successful live save
    lastSavedTitle?: string;    // Title of last saved conversation
    dirError?: string | null;   // Error status if directory is missing or invalid
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
