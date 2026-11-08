import { readAccount, type Account } from '../../l2/accountRegistry.js';
import { sameConversationKey } from '../../l2/conversationKey.js';
import type { ReadonlyDomain } from '../../l2/runtimeValidation.js';
import { readingLabels } from './resourcePresentation.js';
import { contentComposer } from './composeContent.js';
import type { BlockNode } from '../../l2/content/blocks.js';
import type { DisplayBlock, DocumentAst, SourceItem } from '../ast/ast.js';

/** Trusted Domain facts -> one format-neutral reading tree. No I/O or output policy. */
export function composeDomainDocument(conversation: ReadonlyDomain, account: Readonly<Account>): DocumentAst {
    readAccount(account);
    if (account.id !== conversation.index.key.accountId ||
        !sameConversationKey(conversation.index.key, conversation.detail.key)) {
        throw new TypeError('Composition Account/key mismatch');
    }

    const assets = new Map(conversation.detail.assets.map(asset => [asset.id, asset]));
    let nextCitationNumber = 0;
    const messages = conversation.detail.messages.map(message => {
        const citations = (message.citations ?? []).map(citation => ({
            citation,
            number: ++nextCitationNumber,
            href: citation.url?.trim() ? citation.url : undefined,
            label: (citation.title?.trim() ? citation.title : undefined)
                ?? (citation.url?.trim() ? citation.url : undefined) ?? '',
        }));
        const byId = new Map(citations.map(item => [item.citation.id, item]));
        const source = (id: string, explicit?: string) => {
            // L2 guarantees each reference resolves within this message.
            const item = byId.get(id);
            if (!item) throw new TypeError(`Unresolved Domain citation: ${id}`);
            return {
                id,
                label: explicit?.trim() ? explicit : '[' + item.number + ']',
                ...(item.href !== undefined ? { href: item.href } : {}),
            };
        };
        const compose = contentComposer(assets, source);
        const attachments = (message.attachmentIds ?? []).map((id): BlockNode => {
            const asset = assets.get(id);
            if (!asset) throw new TypeError(`Unresolved Domain asset: ${id}`);
            return asset.kind === 'image'
                ? { type: 'image', assetId: id, alt: asset.name }
                : { type: 'file', assetId: id, label: asset.name };
        });
        const blocks: DisplayBlock[] = [];
        if (message.reasoning?.length) blocks.push({ type: 'disclosure', kind: 'reasoning', title: readingLabels.reasoning, blocks: compose(message.reasoning) });
        blocks.push(...compose([...message.content, ...attachments]));
        const sources: SourceItem[] = citations.map(({ citation, number, href, label }) => ({
            id: citation.id,
            label,
            ...(href !== undefined ? { href } : {}),
            number,
        }));
        return {
            role: message.role,
            ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
            ...(message.model !== undefined ? { modelLabel: message.model } : {}),
            blocks,
            ...(sources.length ? { sources } : {}),
        };
    });

    return {
        title: conversation.index.title ?? readingLabels.title,
        metadata: {
            id: conversation.index.key.conversationId,
            provider: account.providerId,
            ...(conversation.index.createdAt !== undefined ? { createdAt: conversation.index.createdAt } : {}),
            ...(conversation.index.updatedAt !== undefined ? { updatedAt: conversation.index.updatedAt } : {}),
        },
        messages,
    };
}
