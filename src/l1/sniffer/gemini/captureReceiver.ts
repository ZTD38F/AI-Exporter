import type { ConversationKey } from '../../../l2/conversationKey.js';
import type { SourceResourceContext } from '../../resources/sourceResources.js';
import { getAccount } from '../../../runtime/api/accountRegistry.js';
import { resolveRequestAccount, resolveCurrentAccount } from '../../../runtime/content/accountContext.js';
import { ingestIndexes, ingestDetail, ingestDeletedConversation } from '../../../runtime/api/domainIngestion.js';
import { geminiListObservation } from '../../client/gemini/listObservation.js';
import type { GeminiCapturedSource } from '../../parsers/gemini/capturedSource.js';
import { mergeConversationPages } from '../../parsers/gemini/rpc/mergePages.js';
import type { GeminiRpcParseResult } from '../../parsers/gemini/rpc/parseConversation.js';
import { parseGeminiIndexObservation } from '../../parsers/gemini/parseIndexObservation.js';
import { parseGeminiDomIndex } from '../../parsers/gemini/dom/parseIndex.js';
import { extractConversationIdFromUrl, normId } from '../../../shared/utils/pathUtils.js';

export interface GeminiCaptureCallbacks {
    resources?: SourceResourceContext;
    onIndexesCommitted?: (accountId: string) => void;
    onStreamStart?: (cid?: string | null, slot?: string) => void;
    onStreamComplete?: (key: ConversationKey, slot?: string) => void;
    onDetailChanged?: (key: ConversationKey) => void;
    onConversationDeleted?: (cid: string, accountId: string) => void;
}
/** Consume decoded source facts; raw wire fields and RPC selection belong to the ingress parser. */
export class GeminiCaptureReceiver {
    // Only this capture lifetime's source pages, never stored Domain used to fill gaps.
    private readonly chains = new Map<string, { pages: GeminiRpcParseResult[]; next: string; requestedAt: number }>();
    constructor(private readonly callbacks: GeminiCaptureCallbacks) {}
    async receive(source: GeminiCapturedSource, earlier: readonly Promise<void>[], isCurrent: () => boolean): Promise<void> {
        const capturedDeps = this.callbacks;
        const { identity: capturedIdentity, slot } = source;
        const accountContext = await resolveRequestAccount(capturedIdentity, slot);
        if (!accountContext) return;
        const account = await getAccount(accountContext.accountId);
        if (!account) return;
        if (source.kind === 'network') {
            const { truncated, requestedAt } = source;
            if (source.list) {
                const { parsed, request: context } = source.list;
                const page = geminiListObservation(parsed, context, account.id, truncated, requestedAt);
                const trustedIdentity = capturedIdentity !== null && capturedIdentity.providerAccountId !== 'default'
                    && capturedIdentity.providerAccountId === account.providerAccountId;
                await ingestIndexes(account.id, parsed.conversations.map(item => parseGeminiIndexObservation(item, 'rpc-list')),
                    trustedIdentity && context ? page : undefined);
                if (isCurrent()) capturedDeps.onIndexesCommitted?.(account.id);
            }
            if (source.detail) {
                const { parsed: native, request } = source.detail;
                const cid = native.conversationId;
                const key = JSON.stringify([account.id, slot, cid]);
                const now = Date.now();
                for (const [id, chain] of this.chains) if (now - chain.requestedAt > 120000) this.chains.delete(id);
                // Uncorrelated pages remain usable facts, but never establish full coverage.
                let pages = [native], complete = false;
                if (request && request.conversationId === cid && !truncated) {
                    const previous = this.chains.get(key);
                    if (request.requestCursor === null) this.chains.delete(key);
                    else if (previous && previous.next === request.requestCursor && requestedAt >= previous.requestedAt
                        && previous.pages.length < 20 && native.sourceVersion !== undefined
                        && previous.pages.every(page => page.sourceVersion === native.sourceVersion)) pages = [...previous.pages, native];
                    const startsAtHead = request.requestCursor === null || pages.length > 1;
                    complete = startsAtHead && native.transport.nextPageToken === null && pages.some(page => page.conversation.detail.messages.length > 0);
                    if (startsAtHead && native.transport.nextPageToken && !pages.slice(0, -1).some(page => page.transport.nextPageToken === native.transport.nextPageToken)) {
                        if (this.chains.size >= 50) {
                            const oldest = this.chains.keys().next();
                            if (!oldest.done) this.chains.delete(oldest.value);
                        }
                        this.chains.set(key, { pages, next: native.transport.nextPageToken, requestedAt });
                    } else this.chains.delete(key);
                } else this.chains.delete(key);
                const merged = mergeConversationPages(pages, truncated ? 'capture_truncated' : undefined, complete);
                const index = merged.conversation.index;
                const admission = await ingestDetail(account.id, cid, merged.conversation.detail, index);
                if (isCurrent()) capturedDeps.onIndexesCommitted?.(account.id);
                if (admission.accepted) capturedDeps.resources?.retainParsed({ accountId: account.id, conversationId: cid }, merged);
                if (admission.changed && isCurrent()) capturedDeps.onDetailChanged?.({ accountId: account.id, conversationId: cid });
            }
            return;
        }
        const { id } = source;
        if (source.kind === 'deleted') {
            if (account.providerAccountId === 'default' || capturedIdentity?.providerAccountId !== account.providerAccountId) return;
            await Promise.allSettled(earlier);
            await ingestDeletedConversation(account.id, source.id);
            if (isCurrent()) {
                capturedDeps.onConversationDeleted?.(source.id, account.id);
                capturedDeps.onIndexesCommitted?.(account.id);
            }
            return;
        }
        const current = await resolveCurrentAccount();
        if (current?.accountId !== account.id || current.slot !== slot) return;
        const cid = id !== null ? normId(id) : (typeof location !== 'undefined' ? extractConversationIdFromUrl(location.pathname) : null);
        if (cid) {
            const item = parseGeminiDomIndex(typeof document !== 'undefined' ? document : null, cid);
            const { conversationId, fields } = parseGeminiIndexObservation(item, 'dom');
            await ingestIndexes(account.id, [{ conversationId, fields }]);
            if (isCurrent()) capturedDeps.onIndexesCommitted?.(account.id);
        }
        if (source.kind === 'stream-start') {
            if (isCurrent() && capturedDeps.onStreamStart) capturedDeps.onStreamStart(id, slot);
        } else {
            await Promise.all(earlier);
            if (cid && isCurrent()) capturedDeps.onStreamComplete?.({ accountId: account.id, conversationId: cid }, slot);
        }
    }
}
