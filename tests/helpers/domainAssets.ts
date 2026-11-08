import type { DomainAsset } from '../../src/l2/conversationDetail.js';
import type { DomainConversationWithDetail } from '../../src/l2/conversation.js';

/** Follow the public Domain relationship rather than assuming registry/message array positions coincide. */
export function messageAssets(domain: DomainConversationWithDetail, index = 0): DomainAsset[] {
    return (domain.detail.messages[index]?.attachmentIds ?? []).map(id => {
        const asset = domain.detail.assets.find(candidate => candidate.id === id);
        if (!asset) throw new Error(`Missing test resource: ${id}`);
        return asset;
    });
}
