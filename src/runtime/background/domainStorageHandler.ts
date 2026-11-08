import { notifyDomainChanged } from '../api/domainChanges.js';
import { ingestIndexes, ingestDetail, ingestDeletedConversation } from '../../l2/ingestion.js';
import { restoreDomainDetail } from '../../l2/runtimeValidation.js';
import { sameConversationKey } from '../../l2/conversationKey.js';
import { restoreConversationIndex } from '../../l2/conversationIndex.js';
import type { PageObservationHead } from '../../l2/pageObservation.js';
import { ensureV2Ready } from './readiness.js';
import { object, requireContentContext, assertContentSender } from './contentSender.js';

/** IPC page evidence must be typed before L2 Coverage can interpret it as proof. */
function readPageHead(value: unknown): PageObservationHead {
    const page = object(value);
    const { streamId, requestCursor, nextCursor, requestedAt, requestKnown, valid, ordered, terminal } = page;
    if (typeof streamId !== 'string' || !streamId || streamId !== streamId.trim()
        || (requestCursor !== null && typeof requestCursor !== 'string')
        || (nextCursor !== null && typeof nextCursor !== 'string')
        || typeof requestedAt !== 'number' || !Number.isSafeInteger(requestedAt)
        || typeof requestKnown !== 'boolean' || typeof valid !== 'boolean' || typeof ordered !== 'boolean'
        || (terminal !== undefined && terminal !== 'provider_limit')
        || !Array.isArray(page.keys)) throw new TypeError('Invalid Index page evidence');
    const keys = Array.from(page.keys, value => {
        const key = object(value);
        if (typeof key.id !== 'string' || !key.id || key.id !== key.id.trim()
            || typeof key.time !== 'number' || !Number.isSafeInteger(key.time)) {
            throw new TypeError('Invalid Index page key');
        }
        return { id: key.id, time: key.time };
    });
    return { streamId, requestCursor, nextCursor, requestedAt, requestKnown, valid, ordered, keys,
        ...(terminal === 'provider_limit' ? { terminal } : {}) };
}

/** Only L2 admission crosses this boundary; there is no direct Storage write port. */
export function handleDomainIngestionMessage(message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void): boolean {
    if (!message || typeof message !== 'object' || !('action' in message) || message.action !== 'domainIngest') return false;
    void (async () => {
        try {
            assertContentSender(sender);
            await ensureV2Ready();
            const request = object(message);
            const { account } = await requireContentContext(sender, request.accountId);
            if (request.operation === 'indexes') {
                if (!Array.isArray(request.items)) throw new TypeError('Expected Index items');
                const items = Array.from(request.items, item => {
                    const entry = object(item);
                    const { key, ...fields } = restoreConversationIndex({
                        ...object(entry.fields), key: { accountId: account.id, conversationId: entry.conversationId },
                    });
                    return { conversationId: key.conversationId, fields };
                });
                const page = request.page === undefined ? undefined : readPageHead(request.page);
                const changes = await ingestIndexes(account.id, items, page);
                notifyDomainChanged(account.id);
                respond({ ok: true, result: changes });
                return;
            } else if (request.operation === 'detail') {
                if (typeof request.conversationId !== 'string' || !request.conversationId) throw new TypeError('Expected conversation ID');
                const key = { accountId: account.id, conversationId: request.conversationId };
                const indexFields = request.indexFields === undefined ? undefined
                    : restoreConversationIndex({ ...object(request.indexFields), key });
                const detail = restoreDomainDetail({ key, ...object(request.detail) });
                if (!sameConversationKey(key, detail.key)) throw new TypeError('Detail identity mismatch');
                const result = await ingestDetail(account.id, request.conversationId, detail, indexFields);
                if (!result.accepted && result.changed) throw new TypeError('Invalid committed Detail ingestion result');
                notifyDomainChanged(account.id);
                respond({ ok: true, result: { accepted: result.accepted, changed: result.changed } });
                return;
            } else if (request.operation === 'deleted') {
                if (account.providerAccountId === 'default') throw new TypeError('Deletion requires an identified Account');
                const pattern = ['chatgpt', 'claude', 'grok'].includes(account.providerId) ? /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i : /^[a-f0-9]{8,64}$/;
                if (typeof request.conversationId !== 'string' || !pattern.test(request.conversationId)) throw new TypeError('Expected Provider conversation ID');
                await ingestDeletedConversation(account.id, request.conversationId);
            } else throw new TypeError('Unknown ingestion operation');
            notifyDomainChanged(account.id);
            respond({ ok: true });
        } catch (error) { respond({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    })();
    return true;
}
