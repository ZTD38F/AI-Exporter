import type { Conversation } from './conversation.js';

export interface ExportRecord {
    exportedAt: number | string;
    title?: string;
    format?: string;
    files?: string[];
    status?: string;
    hasFailedAssets?: boolean;
    messageCount?: number;
    chatTime?: number | string;
}

export interface IConversationsStore {
    getConversations: () => Conversation[];
    setConversations: (list: Conversation[]) => void;
    getExportedIds: () => Record<string, ExportRecord>;
    setExportedIds: (map: Record<string, ExportRecord>) => void;
    getCurrentSlot: () => string;
    setCurrentSlot: (slot: string) => void;
    getAccountSlots: () => Record<string, any>;
    setAccountSlots: (map: Record<string, any>) => void;
    getExportedRecord: (id: string | null | undefined) => ExportRecord | null;
    getSignature: (list?: Conversation[]) => string;
    loadStore: (slotOverride?: string) => Promise<{
        conversations: Conversation[];
        exportedIds: Record<string, ExportRecord>;
        slot: string;
        accountSlots: Record<string, any>;
    }>;
    getLastSync: (slot?: string) => Promise<{ timestamp: number | null; count: number }>;
    saveConversations: (slot: string, list: Conversation[]) => Promise<void>;
    clearExported: (slot: string) => Promise<void>;
    clearAll: (slot: string) => Promise<void>;
    getDevMode: () => Promise<boolean>;
    setDevMode: (devOn: boolean) => Promise<void>;
    removeConversation: (id: string) => Promise<Conversation[]>;
    reconcileWithCloud: (activeCloudList: any[], options?: any) => Promise<{ kept: number; removed: number; removedIds: string[] }>;
    normalizeAndDeduplicate: (incoming: Conversation[]) => { processed: Conversation[]; hasDirtyTitles: boolean; changedCount: number };
    hasTakeoutData: () => boolean;
    normId: (id: string | null | undefined) => string;
}

export interface IListView {
    render: (conversations: Conversation[], exportedIds: Record<string, ExportRecord>, prevSelectedSet?: Set<string> | null, searchFilter?: string, filterType?: string, failedChatIds?: Set<string>) => void;
    updateStat: (conversations?: Conversation[]) => void;
    getSelected: (conversations?: Conversation[]) => Conversation[];
    getSelectedIds: () => Set<string>;
    selectAll: (conversations?: Conversation[]) => void;
    deselectAll: (conversations?: Conversation[]) => void;
    selectUnexported: (conversations?: Conversation[], exportedIds?: Record<string, ExportRecord>) => void;
    isRealTitle: (title: string, id?: string) => boolean;
    updateItemExportStatus: (chatId: string, exportRecord?: ExportRecord | null) => void;
    selectByIds?: (targetIds: Set<string> | string[], conversations?: Conversation[]) => void;
    checkIsUpdated?: (c: any, rec: ExportRecord | null | undefined) => boolean;
    resolveConversationExportState?: (c: any, rec?: Partial<ExportRecord> | null, options?: { isFailedInSession?: boolean }) => any;
    setSelectedIds?: (ids: Set<string> | null) => void;
}

export interface IAccountView {
    render: (accountSlots: Record<string, any>, currentSlot: string) => void;
}

export interface IDialogView {
    renderExportBanner: (session: any, currentSlot: string, isRunning: boolean) => void;
    dismissExportBanner: () => void;
    showDirectWritePrompt: (count: number, onConfirmFolder: () => void, onContinueZip: () => void) => void;
    hideDirectWritePrompt: () => void;
    showTakeoutLimitPrompt: (options?: { count?: number; hitGoogleLimit?: boolean; force?: boolean; onImportTakeout?: () => void; onDismiss?: () => void }) => Promise<void>;
    hideTakeoutLimitPrompt: () => void;
    renderExportFailureBanner: (failedList: any[], onRetry?: () => void) => void;
    hideExportFailureBanner: () => void;
    getLastFailedChats: () => any[];
    setLastFailedChats?: (list: any[]) => void;
}

