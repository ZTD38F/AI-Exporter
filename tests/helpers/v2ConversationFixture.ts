import { ingestDetail } from '../../src/l2/ingestion.js';
import type { DomainAsset, DomainConversationDetail } from '../../src/l2/conversationDetail.js';
import type { ConversationIndexPatch } from '../../src/l2/conversationIndex.js';
export const A = '10000000-0000-4000-8000-000000000001';
export const B = '10000000-0000-4000-8000-000000000002';
export const key = (conversationId = 'chat', accountId = A) => ({ accountId, conversationId });
/** Input construction only; all validation, merging and persistence run through production L2. */
export async function seed(id = 'chat', options: { accountId?: string; fields?: ConversationIndexPatch;
    quality?: 'complete' | 'partial' | 'unknown'; savedAt?: number; assets?: DomainAsset[]; body?: string } = {}) {
    const conversationKey = key(id, options.accountId);
    const detail: Omit<DomainConversationDetail, 'key'> = { quality: { status: options.quality ?? 'complete' },
        ...(options.savedAt !== undefined ? { savedAt: options.savedAt } : {}), assets: options.assets ?? [],
        messages: [{ role: 'user', content: [{ type: 'paragraph', children: [{ type: 'text', text: options.body ?? 'Independent body' }] }] }] };
    await ingestDetail(conversationKey.accountId, id, detail, options.fields ?? { title: 'Research', titleSource: 'provider', updatedAt: options.savedAt ?? 50 });
    return conversationKey;
}
