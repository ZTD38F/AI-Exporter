import { getExtensionVersion, STORAGE_KEYS } from '../utils/constants.js';
import { normId } from '../utils/pathUtils.js';
import { isTakeoutConversation, resolveConversationExportState } from '../utils/titleUtils.js';
import { FlightRecorder, type FlightEvent } from './flightRecorder.js';

export interface MaskedConversationMirror {
    id: string;
    maskedTitle: string;
    titleLength: number;
    titleSource?: string;
    titleTier?: number;
    timestamp?: number;
    updatedAt?: number;
    lastSeen?: number;
    messageCount?: number;
    isTakeout: boolean;
    exportRecord: {
        exportedAt?: string | number;
        chatTime?: string | number;
        messageCount?: number;
        status?: string;
        hasFailedAssets?: boolean;
    } | null;
    derivedState: {
        state: string;
        hasNewerActivity: boolean;
        needsIncrementalExport: boolean;
        isFailed: boolean;
        isUnexported: boolean;
        isExportedClean: boolean;
        badgeKind: string;
        explanation: string;
    };
}

export interface DiagnosticSnapshot {
    diagnosticVersion: string;
    generatedAt: string;
    environment: {
        extensionVersion: string;
        userAgent?: string;
        platform?: string;
        currentSlot: string;
        isDevMode: boolean;
    };
    storageOverview: {
        totalConversations: number;
        totalExportedRecords: number;
        accountSlots: string[];
        hasTakeoutData: boolean;
        preferences: {
            format?: string;
            useZip?: boolean;
            lang?: string;
            suppressDirectWritePrompt?: boolean;
            hasCompletedTour?: boolean;
            lastSeenFeatureVersion?: string;
        };
    };
    conversationsStateMirror: MaskedConversationMirror[];
    syncDiagnostics: any;
    lastExportSession: any;
    flightRecorder: FlightEvent[];
    workbenchLogs?: any[];
}

export function maskTitle(title?: string | null): { maskedTitle: string; titleLength: number } {
    if (!title || typeof title !== 'string') {
        return { maskedTitle: '[empty]', titleLength: 0 };
    }
    const len = title.length;
    if (len <= 3) {
        return { maskedTitle: '***', titleLength: len };
    }
    const prefix = title.slice(0, 2);
    const suffix = len > 5 ? title.slice(-2) : title.slice(-1);
    return {
        maskedTitle: `${prefix}***${suffix} [len:${len}]`,
        titleLength: len
    };
}

export function explainStateDerivation(c: any, rec?: any): string {
    if (!rec) {
        return 'No export record in storage (unexported)';
    }
    const st = (rec as any).status;
    if (st === 'pending_assets') {
        return 'Export record has status=pending_assets';
    }
    if (st === 'partial' || (rec as any).hasFailedAssets) {
        return 'Export record marked partial / failed assets; requires incremental retry';
    }
    const derived = resolveConversationExportState(c, rec);
    if (derived.hasNewerActivity) {
        return 'Conversation activity advanced past export record (cTs > rTs + 2000ms grace or message count increased)';
    }
    return 'Export record is clean and up to date with conversation activity';
}

export interface BuildSnapshotOptions {
    slot?: string | null;
    conversations?: any[];
    exportedIds?: Record<string, any>;
    workbenchLogs?: any[];
}

export async function buildDiagnosticSnapshot(options: BuildSnapshotOptions = {}): Promise<DiagnosticSnapshot> {
    const slot = options.slot || 'u0';
    let rawStorage: Record<string, any> = {};
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
            rawStorage = await chrome.storage.local.get(null);
        } catch {}
    }

    const convKey = slot === 'u0' ? 'gemini_conversations' : `gemini_conversations_${slot}`;
    const expKey = slot === 'u0' ? 'exportedIds' : `gemini_exported_${slot}`;

    // Diagnostic recovery visibility: diagnostics may inspect unmigrated / corrupted raw storage to aid recovery from migration failures.
    const convs: any[] = options.conversations || rawStorage[convKey] || (slot === 'u0' ? rawStorage.gemini_conversations_u0 : []) || [];
    const expMap: Record<string, any> = options.exportedIds || rawStorage[expKey] || {};

    const slotsMap = rawStorage[STORAGE_KEYS.ACCOUNT_SLOTS] || {};
    const accountSlots = Object.keys(slotsMap).length > 0 ? Object.keys(slotsMap) : ['u0'];

    const stateMirror: MaskedConversationMirror[] = convs.map(c => {
        const nid = normId(c?.id);
        const rec = expMap[nid] || expMap[c?.id] || null;
        const derived = resolveConversationExportState(c, rec);
        const { maskedTitle, titleLength } = maskTitle(c?.title);

        return {
            id: nid,
            maskedTitle,
            titleLength,
            titleSource: c?.titleSource,
            titleTier: c?.titleTier,
            timestamp: c?.timestamp,
            updatedAt: c?.updatedAt,
            lastSeen: c?.lastSeen,
            messageCount: c?.messageCount || (Array.isArray(c?.messages) ? c.messages.length : 0),
            isTakeout: isTakeoutConversation(c),
            exportRecord: rec ? {
                exportedAt: rec.exportedAt,
                chatTime: rec.chatTime,
                messageCount: rec.messageCount,
                status: rec.status,
                hasFailedAssets: rec.hasFailedAssets
            } : null,
            derivedState: {
                state: derived.state,
                hasNewerActivity: derived.hasNewerActivity,
                needsIncrementalExport: derived.needsIncrementalExport,
                isFailed: derived.isFailed,
                isUnexported: derived.isUnexported,
                isExportedClean: derived.isExportedClean,
                badgeKind: derived.badge.kind,
                explanation: explainStateDerivation(c, rec)
            }
        };
    });

    return {
        diagnosticVersion: '2.0.0',
        generatedAt: new Date().toISOString(),
        environment: {
            extensionVersion: getExtensionVersion(),
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
            platform: typeof navigator !== 'undefined' ? (navigator as any).userAgentData?.platform || navigator.platform : undefined,
            currentSlot: slot,
            isDevMode: !!rawStorage[STORAGE_KEYS.DEV_MODE]
        },
        storageOverview: {
            totalConversations: convs.length,
            totalExportedRecords: Object.keys(expMap).length,
            accountSlots,
            hasTakeoutData: !!rawStorage[STORAGE_KEYS.HAS_IMPORTED_TAKEOUT] || convs.some(c => isTakeoutConversation(c)),
            preferences: {
                format: rawStorage[STORAGE_KEYS.FORMAT] || 'md',
                useZip: typeof rawStorage[STORAGE_KEYS.ZIP] !== 'undefined' ? !!rawStorage[STORAGE_KEYS.ZIP] : true,
                lang: rawStorage[STORAGE_KEYS.LANG] || 'zh',
                suppressDirectWritePrompt: !!rawStorage[STORAGE_KEYS.SUPPRESS_DIRECT_WRITE_PROMPT],
                hasCompletedTour: !!rawStorage[STORAGE_KEYS.HAS_COMPLETED_TOUR],
                lastSeenFeatureVersion: rawStorage[STORAGE_KEYS.LAST_SEEN_FEATURE_VERSION] || '0.0.0'
            }
        },
        conversationsStateMirror: stateMirror,
        syncDiagnostics: rawStorage[STORAGE_KEYS.LAST_SYNC_DIAGNOSTICS] || null,
        lastExportSession: rawStorage[STORAGE_KEYS.LAST_EXPORT_SESSION] || null,
        flightRecorder: FlightRecorder.getEntries(),
        workbenchLogs: options.workbenchLogs
    };
}