export interface IProgressView {
    show: (initialPct?: number, text?: string) => void;
    update: (pct: number, text?: string) => void;
    complete: (text?: string) => void;
    reset: () => void;
    hide: (delayMs?: number) => void;
}

export interface ILogView {
    init: (elId?: string) => void;
    log: (msg: string, level?: 'info' | 'warn' | 'error') => void;
    clear: () => void;
    render: () => void;
    getBuffer: () => Array<{ time: string; level: string; tag: string; msg: string }>;
}

export interface DirHandleControllerContract {
    saveStoredDirHandle: (handle: any) => Promise<boolean>;
    getStoredDirHandle: () => Promise<any>;
    verifyDirPermission: (handle: any, options?: { allowRequest?: boolean }) => Promise<boolean>;
    restoreSavedDirHandle: () => Promise<any>;
    requestDirHandle: () => Promise<any>;
    getDirHandle: () => any;
    setDirHandle: (handle: any) => void;
    getPendingPermissionHandle?: () => any;
    reauthorizeDirHandle?: () => Promise<boolean>;
}

export interface TakeoutControllerContract {
    handleTakeoutImport: (file: File, callbacks?: {
        onProgress?: (pct: number, txt: string) => void;
        onLog?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
        onFinished?: (result: { res: any; addedCount: number; totalMediaCount: number; message: string }) => void;
        onError?: (err: Error, errMsg?: string) => void;
    }) => Promise<void>;
}

export interface SyncControllerContract {
    isScanning: () => boolean;
    setScanRunning: (running: boolean) => void;
    startIncrementalScan: (slot: string, callbacks?: any) => void;
    startDeepScan: (slot: string, callbacks?: any) => void;
    stopScan: (slot: string, callbacks?: any) => void;
}

export interface ExportControllerContract {
    setRunning: (running: boolean) => void;
    isRunning: () => boolean;
    getActiveEngine: () => any;
    runExport: (params: any, callbacks: any) => Promise<any>;
    abort: () => void;
    estimateMemoryUsage?: (selected: any[], conversations: any[]) => number;
}


export interface TourGuideContract {
    startTour: (stepIndex?: number) => Promise<void>;
    startFeatureSpotlight: (stepId: string, version: string, options?: { onAction?: () => void | Promise<void>; actionLabelKey?: string }) => Promise<void>;
    dismissFeatureSpotlight: () => Promise<void>;
    goToStep: (stepIndex: number) => Promise<void>;
    nextStep: () => Promise<void>;
    prevStep: () => Promise<void>;
    finishTour: () => Promise<void>;
    skipTour: () => Promise<void>;
    isActive: () => boolean;
    getCurrentStep: () => number;
    destroy: () => void;
    clearActionListeners: () => void;
    bindStepAction: (step: any) => void;
    STEPS: any[];
}

export interface OptionsInitOptions {
    onCheckPendingTakeout?: () => Promise<void> | void;
}

export interface OptionsExportOptions {
    loadStore?: (force?: boolean, customSelected?: Set<string>) => Promise<any>;
    log?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
    getSearchFilter?: () => string;
}

export interface OptionsSyncOptions {
    loadStore?: (force?: boolean, customSelected?: Set<string>) => Promise<any>;
    log?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
    maybePromptTakeout?: (count: number, hitLimit: boolean) => Promise<void> | void;
}

export interface OptionsTakeoutOptions {
    loadStore?: (force?: boolean, customSelected?: Set<string>) => Promise<any>;
    log?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
}

export interface OptionsSettingsOptions {
    loadStore?: (force?: boolean, customSelected?: Set<string>) => Promise<any>;
    log?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
    clearLog?: () => void;
    renderLog?: () => void;
    updateZipUi?: () => void;
    checkExportSession?: () => Promise<void> | void;
    updateAccountSlotSelector?: () => void;
    getSearchFilter?: () => string;
    getChatFilterType?: () => string;
}
