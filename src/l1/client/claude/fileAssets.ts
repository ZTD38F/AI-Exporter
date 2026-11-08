import { OperationError, readOperationIssue, type OperationIssue } from '../../../shared/errors/operationError.js';
import type { ResourceBytes } from '../../../shared/resources/resourceResult.js';
import { ResourceHttpError, ResourceProcessingError } from '../../../shared/resources/resourceResult.js';
import { CLAUDE_ORIGIN, hasClaudeAccess } from './claudeSource.js';
import { claudeUuid } from '../../sniffer/claude/observation.js';

export function claudeFileId(uri?: string): string | null {
    const id = uri?.startsWith('claude-file:') ? uri.slice(12) : undefined;
    return claudeUuid(id) ? id : null;
}
/** Download through the same authenticated tab and organization as the source.
 * Only a fixed files endpoint is allowed; source URLs cannot redirect this API. */
export async function readClaudeFile(organization: string, file: string, signal?: AbortSignal): Promise<ResourceBytes> {
    if (!claudeUuid(organization) || !claudeUuid(file)) throw new TypeError('Invalid Claude file identity');
    signal?.throwIfAborted();
    if (!await hasClaudeAccess()) throw new OperationError('PLATFORM_PERMISSION_REQUIRED', 'Claude host permission unavailable');
    const tabs = await chrome.tabs.query({ url: [CLAUDE_ORIGIN] });
    const [tabId] = tabs.sort((a, b) => Number(!!b.active) - Number(!!a.active))
        .flatMap(tab => tab.id === undefined ? [] : [tab.id]);
    if (tabId === undefined) throw new OperationError('SOURCE_PAGE_UNAVAILABLE', 'Open Claude to acquire attachments');
    const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED',
        args: [organization, file], func: async (org: string, id: string): Promise<{ status: number; base64?: string; mediaType?: string; issue?: OperationIssue }> => {
            const active = () => document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('lastActiveOrg='))?.slice(14);
            if (active() !== org) return { status: 0, issue: { code: 'ACCOUNT_CHANGED', message: 'Claude attachment account changed' } };
            const response = await fetch('/api/organizations/' + org + '/files/' + id + '/contents', { credentials: 'include', redirect: 'error' });
            if (!response.ok) return { status: response.status };
            const reader = response.body?.getReader();
            if (!reader) return { status: 0, issue: { code: 'RESOURCE_PROCESSING_FAILED', message: 'Missing Claude file bytes' } };
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > 20 * 1024 * 1024) return { status: 0, issue: { code: 'RESOURCE_SIZE_LIMIT', message: 'Claude attachment exceeds 20 MiB' } };
                    chunks.push(value);
                }
            } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
            if (active() !== org) return { status: 0, issue: { code: 'ACCOUNT_CHANGED', message: 'Claude attachment account changed' } };
            let binary = '';
            for (const chunk of chunks) for (let i = 0; i < chunk.length; i += 8192)
                binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
            return { status: response.status, base64: btoa(binary), mediaType: response.headers.get('content-type')?.split(';')[0] ?? undefined };
        } });
    signal?.throwIfAborted();
    const result = results[0]?.result;
    if (!result) throw new ResourceProcessingError('Claude file returned no result');
    if (result.issue) {
        const issue = readOperationIssue(result.issue);
        if (issue) throw new OperationError(issue.code, issue.message, issue.httpStatus);
        throw new OperationError('SOURCE_RESPONSE_INVALID', 'Claude file returned invalid error facts');
    }
    if (result.status < 200 || result.status >= 300) throw new ResourceHttpError(result.status);
    if (!result.base64) throw new ResourceProcessingError('Claude file is empty');
    return { bytes: Uint8Array.from(atob(result.base64), c => c.charCodeAt(0)), ...(result.mediaType ? { mediaType: result.mediaType } : {}) };
}
