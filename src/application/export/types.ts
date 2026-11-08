import type { SourceTurnStatus } from '../../l2/quality.js';
import type { OperationIssue } from '../../shared/errors/operationError.js';
import type { DiagnosticSeverity } from '../../shared/diagnostics/diagnostic.js';
import type { ConversationKey } from '../../l2/conversationKey.js';
export type { ExportFormat, ExportDelivery } from '../../l4/packaging/index.js';
import type { ExportFormat, ExportDelivery } from '../../l4/packaging/index.js';
import type { JsonValue } from '../../shared/utils/jsonTypes.js';

/** Per-run observations only; never persisted as conversation facts or export receipts. */
export interface ExportDiagnostic {
    key?: ConversationKey;
    stage: string;
    severity?: DiagnosticSeverity;
    issue?: OperationIssue;
    code: string;
    message: string;
    details?: JsonValue;
}

export interface ExportRequest {
    keys: readonly ConversationKey[];
    format: ExportFormat;
    delivery: ExportDelivery;
    includeAssets: boolean;
    skipUnchanged: boolean;
}
export interface ExportAttachmentIssue {
    resourceId: string; name: string; sourceUrl?: string; code: string; httpStatus?: number;
}
export interface ExportRecord {
    /** First successful folder document name, without extension; stable across title changes. */
    folderBaseName?: string;
    exportedAt: number;
    format: ExportFormat;
    status: 'ok' | 'partial';
    chatTime?: number;
    otherContentMissing?: boolean;
    sourceTurn?: SourceTurnStatus;
    attachmentIssues?: readonly ExportAttachmentIssue[];
}
export interface ExportProgress { current: number; total: number; key: ConversationKey }
export interface ExportResult {
    /** ChatGPT stopped this task; new tasks must respect the persisted account deadline. */
    rateLimitedUntil?: number;
    exported: number;
    skipped: number;
    partial: number;
    attachmentIssues?: readonly ExportAttachmentIssue[];
    expiredConversations?: number;
    otherPartial?: number;
    failed: readonly ConversationKey[];
    aborted: boolean;
}

/** Rendering is not delivery: Browser downloads report prepared items before a final ZIP handoff. */
export type ExportItemUpdate =
    | { key: ConversationKey; status: 'prepared' | 'skipped' }
    | { key: ConversationKey; status: 'failed'; diagnostic: ExportDiagnostic }
    | { key: ConversationKey; status: 'exported'; record: ExportRecord };
