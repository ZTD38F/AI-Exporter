import { getAccountContext } from './accountContext.js';
import { readConversationKey, type ConversationKey } from '../../l2/conversationKey.js';
import type { ExportAttachmentIssue, ExportResult } from '../../application/export/types.js';

function readCount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid Live Save count');
    return value;
}
function readAttachmentIssue(value: unknown): ExportAttachmentIssue {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !('resourceId' in value) || typeof value.resourceId !== 'string'
        || !('name' in value) || typeof value.name !== 'string'
        || !('code' in value) || typeof value.code !== 'string'
        || ('sourceUrl' in value && value.sourceUrl !== undefined && typeof value.sourceUrl !== 'string')) {
        throw new TypeError('Invalid Live Save attachment issue');
    }
    return { resourceId: value.resourceId, name: value.name, code: value.code,
        ...('sourceUrl' in value && typeof value.sourceUrl === 'string' ? { sourceUrl: value.sourceUrl } : {}),
        ...('httpStatus' in value && value.httpStatus !== undefined ? { httpStatus: readCount(value.httpStatus) } : {}) };
}
/** Chrome JSON replies lose the worker's in-memory ExportResult proof. */
function readExportResult(value: unknown): ExportResult | null {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !('exported' in value) || !('skipped' in value) || !('partial' in value)
        || !('failed' in value) || !Array.isArray(value.failed)
        || !('aborted' in value) || typeof value.aborted !== 'boolean'
        || ('attachmentIssues' in value && value.attachmentIssues !== undefined && !Array.isArray(value.attachmentIssues))) {
        throw new TypeError('Invalid Live Save result');
    }
    return { exported: readCount(value.exported), skipped: readCount(value.skipped), partial: readCount(value.partial),
        failed: value.failed.map((key: unknown) => readConversationKey(key)), aborted: value.aborted,
        ...('expiredConversations' in value && value.expiredConversations !== undefined
            ? { expiredConversations: readCount(value.expiredConversations) } : {}),
        ...('otherPartial' in value && value.otherPartial !== undefined ? { otherPartial: readCount(value.otherPartial) } : {}),
        ...('attachmentIssues' in value && Array.isArray(value.attachmentIssues)
            ? { attachmentIssues: value.attachmentIssues.map((issue: unknown) => readAttachmentIssue(issue)) } : {}) };
}

interface Feedback {
    showLiveSaveResult?: (result: ExportResult | null, accountId: string) => void;
    showLiveSaveError?: (accountId: string) => void;
}
let badge: Feedback | undefined;
let instance: symbol | null = null;
export function init(options: { badge?: Feedback } = {}): void { badge = options.badge; instance = Symbol(); }
export function cleanup(): void { instance = null; badge = undefined; }
/** Accepted passive Detail or a completed reply may request unified Export. */
export async function executeLiveSave(value: ConversationKey, refreshDetail = false): Promise<ExportResult | null> {
    if (!instance) return null;
    const current = instance;
    const feedback = badge;
    const key = readConversationKey(value);
    const stillCurrent = () => getAccountContext()?.accountId === key.accountId;
    // A late passive Detail result from an old account must not start a new active export.
    if (!stillCurrent()) return null;
    try {
        const response: unknown = await chrome.runtime.sendMessage({ action: 'runLiveSave', key, ...(refreshDetail ? { refreshDetail: true } : {}) });
        if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true || !('result' in response)) {
            throw new Error(response && typeof response === 'object' && 'error' in response && typeof response.error === 'string' && response.error
                ? response.error : 'Live Save unavailable');
        }
        const result = readExportResult(response.result);
        if (current === instance && feedback === badge && stillCurrent() && result) {
            feedback?.showLiveSaveResult?.(result, key.accountId);
        }
        return result;
    } catch (error) {
        if (current === instance && feedback === badge && stillCurrent()) feedback?.showLiveSaveError?.(key.accountId);
        throw error;
    }
}
export const LiveSaveCoordinator = { init, cleanup, executeLiveSave };
