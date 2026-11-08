import type { Diagnostic } from '../../shared/diagnostics/diagnostic.js';
import { notifyDomainChanged } from '../../runtime/api/domainChanges.js';
import { getAccount } from '../../runtime/api/accountRegistry.js';
import { DEFAULT_ACCOUNT_KEY, isAccountId } from '../../l2/accountRegistry.js';
import { defaultGeminiProvider } from '../../l1/client/gemini/geminiProvider.js';
import { ProviderRegistry } from '../../l1/client/providerRegistry.js';
import { ProviderListError, type ListFailureDiagnostics } from '../../l1/client/aiProvider.js';
import CoverageAdmission, { type ScanHead } from '../../l2/coverageAdmission.js';

interface ScanRequest { accountId: string; forceFull?: boolean }
export type ScanStatus = 'up_to_date' | 'complete' | 'partial_limit' | 'aborted' | 'error';
export interface ScanResult {
    status: ScanStatus;
    pagesFetched: number;
    conversationsFetched: number;
    indexChanges?: { added: number; updated: number };
    reason?: string;
    diagnostics?: ListFailureDiagnostics;
}
export type ScanProgress = Pick<ScanResult, 'pagesFetched' | 'conversationsFetched'>;
const active = new Set<string>();

export async function scanAll(request: ScanRequest, options: {
    onProgress?: (progress: ScanProgress) => void;
    onDiagnostic?: (diagnostic: Diagnostic) => void;
    signal?: AbortSignal;
} = {}): Promise<ScanResult> {
    const { accountId } = request;
    const counts: ScanProgress = { pagesFetched: 0, conversationsFetched: 0 };
    let indexChanges: ScanResult['indexChanges'];
    const result = (status: ScanStatus, reason?: string): ScanResult =>
        ({ status, ...counts, ...(indexChanges ? { indexChanges } : {}), ...(reason ? { reason } : {}) });
    if (!isAccountId(accountId)) return result('error', 'Invalid account UUID');
    if (active.has(accountId)) return result('error', 'Scan already running');
    active.add(accountId);
    try {
        options.signal?.throwIfAborted();
        const account = await getAccount(accountId);
        // Runtime resolves a verified online source; a local/offline default account
        // is not an online identity and must never launch a successful Scan All.
        if (!account || !['gemini', 'chatgpt', 'claude', 'grok'].includes(account.providerId) || account.providerAccountId === DEFAULT_ACCOUNT_KEY) {
            return result('error', 'Verified provider account unavailable');
        }
        const provider = ProviderRegistry.get(account.providerId)
            ?? (account.providerId === 'gemini' ? defaultGeminiProvider : undefined);
        if (!provider) throw new Error('Account provider unavailable');
        const previous = await CoverageAdmission.getCoverage(accountId, 'recent');
        const baseline = previous ? structuredClone(previous) : null;
        let scanHead: ScanHead | undefined;
        let verifiedStop = false;
        const end = await provider.listConversations({ accountId, streamId: 'recent', signal: options.signal, onDiagnostic: options.onDiagnostic,
            onPageCommitted: async info => {
                notifyDomainChanged(accountId);
                counts.pagesFetched = info.page;
                counts.conversationsFetched = info.totalObserved;
                if (info.indexChanges) indexChanges = {
                    added: (indexChanges?.added ?? 0) + info.indexChanges.added,
                    updated: (indexChanges?.updated ?? 0) + info.indexChanges.updated,
                };
                scanHead ??= info.scanHead;
                options.onProgress?.({ ...counts });
                options.signal?.throwIfAborted();
                if (!request.forceFull && baseline?.range && scanHead) {
                    verifiedStop = await CoverageAdmission.hasTrustedBoundary(accountId, baseline, scanHead);
                }
                return verifiedStop;
            } });
        options.signal?.throwIfAborted();
        switch (end) {
            case 'source_end': return result('complete');
            case 'provider_limit': return result('partial_limit', 'provider_limit');
            case 'max_pages': return result('partial_limit', 'max_pages');
            case 'stopped': return verifiedStop ? result('up_to_date') : result('error', 'Unverified scan stop');
        }
        return result('error', 'Unknown provider list termination');
    } catch (error) {
        if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) return result('aborted');
        return { ...result('error', error instanceof Error ? error.message : String(error)),
            ...(error instanceof ProviderListError ? { diagnostics: error.diagnostics } : {}) };
    } finally { active.delete(accountId); }
}
