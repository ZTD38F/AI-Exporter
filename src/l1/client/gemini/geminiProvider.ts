import { OperationError } from '../../../shared/errors/operationError.js';
import type { Diagnostic } from '../../../shared/diagnostics/diagnostic.js';
import type { Account } from '../../../l2/accountRegistry.js';
import { parseGeminiIndexObservation } from '../../parsers/gemini/parseIndexObservation.js';
import { ingestIndexes, ingestDetail, ingestDeletedConversation } from '../../../l2/ingestion.js';
import { getAccount } from '../../../runtime/api/accountRegistry.js';
import type { GeminiProviderClient, GeminiProviderContract } from './geminiContracts.js';
import type { ProviderListOptions, ListEnd, ProviderReadiness } from '../aiProvider.js';
import { ProviderListError } from '../aiProvider.js';
import { ProviderRegistry } from '../providerRegistry.js';
import { GeminiAPIClient, ConfirmedGeminiConversationNotFound } from './geminiClient.js';
import credentials from './api/credentialManager.js';
import { geminiListObservation } from './listObservation.js';
import { resolveCurrentAccount } from '../../../runtime/content/accountContext.js';
import { acquireSourceResource, type SourceResourceContext } from '../../resources/sourceResources.js';
import type { DomainAsset } from '../../../l2/conversationDetail.js';
import { readConversationKey, type ConversationKey } from '../../../l2/conversationKey.js';
import type { ResourceBytes } from '../../../shared/resources/resourceResult.js';

