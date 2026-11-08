import { chatGPTSandboxLocator, chatGPTSandboxPath } from '../../resources/chatgptSandbox.js';
import type { BlockNode } from '../../../l2/content/blocks.js';
import type { InlineNode } from '../../../l2/content/inline.js';
import type { DomainAsset, ConversationDetail } from '../../../l2/conversationDetail.js';
import { assetIdForPointer } from './conversationTree.js';

/** Register Markdown resources before Domain closure, for live and archive sources. */
export function registerChatGPTMarkdownAssets(detail: Pick<ConversationDetail, 'assets' | 'messages'>, sourceMessageIds?: ReadonlyMap<string, string>): void {
    const assets = detail.assets;
    for (const message of detail.messages) {
        const messageId = message.id === undefined ? undefined : sourceMessageIds?.get(message.id);
        function register(uri: string, kind: DomainAsset['kind']): string {
            const sandboxPath = chatGPTSandboxPath(uri);
            const sourceUri = sandboxPath && messageId ? chatGPTSandboxLocator(messageId, sandboxPath) : uri;
            const existing = assets.find(asset => asset.id === uri || asset.sourceUri === sourceUri);
            if (existing) return existing.id;
            const base = `${kind}-${assetIdForPointer(sourceUri)}`;
            let id = base;
            for (let suffix = 1; assets.some(asset => asset.id === id); suffix++) id = `${base}-${suffix}`;
            const name = sandboxPath?.split('/').at(-1);
            assets.push({ id, kind, sourceUri, ...(name ? { name } : {}) });
            return id;
        }
        const files = new Set<string>();
        const inlines = (nodes: InlineNode[]): InlineNode[] => nodes.flatMap((node): InlineNode[] => {
            if (node.type === 'image') return [{ ...node, assetId: register(node.assetId, 'image') }];
            if (node.type === 'link' && /^sandbox:\/mnt\/data\//.test(node.href)) {
                files.add(register(node.href, 'file'));
                return inlines(node.children);
            }
            return ['children' in node ? { ...node, children: inlines(node.children) } : node];
        });
        const blocks = (nodes: BlockNode[]): BlockNode[] => nodes.map(node => {
            switch (node.type) {
                case 'paragraph': case 'heading': return { ...node, children: inlines(node.children) };
                case 'image': return { ...node, assetId: register(node.assetId, 'image'), ...(node.caption ? { caption: inlines(node.caption) } : {}) };
                case 'quote': return { ...node, blocks: blocks(node.blocks) };
                case 'list': return { ...node, items: node.items.map(item => ({ ...item, blocks: blocks(item.blocks) })) };
                case 'table': {
                    const rows = (rows: typeof node.rows) => rows.map(row => ({ ...row, cells: row.cells.map(cell => ({ ...cell, children: inlines(cell.children) })) }));
                    return { ...node, rows: rows(node.rows), ...(node.headerRows ? { headerRows: rows(node.headerRows) } : {}),
                        ...(node.caption ? { caption: inlines(node.caption) } : {}) };
                }
                default: return node;
            }
        });
        message.content = blocks(message.content);
        if (message.reasoning) message.reasoning = blocks(message.reasoning);
        message.content.push(...[...files].map(assetId => ({ type: 'file' as const, assetId })));
    }
}
