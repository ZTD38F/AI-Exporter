/**
 * src/types/entrypoints.ts
 * Type definitions for extension entry points (Background Service Worker & Popup Controller).
 */

import type { MessageAction } from './messages.js';

export interface BackgroundMessage {
    action: MessageAction | string;
    id?: string;
    conversationId?: string;
    accountSlot?: string;
    ids?: (string | { id: string; title?: string; url?: string })[];
    format?: string;
    skipExported?: boolean;
    globalOffset?: number;
    globalTotal?: number;
    maxIter?: number;
    mode?: 'auto' | 'full' | 'incremental' | string;
    tabId?: number;
    percent?: number;
    done?: number;
    total?: number;
    title?: string;
    count?: number;
    payload?: any;
}

export interface BackgroundResponse {
    ok?: boolean;
    success?: boolean;
    error?: string;
    details?: string;
    tabId?: number;
    handleName?: string;
    targetFile?: string;
    version?: string;
    ver?: string;
    aborted?: boolean;
    results?: any[];
    skipped?: number;
    data?: any;
    chat?: any;
}
