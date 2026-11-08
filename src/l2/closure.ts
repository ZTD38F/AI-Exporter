import type { DomainConversationDetail } from './conversationDetail.js';
import type { BlockNode } from './content/blocks.js';
import type { InlineNode } from './content/inline.js';

/** Domain is a closed, JSON-portable semantic graph; invalid references never reach exporters. */
export function assertDomainClosure(conversation: Pick<DomainConversationDetail, 'assets' | 'messages'>): void {
    const assets = new Set<string>();
    for (const asset of conversation.assets) {
        if (!asset.id || assets.has(asset.id)) throw new TypeError(`Duplicate or empty Domain asset identity: ${asset.id}`);
        assets.add(asset.id);
    }
    conversation.messages.forEach((message, index) => {
        const citations = new Set<string>();
        for (const citation of message.citations ?? []) {
            if (!citation.id || citations.has(citation.id)) throw new TypeError(`Duplicate or empty Domain citation identity in messages[${index}]`);
            citations.add(citation.id);
        }
        const reference = (ref: string): void => {
            if (!assets.has(ref)) throw new TypeError(`Unregistered Domain asset '${ref}' in messages[${index}]`);
        };
        const checkInline = (node: InlineNode): void => {
            if (node.type === 'citationRef' && !citations.has(node.citationId)) {
                throw new TypeError(`Unregistered Domain citation '${node.citationId}' in messages[${index}]`);
            }
            if (node.type === 'image') reference(node.assetId);
            if ('children' in node) node.children.forEach(checkInline);
        };
        const checkBlock = (node: BlockNode): void => {
            switch (node.type) {
                case 'paragraph':
                case 'heading':
                    node.children.forEach(checkInline);
                    return;
                case 'list':
                    node.items.forEach(item => item.blocks.forEach(checkBlock));
                    return;
                case 'quote':
                    node.blocks.forEach(checkBlock);
                    return;
                case 'table':
                    node.caption?.forEach(checkInline);
                    node.headerRows?.forEach(row => row.cells.forEach(cell => cell.children.forEach(checkInline)));
                    node.rows.forEach(row => row.cells.forEach(cell => cell.children.forEach(checkInline)));
                    return;
                case 'image':
                    reference(node.assetId);
                    node.caption?.forEach(checkInline);
                    return;
                case 'file':
                    reference(node.assetId);
                    node.description?.forEach(checkInline);
                    return;
                case 'code':
                case 'math':
                case 'thematicBreak':
                case 'unknown':
                    return;
                default: {
                    const exhaustive: never = node;
                    return exhaustive;
                }
            }
        };
        message.content.forEach(checkBlock);
        message.reasoning?.forEach(checkBlock);
        const owned = message.attachmentIds ?? [];
        if (new Set(owned).size !== owned.length) throw new TypeError(`Duplicate Domain attachment reference in messages[${index}]`);
        owned.forEach(reference);
    });
}
