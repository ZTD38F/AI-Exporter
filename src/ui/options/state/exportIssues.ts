import type { ConversationKey } from '../../../l2/conversationKey.js';
import type { ExportDiagnostic } from '../../../application/export/types.js';

interface AffectedConversation { key: ConversationKey; title?: string }
export interface ExportIssueGroup {
    category: string;
    httpStatus?: number;
    severity: 'warning' | 'error';
    occurrences: number;
    diagnostic: ExportDiagnostic;
    conversations: AffectedConversation[];
}
const SOURCE_STATE_CODES = new Set(['SOURCE_TURN_UNFINISHED', 'SOURCE_TURN_INTERRUPTED', 'SOURCE_TURN_HANDOFF',
    'SOURCE_TURN_AWAITING_REPLY', 'SOURCE_TURN_TOOL_PENDING', 'SOURCE_TURN_UNKNOWN']);
const GENERIC_CODES = new Set(['EXPORT_FAILED', 'EXPORT_RUN_FAILED', 'SOURCE_REFRESH_FAILED', 'RESOURCE_REFRESH_FAILED']);
const LEGACY_ISSUES = new Set([...GENERIC_CODES, 'DETAIL_NOT_COMPLETE', 'DETAIL_STALE']);

/** Collect before diagnostic-log truncation. Only reported categories/statuses determine grouping. */
export class ExportIssueCollector {
    private readonly entries = new Map<string, { group: ExportIssueGroup; keys: Set<string> }>();
    add(diagnostic: ExportDiagnostic, title?: string): void {
        // Source termination is not an export problem, including legacy warning diagnostics.
        if (SOURCE_STATE_CODES.has(diagnostic.code) || diagnostic.severity === 'info' || ['EXPORT_CANCELLED', 'SOURCE_CONVERSATION_EMPTY'].includes(diagnostic.code)) return;
        if (!diagnostic.severity && !LEGACY_ISSUES.has(diagnostic.code)) return;
        const category = diagnostic.issue?.code ?? (GENERIC_CODES.has(diagnostic.code) ? 'UNKNOWN_ERROR' : diagnostic.code);
        const httpStatus = diagnostic.issue?.httpStatus;
        const signature = JSON.stringify([category, httpStatus, category === 'UNKNOWN_ERROR' ? diagnostic.stage : null]);
        let entry = this.entries.get(signature);
        if (!entry) {
            entry = { group: { category, httpStatus, severity: diagnostic.severity === 'warning' ? 'warning' : 'error',
                occurrences: 0, diagnostic, conversations: [] }, keys: new Set() };
            this.entries.set(signature, entry);
        }
        entry.group.occurrences++;
        if (diagnostic.severity === 'error' || diagnostic.code === 'EXPORT_FAILED') entry.group.severity = 'error';
        if (diagnostic.key) {
            const id = JSON.stringify([diagnostic.key.accountId, diagnostic.key.conversationId]);
            if (!entry.keys.has(id)) {
                entry.keys.add(id);
                entry.group.conversations.push({ key: diagnostic.key, title });
            }
        }
    }
    groups(): ExportIssueGroup[] { return [...this.entries.values()].map(entry => entry.group); }
    toJSON(): ExportIssueGroup[] { return this.groups(); }
}