/** Runtime routing is frozen before acquisition, never inferred from SID or Slot. */
async function resolveRoute(accountId: string): Promise<string> {
    if (typeof document !== 'undefined' && location.hostname === 'gemini.google.com') {
        const context = await resolveCurrentAccount();
        if (context?.accountId === accountId) return context.slot;
    } else if (typeof chrome !== 'undefined' && chrome.tabs) {
        const failures: string[] = [];
        const tabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*'] });
        for (const tab of tabs) {
            if (tab.id === undefined) continue;
            try {
                const response: unknown = await chrome.tabs.sendMessage(tab.id, { action: 'getAccountContext' });
                if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true
                    || !('accountContext' in response)) {
                    failures.push(`tab ${tab.id}: ${response && typeof response === 'object' && 'error' in response ? String(response.error) : 'invalid reply'}`);
                    continue;
                }
                const context = response.accountContext;
                if (context && typeof context === 'object' && 'accountId' in context && context.accountId === accountId
                    && 'slot' in context && typeof context.slot === 'string' && /^u\d+$/.test(context.slot)) return context.slot;
                failures.push(`tab ${tab.id}: ${context === null ? 'unknown account' : 'account or slot mismatch'}`);
            } catch (error) { failures.push(`tab ${tab.id}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        throw new OperationError('SOURCE_PAGE_UNAVAILABLE', 'No verified Gemini account route: ' + (failures.join('; ') || 'no Gemini tabs'));
    }
    throw new OperationError('SOURCE_PAGE_UNAVAILABLE', 'No verified Gemini account route');
}

export class GeminiProvider implements GeminiProviderContract {
    readonly id = 'gemini';
    readonly name = 'Google Gemini';
    readonly hostPatterns = ['https://gemini.google.com/*', 'https://bard.google.com/*'];
    private client: GeminiProviderClient | null;
    constructor(client?: GeminiProviderClient, private route = resolveRoute, private readonly resources?: SourceResourceContext) { this.client = client ?? null; }
    private getClient(): GeminiProviderClient { return this.client ??= new GeminiAPIClient(); }
    private async context(accountId: string) {
        const account = await getAccount(accountId);
        if (!account || account.providerId !== this.id) throw new OperationError('ACCOUNT_UNAVAILABLE', 'Provider account mismatch');
        const slot = await this.route(accountId);
        return { account, slot };
    }
    matchesUrl(url: string): boolean {
        try { return ['gemini.google.com', 'bard.google.com'].includes(new URL(url).hostname); }
        catch { return false; }
    }
    async checkReadiness(accountId: Account['id']): Promise<ProviderReadiness> {
        try {
            const { slot } = await this.context(accountId);
            const cred = await credentials.resolveCred(slot);
            return cred.at ? { ready: true } : { ready: false, error: 'Gemini credentials unavailable' };
        } catch (error) { return { ready: false, error: error instanceof Error ? error.message : 'Gemini unavailable' }; }
    }
    async listConversations(options: ProviderListOptions): Promise<ListEnd> {
        if (options.streamId !== 'recent' && options.streamId !== 'pinned') throw new TypeError('Unknown Gemini stream');
        options.signal?.throwIfAborted();
        const { account, slot } = await this.context(options.accountId);
        const client = this.getClient();
        const seen = new Set<string>();
        const seenConversations = new Set<string>();
        let lastTime = Infinity;
        let cursor: string | null = null, totalObserved = 0, sentHead = false;
        for (let page = 1; page <= 2000; page++) {
            options.signal?.throwIfAborted();
            if (await this.route(account.id) !== slot) throw new OperationError('ACCOUNT_CHANGED', 'Gemini account route changed');
            const requestedAt = Date.now();
            const result = await client.getConversationList(cursor, slot,
                options.streamId === 'pinned' ? [1, null, 1] : undefined, { signal: options.signal });
            options.signal?.throwIfAborted();
            if (await this.route(account.id) !== slot) throw new OperationError('ACCOUNT_CHANGED', 'Gemini account route changed');
            const observation = geminiListObservation(result, { streamId: options.streamId, requestCursor: cursor }, account.id, false, requestedAt);
            if (result.failure && observation.terminal !== 'provider_limit') throw new ProviderListError(`Gemini list failed: ${result.failure}`, {
                providerId: this.id, streamId: options.streamId, page, requestCursor: cursor, failure: result.failure,
                ...(result._debug ? { details: { ...result._debug } } : {})
            });
            if (options.streamId === 'recent' && observation.valid && observation.ordered) {
                const keys = observation.keys;
                if (keys.some((key, i) => seenConversations.has(key.id)
                        || (i === 0 ? key.time > lastTime : key.time > keys[i - 1].time))) {
                    // Keep reliably decoded Index rows, but never certify a broken
                    // cross-page ordering or duplicated source chain to Coverage.
                    observation.valid = false;
                    observation.ordered = false;
                } else {
                    keys.forEach(key => seenConversations.add(key.id));
                    if (keys.length) lastTime = keys[keys.length - 1].time;
                }
            }
            const pageEvidence = account.providerAccountId === 'default' ? undefined : observation;
            const indexChanges = await ingestIndexes(account.id, result.conversations.map(item => parseGeminiIndexObservation(item, 'rpc-list')), pageEvidence);
            options.signal?.throwIfAborted();
            totalObserved += result.conversations.length;
            const { providerId: _provider, accountId: _account, ...head } = observation;
            const trustedHead = !sentHead && pageEvidence && head.requestCursor === null && head.requestKnown && head.valid && head.ordered;
            if (trustedHead) sentHead = true;
            const stop = await options.onPageCommitted?.({ page, totalObserved, indexChanges, ...(trustedHead ? { scanHead: head } : {}) });
            // L1 may report a trusted terminal only after L2 committed every
            // trustworthy Recent page and its request-bound terminal evidence.
            if (!observation.valid || (options.streamId === 'recent' && !observation.ordered))
                throw new Error('Unverified Gemini list page');
            if (result.failure === 'hit_google_limit') {
                if (!pageEvidence || observation.terminal !== 'provider_limit')
                    throw new Error('Unverified Gemini provider limit');
                return 'provider_limit';
            }
            if (result.nextPageToken === null) {
                if (!pageEvidence) throw new Error('Unverified Gemini list endpoint');
                return 'source_end';
            }
            if (seen.has(result.nextPageToken)) throw new Error('Gemini list cursor loop');
            if (stop) return 'stopped';
            seen.add(result.nextPageToken);
            cursor = result.nextPageToken;
        }
        return 'max_pages';
    }
    async fetchConversationDetail(accountId: Account['id'], conversationId: ConversationKey['conversationId'], signal?: AbortSignal, onDiagnostic?: (diagnostic: Diagnostic) => void): Promise<void> {
        signal?.throwIfAborted();
        const { account, slot } = await this.context(accountId);
        let parsed: Awaited<ReturnType<GeminiProviderClient['getConversationDetail']>>;
        try {
            parsed = await this.getClient().getConversationDetail(conversationId, slot, account, signal);
        } catch (error) {
            if (!(error instanceof ConfirmedGeminiConversationNotFound)) throw error;
            signal?.throwIfAborted();
            if (error.sourceConversationId !== `c_${conversationId.replace(/^c_/, '')}`) throw error;
            if (await this.route(accountId) !== slot) throw new OperationError('ACCOUNT_CHANGED', 'Gemini account route changed');
            await ingestDeletedConversation(accountId, conversationId.replace(/^c_/, ''));
            throw new OperationError('CONVERSATION_NOT_FOUND', 'conversation_not_found');
        }
        signal?.throwIfAborted();
        if (await this.route(accountId) !== slot) throw new OperationError('ACCOUNT_CHANGED', 'Gemini account route changed');
        if (parsed.conversationId !== conversationId.replace(/^c_/, '')) throw new OperationError('SOURCE_RESPONSE_INVALID', 'Detail identity mismatch');
        // Diagnostics are task observations, never persisted quality facts or ingestion inputs.
        const report = (diagnostic: Diagnostic) => {
            try { onDiagnostic?.(diagnostic); }
            catch (error) { console.warn('[Gemini Exporter] Source diagnostic listener failed', error); }
        };
        for (const diagnostic of parsed.diagnostics) report(diagnostic);
        const index = parsed.conversation.index;
        const detail = parsed.conversation.detail;
        report({ severity: 'info', code: 'GEMINI_DETAIL_PARSE_RESULT', message: 'Source Detail parsing completed',
            details: { quality: detail.quality.status, sourceVersion: parsed.sourceVersion ?? null,
                indexUpdatedAt: index.updatedAt ?? null, messageCount: detail.messages.length,
                assetCount: detail.assets.length, rejectedTurns: parsed.evidence?.rejectedTurns ?? 0,
                truncation: parsed.evidence?.truncation ?? null,
                heuristicDocumentIds: parsed.evidence?.heuristicDocumentIds ?? [],
                diagnosticCodes: parsed.diagnostics.map(diagnostic => diagnostic.code) } });
        const admission = await ingestDetail(accountId, parsed.conversationId, detail, index);
        report({ severity: 'info', code: 'GEMINI_DETAIL_ADMISSION', message: 'Source Detail admission completed',
            details: { accepted: admission.accepted, changed: admission.changed } });
        if (admission.accepted) this.resources?.retainParsed({ accountId, conversationId: parsed.conversationId }, parsed);
    }
    async acquireResource(key: ConversationKey, asset: DomainAsset, signal?: AbortSignal): Promise<ResourceBytes> {
        signal?.throwIfAborted();
        readConversationKey(key);
        const account = await getAccount(key.accountId);
        if (!account || account.providerId !== this.id) throw new OperationError('ACCOUNT_UNAVAILABLE', 'Provider account mismatch');
        const remote = async () => {
            if (!/^https:\/\//i.test(asset.sourceUri ?? '') && asset.document?.contentMarkdown) return { bytes: new TextEncoder().encode(asset.document.contentMarkdown),
                mediaType: asset.mediaType ?? 'text/markdown', ...(asset.name ? { name: asset.name } : {}) };
            if (!asset.sourceUri?.startsWith('data:')) await this.context(key.accountId);
            return acquireSourceResource(asset, signal);
        };
        return this.resources ? this.resources.acquire(key, asset, signal, remote) : remote();
    }
}
export const defaultGeminiProvider = new GeminiProvider();
ProviderRegistry.register(defaultGeminiProvider);
