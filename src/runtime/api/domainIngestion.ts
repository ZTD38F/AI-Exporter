import * as domain from '../../l2/ingestion.js';
import { ensureV2Ready } from './runtimeReady.js';

type IngestionRequest = { accountId: string } & (
    | { operation: 'indexes'; items: Parameters<typeof domain.ingestIndexes>[1]; page?: Parameters<typeof domain.ingestIndexes>[2] }
    | { operation: 'detail'; conversationId: string; detail: Parameters<typeof domain.ingestDetail>[2]; indexFields?: Parameters<typeof domain.ingestDetail>[3] }
    | { operation: 'deleted'; conversationId: string }
);
async function ingest(parameters: IngestionRequest): Promise<unknown> {
    const response: unknown = await chrome.runtime.sendMessage({ action: 'domainIngest', ...parameters });
    if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true) {
        throw new Error(response && typeof response === 'object' && 'error' in response ? String(response.error) : 'Domain ingestion unavailable');
    }
    return 'result' in response ? response.result : undefined;
}
const inExtension = () => typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
export const ingestIndexes: typeof domain.ingestIndexes = async (accountId, items, page) => {
    if (!inExtension()) {
        const result = await ingest({ operation: 'indexes', accountId, items, ...(page === undefined ? {} : { page }) });
        if (!result || typeof result !== 'object' || !('added' in result) || !('updated' in result)
            || typeof result.added !== 'number' || !Number.isSafeInteger(result.added) || result.added < 0
            || typeof result.updated !== 'number' || !Number.isSafeInteger(result.updated) || result.updated < 0
            || result.added + result.updated > items.length) throw new TypeError('Invalid committed Index ingestion result');
        return { added: result.added, updated: result.updated };
    }
    await ensureV2Ready();
    return domain.ingestIndexes(accountId, items, page);
};
export const ingestDetail: typeof domain.ingestDetail = async (accountId, conversationId, detail, indexFields) => {
    if (!inExtension()) {
        const result = await ingest({ operation: 'detail', accountId, conversationId, detail, ...(indexFields === undefined ? {} : { indexFields }) });
        if (!result || typeof result !== 'object' || !('accepted' in result) || !('changed' in result)
            || typeof result.accepted !== 'boolean' || typeof result.changed !== 'boolean'
            || (!result.accepted && result.changed)) throw new TypeError('Invalid committed Detail ingestion result');
        return { accepted: result.accepted, changed: result.changed };
    }
    await ensureV2Ready();
    return domain.ingestDetail(accountId, conversationId, detail, indexFields);
};

/** L1 calls this only after validating request-bound Provider deletion evidence. */
export const ingestDeletedConversation: typeof domain.ingestDeletedConversation = async (accountId, conversationId) => {
    if (!inExtension()) {
        await ingest({ operation: 'deleted', accountId, conversationId });
        return;
    }
    await ensureV2Ready();
    await domain.ingestDeletedConversation(accountId, conversationId);
};
