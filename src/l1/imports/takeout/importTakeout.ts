import { notifyDomainChanged } from '../../../runtime/api/domainChanges.js';
import type { Account } from '../../../l2/accountRegistry.js';
import type { SourceResourceContext } from '../../resources/sourceResources.js';
import { getAccount } from '../../../runtime/api/accountRegistry.js';
import { ingestDetail } from '../../../l2/ingestion.js';
import { parseGeminiTakeoutZipArchive, readTakeoutBytes } from './readArchive.js';
import { TakeoutParseError } from '../../../shared/types/errors.js';

export interface TakeoutParseResult { imported: number; status: 'ok' | 'partial' }

/** UI/acquisition adapter: native parsing precedes the one-way storage projection. */
export async function importTakeout(file: File, accountId: Account['id'], onProgress?: (percent: number) => void, resources?: SourceResourceContext): Promise<TakeoutParseResult> {
    if (!accountId) throw new TypeError('Takeout requires an account UUID');
    const account = await getAccount(accountId);
    if (!account || account.providerId !== 'gemini') throw new TypeError('Takeout requires an existing Gemini account');
    onProgress?.(15);
    const results = await parseGeminiTakeoutZipArchive(file, { account, providerId: 'gemini',
        onProgress: (completed, total) => onProgress?.(70 + Math.floor(completed / total * 18)),
        onArchiveReady: () => { onProgress?.(40); onProgress?.(70); },
    }).catch((error: unknown) => {
        if (error instanceof TakeoutParseError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('no recognized conversation identities') || message.includes('Unsupported Takeout')) throw new TakeoutParseError('Unsupported Takeout structure', true, 'MyActivity.html');
        throw new TakeoutParseError(message, false);
    });
    const importedIds = new Set(results.map(result => result.conversationId));
    let resourceFailure = false;
    for (const [resultIndex, result] of results.entries()) {
        const id = result.conversationId;
        const admission = await ingestDetail(accountId, id, result.conversation.detail, result.conversation.index);
        if (admission.accepted && resources) {
            resources.retainParsed({ accountId, conversationId: id }, result);
            for (const [assetId, bound] of Object.entries(result.archiveResources)) {
                resources.retain({ accountId, conversationId: id }, assetId, async () => {
                    const bytes = await readTakeoutBytes(bound.entry);
                    if (!bytes?.byteLength) throw new Error('Empty Takeout resource');
                    return { bytes };
                });
            }
        }
        for (const asset of result.conversation.detail.assets) {
            if (!result.archiveResources[asset.id] && ![asset.sourceUri, result.acquisitionHints[asset.id]?.url, result.acquisitionHints[asset.id]?.sourceUrl].some(uri => /^(?:https?:\/\/|\/\/|data:)/i.test(uri ?? ''))
                && !result.acquisitionHints[asset.id]?.dataBase64) resourceFailure = true;
        }
        if ((resultIndex + 1) % 50 === 0) {
            notifyDomainChanged(accountId);
            await new Promise<void>(resume => setTimeout(resume, 0));
        }
    }
    notifyDomainChanged(accountId);
    onProgress?.(100);
    return { imported: importedIds.size, status: resourceFailure
        || results.some(result => result.conversation.detail.quality.status !== 'complete') ? 'partial' : 'ok' };
}
