import type { Diagnostic } from '../../../shared/diagnostics/diagnostic.js';
import { OperationError, operationError } from '../../../shared/errors/operationError.js';
import { claudeFileId, readClaudeFile } from './fileAssets.js';
import type { Account } from '../../../l2/accountRegistry.js';
import type { DomainAsset } from '../../../l2/conversationDetail.js';
import type { ConversationKey } from '../../../l2/conversationKey.js';
import { readConversationKey } from '../../../l2/conversationKey.js';
import type { ResourceBytes } from '../../../shared/resources/resourceResult.js';
import { getAccount } from '../../../runtime/api/accountRegistry.js';
import { ingestIndexes, ingestDetail } from '../../../l2/ingestion.js';
import { acquireSourceResource, type SourceResourceContext } from '../../resources/sourceResources.js';
import type { AIProvider, ListEnd, ProviderListOptions, ProviderReadiness } from '../aiProvider.js';
import { parseClaudeList } from '../../parsers/claude/parseList.js';
import { parseClaudeConversation } from '../../parsers/claude/parseConversation.js';
import { readClaudeSource } from './claudeSource.js';
import { claudeUuid } from '../../sniffer/claude/observation.js';

interface ClaudeProviderDeps {
    apiGet?: (path: string, organizationId?: string) => Promise<unknown>;
    resources?: SourceResourceContext;
}

export class ClaudeProvider implements AIProvider {
    readonly id = 'claude';
    readonly name = 'Claude';
    readonly hostPatterns = ['https://claude.ai/*'];
    private readonly apiGet: NonNullable<ClaudeProviderDeps['apiGet']>;
    private readonly resources?: SourceResourceContext;
    constructor(deps: ClaudeProviderDeps = {}) {
        this.apiGet = deps.apiGet ?? readClaudeSource;
        this.resources = deps.resources;
    }
    matchesUrl(url: string): boolean {
        try { return new URL(url).origin === 'https://claude.ai'; }
        catch { return false; }
    }
    private async account(accountId: string): Promise<Account> {
        const account = await getAccount(accountId);
        if (!account || account.providerId !== this.id || !claudeUuid(account.providerAccountId))
            throw new OperationError('ACCOUNT_UNAVAILABLE', 'Claude account mismatch');
        return account;
    }
    private async get(path: string, account: Account, signal?: AbortSignal): Promise<unknown> {
        signal?.throwIfAborted();
        const result = await this.apiGet(path, account.providerAccountId);
        signal?.throwIfAborted();
        return result;
    }
    async checkReadiness(accountId: string): Promise<ProviderReadiness> {
        try {
            const account = await this.account(accountId);
            const raw = await this.get('/api/organizations', account);
            if (!Array.isArray(raw) || !raw.some((org: unknown) => org !== null
                && typeof org === 'object' && 'uuid' in org && org.uuid === account.providerAccountId))
                return { ready: false, error: 'Claude organization/account unavailable' };
            return { ready: true, accountName: account.displayName };
        } catch (error) {
            return { ready: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    async listConversations(options: ProviderListOptions): Promise<ListEnd> {
        if (options.streamId !== 'recent') throw new TypeError('Unknown Claude stream');
        const account = await this.account(options.accountId);
        const seen = new Set<string>();
        let lastTime = Infinity, totalObserved = 0;
        for (let page = 1; page <= 100; page++) {
            const offset = (page - 1) * 100, requestedAt = Date.now();
            const raw = await this.get('/api/organizations/' + account.providerAccountId
                + '/chat_conversations_v2?limit=100&offset=' + offset + '&consistency=strong', account, options.signal);
            if (!raw || typeof raw !== 'object' || !('data' in raw) || !('has_more' in raw)
                || typeof raw.has_more !== 'boolean'
                || ('search_incomplete' in raw && typeof raw.search_incomplete !== 'boolean'))
                throw new OperationError('SOURCE_RESPONSE_INVALID', 'Invalid Claude paginated list');
            const parsed = parseClaudeList(raw.data);
            const count = parsed.conversations.length;
            const sourceEnd = raw.has_more === false;
            const valid = count <= 100 && (sourceEnd || count === 100)
                && !('search_incomplete' in raw && raw.search_incomplete === true);
            // Parser keys retain wire order for Coverage evidence.
            const times = parsed.keys;
            const ordered = valid && times.every((key, i) => !seen.has(key.id)
                && key.time <= (i ? times[i - 1].time : lastTime));
            const evidence = { streamId: options.streamId, requestCursor: page === 1 ? null : String(offset),
                nextCursor: sourceEnd ? null : String(offset + 100), requestedAt,
                requestKnown: true, valid, ordered, keys: times };
            const indexChanges = await ingestIndexes(account.id, parsed.conversations.map(item => ({ conversationId: item.id, fields: {
                ...(item.title ? { title: item.title, titleSource: 'provider' as const } : {}),
                ...(item.createdAt !== undefined ? { createdAt: item.createdAt } : {}), updatedAt: item.updatedAt,
            } })), evidence);
            options.signal?.throwIfAborted();
            if (!valid || !ordered) throw new OperationError('SOURCE_RESPONSE_INVALID', 'Unverified Claude list page');
            times.forEach(key => seen.add(key.id));
            if (times.length) lastTime = times[times.length - 1].time;
            totalObserved += count;
            const stop = await options.onPageCommitted?.({ page, totalObserved, indexChanges, ...(page === 1 ? { scanHead: evidence } : {}) });
            if (sourceEnd) return 'source_end';
            if (stop) return 'stopped';
        }
        return 'max_pages';
    }

    async fetchConversationDetail(accountId: string, conversationId: string, signal?: AbortSignal, onDiagnostic?: (diagnostic: Diagnostic) => void): Promise<void> {
        const account = await this.account(accountId);
        if (!claudeUuid(conversationId)) throw new TypeError('Invalid Claude conversation UUID');
        const path = '/api/organizations/' + account.providerAccountId + '/chat_conversations/'
            + conversationId + '?tree=true&rendering_mode=messages&render_all_tools=true';
        const raw = await this.get(path, account, signal);
        let parsed: ReturnType<typeof parseClaudeConversation>;
        try { parsed = parseClaudeConversation(raw, conversationId); }
        catch (error) { throw operationError(error, 'SOURCE_RESPONSE_INVALID'); }
        signal?.throwIfAborted();
        for (const diagnostic of parsed.diagnostics) {
            try { onDiagnostic?.(diagnostic); }
            catch (error) { console.warn('[Gemini Exporter] Source diagnostic listener failed', error); }
        }
        const admission = await ingestDetail(account.id, conversationId, parsed.conversation.detail, parsed.conversation.index);
        if (admission.accepted) this.resources?.retainParsed({ accountId, conversationId }, parsed);
    }
    canAcquireResourceDirectly(asset: DomainAsset): boolean { return claudeFileId(asset.sourceUri) !== null; }
    async acquireResource(key: ConversationKey, asset: DomainAsset, signal?: AbortSignal): Promise<ResourceBytes> {
        readConversationKey(key);
        const account = await this.account(key.accountId);
        const id = claudeFileId(asset.sourceUri);
        const remote = async () => {
            const result = id ? await readClaudeFile(account.providerAccountId, id, signal) : await acquireSourceResource(asset, signal);
            if (asset.byteLength !== undefined && result.bytes.byteLength !== asset.byteLength) throw new OperationError('RESOURCE_SIZE_MISMATCH', 'Claude attachment byte count mismatch');
            return result;
        };
        return this.resources ? this.resources.acquire(key, asset, signal, remote) : remote();
    }
}
