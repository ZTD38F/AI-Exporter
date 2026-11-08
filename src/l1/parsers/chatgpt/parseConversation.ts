import { registerChatGPTMarkdownAssets } from './registerMarkdownAssets.js';
import type { chatGPTInteractiveSnapshot } from './interactiveSnapshot.js';
import type { Account } from '../../../l2/accountRegistry.js';
import type { ResourceAcquisitionHint } from '../../resources/resourceAcquisition.js';
import type { SourceTurnStatus } from '../../../l2/quality.js';
import { contentQuality } from '../qualityEvidence.js';
import { parseIndexMetadata } from '../shared/parseIndexMetadata.js';
/**
 * Acquisition (session/list/detail/downloads) stays in the provider; only this
 * parser module may call validateParserDomain for ChatGPT payloads, mirroring
 * the Gemini rpc/dom/takeout parser ownership in the trust boundary.
 */
import type {
    DomainAsset,
    DomainMessage,
} from '../../../l2/conversationDetail.js';
import type { BlockNode } from '../../../l2/content/blocks.js';
import type { Diagnostic } from '../../../shared/diagnostics/diagnostic.js';
import type { SourceConversationParseResult } from '../parsingResult.js';
import {
    parseMarkdownToBlocks,
    type MarkdownParseContext,
} from '../shared/markdown/index.js';
import type {
    ChatGPTApiConversationWithId,
    ChatGPTConversationNode,
} from './chatgptTypes.js';
import {
    citationsOfChatGPTNode,
    collectChatGPTThinking,
    type ChatGPTThinking,
    uploadedFilesOfChatGPTNode,
} from './conversationDetail.js';
import {
    assetIdForPointer,
    chatGPTNodeRole,
    chatGPTNodeSegments,
    extractChatGPTModelSlug,
    processChatGPTMapping,
} from './conversationTree.js';
import { preprocessChatGPTMarkdown } from './markdownCompatibility.js';

interface ChatGPTParsedImage {
    pointer: string;
    assetId: string;
    dataBase64: string;
    mediaType?: string;
    fileName?: string;
    byteLength?: number;
}

interface ChatGPTParsedFile {
    id: string;
    name: string;
    mediaType?: string;
    byteLength?: number;
    dataBase64?: string;
}

interface ChatGPTNodeAssets {
    nodeId: string;
    images: ChatGPTParsedImage[];
    files: ChatGPTParsedFile[];
}

interface ChatGPTParseInput {
    source?: 'api' | 'archive';
    account?: Account;
    conversation: ChatGPTApiConversationWithId;
    assetsByNode: Map<string, ChatGPTNodeAssets>;
}

function parseBody(text: string, nodeId: string, ctx: MarkdownParseContext): BlockNode[] {
    if (!text.trim()) return [];
    return parseMarkdownToBlocks(preprocessChatGPTMarkdown(text), nodeId, ctx);
}

function reasoningOfThinking(thinking: ChatGPTThinking, nodeId: string, ctx: MarkdownParseContext): BlockNode[] {
    const blocks: BlockNode[] = [];
    const head: string[] = [];
    if (thinking.durationSeconds !== undefined) head.push(`思考用时约 ${thinking.durationSeconds} 秒`);
    if (thinking.activities.length > 0) head.push(thinking.activities.join(' / '));
    if (head.length > 0) {
        blocks.push({ type: 'paragraph', children: [{ type: 'text', text: `【思考过程】${head.join('；')}` }] });
    }
    for (const thought of thinking.thoughts) {
        const text = thought.summary
            ? `**${thought.summary}**\n\n${thought.content}`
            : thought.content;
        blocks.push(...parseBody(text, nodeId, ctx));
    }
    return blocks;
}

function messageOfNode(
    node: ChatGPTConversationNode,
    branchSlug: string,
    assets: DomainAsset[],
    acquisitionHints: Record<string, ResourceAcquisitionHint>,
    seenAssetIds: Set<string>,
    resolved: ChatGPTNodeAssets | undefined,
    thinking: ChatGPTThinking | undefined,
    ctx: MarkdownParseContext,
): DomainMessage {
    const content: BlockNode[] = [];
    // P0: asset identity is conversation-global (closure rejects duplicates),
    // so repeated pointers reuse the first asset instead of pushing a twin.
    const claim = (assetId: string): boolean => {
        if (seenAssetIds.has(assetId)) return false;
        seenAssetIds.add(assetId);
        return true;
    };
    for (const seg of chatGPTNodeSegments(node)) {
        if (seg.kind === 'text') {
            content.push(...parseBody(seg.text, node.id, ctx));
            continue;
        }
        const image = resolved?.images.find((img) => img.pointer === seg.pointer);
        const assetId = image?.assetId ?? assetIdForPointer(seg.pointer);
        if (claim(assetId)) {
            if (image) {
                acquisitionHints[assetId] = { dataBase64: image.dataBase64 };
                assets.push({
                    id: assetId,
                    kind: 'image',
                    name: image.fileName,
                    mediaType: image.mediaType,
                    byteLength: image.byteLength,
                    sourceUri: image.pointer,
                });
            } else {
                // Record identity now; resource acquisition happens after parsing.
                assets.push({
                    id: assetId,
                    kind: 'image',
                    sourceUri: seg.pointer,
                });
                ctx.diagnostics.push({
                    id: `image-deferred:${node.id}:${assetId}`,
                    severity: 'info',
                    code: 'CHATGPT_IMAGE_ASSET_DEFERRED',
                    message: `Image asset '${seg.pointer}' registered for on-demand acquisition`,
                    sourceRef: ctx.sourceRef,
                    path: `messages[${node.id}].assets[${assetId}]`,
                });
            }
        }
        content.push({ type: 'image', assetId });
    }
    for (const file of uploadedFilesOfChatGPTNode(node)) {
        const bytes = resolved?.files.find((f) => f.id === file.id);
        const assetId = `file-${file.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        if (bytes?.dataBase64) acquisitionHints[assetId] = { dataBase64: bytes.dataBase64 };
        if (claim(assetId)) {
            assets.push({
                id: assetId,
                kind: 'file',
                name: file.name,
                mediaType: bytes?.mediaType ?? file.mediaType,
                byteLength: bytes?.byteLength ?? file.byteLength,
                sourceUri: `file-download:${file.id}`,
            });
        }
        content.push({ type: 'file', assetId, label: file.name });
    }
    const citations = citationsOfChatGPTNode(node);
    // P2: each message keeps its own model; the branch-latest slug is fallback.
    const model = node.message?.metadata?.model_slug || branchSlug || undefined;
    return {
        id: node.id,
        role: chatGPTNodeRole(node),
        model,
        content,
        timestamp: node.message?.createdAtMs,
        ...(() => {
            const reasoning = thinking ? reasoningOfThinking(thinking, node.id, ctx) : [];
            return reasoning.length > 0 ? { reasoning } : {};
        })(),
        ...(citations.length > 0 ? { citations } : {}),
    };
}

/** Provider termination evidence does not establish missing exported body content. */
function sourceTurnStatus(conversation: ChatGPTApiConversationWithId): SourceTurnStatus {
    const leaf = conversation.mapping.get(conversation.current_node)?.message;
    if (!leaf) return 'unknown';
    if (leaf.author.role === 'user') return 'awaiting_reply';
    if (leaf.author.role === 'tool') return 'tool_pending';
    if (leaf.author.role !== 'assistant') return 'unknown';
    if (leaf.status === 'interrupted' || leaf.metadata?.finish_details?.type === 'interrupted') return 'interrupted';
    if (leaf.recipient === 'local.handoff') return 'handoff';
    if (leaf.recipient !== 'all') return leaf.recipient ? 'tool_pending' : 'unknown';
    // Visibility controls exported content, not the provider's explicit end-of-turn signal.
    if (leaf.metadata?.is_thinking_preamble_message || ['thoughts', 'reasoning_recap'].includes(leaf.content.content_type))
        return leaf.status === 'in_progress' || leaf.end_turn === false ? 'unfinished' : 'unknown';
    if (leaf.status === 'in_progress') return 'unfinished';
    if (leaf.end_turn === true && leaf.status === 'finished_successfully') return 'finished';
    if (leaf.end_turn === false && (leaf.status === undefined || leaf.status === 'finished_successfully')) return 'unfinished';
    return 'unknown';
}

/** A renderable branch is not necessarily a complete source chain. Missing
 * parents, cycles and absent current_node must never claim full body coverage. */
function branchCoverage(conversation: ChatGPTApiConversationWithId, nodes: readonly ChatGPTConversationNode[], diagnostics: Diagnostic[]): 'complete' | 'partial' | 'unknown' {
    const incomplete = (reason: string, nodeId?: string): 'partial' | 'unknown' => {
        const rendered = new Set(nodes.map(node => node.id));
        const summarize = (id: string) => {
            const node = conversation.mapping.get(id);
            const message = node?.message;
            return { id, exists: !!node, rendered: rendered.has(id), role: message?.author.role ?? null,
                recipient: message?.recipient ?? null, channel: message?.channel ?? null,
                contentType: message?.content.content_type ?? null, status: message?.status ?? null,
                endTurn: message?.end_turn ?? null, hidden: message?.metadata?.is_visually_hidden_from_conversation ?? false,
                thinkingPreamble: message?.metadata?.is_thinking_preamble_message ?? false,
                childCount: node?.children.length ?? 0 };
        };
        const seen = new Set<string>();
        const tail: ReturnType<typeof summarize>[] = [];
        let id: string | undefined = conversation.current_node;
        let chainEnd = conversation.current_node ? 'root' : 'no_current_node';
        while (id) {
            if (seen.has(id)) { chainEnd = 'cycle'; break; }
            const node = conversation.mapping.get(id);
            if (!node) { chainEnd = 'missing'; break; }
            seen.add(id);
            if (tail.length < 8) tail.push(summarize(id));
            id = node.parent;
        }
        diagnostics.push({ severity: 'info', code: 'CHATGPT_BRANCH_COVERAGE_INCOMPLETE',
            message: 'Source branch cannot prove complete body coverage',
            details: { reason, currentNode: conversation.current_node ?? null, nodeId: nodeId ?? null,
                mappingNodeCount: conversation.mapping.size, leafRole: leaf?.author.role ?? null,
                leafStatus: leaf?.status ?? null, leafEndTurn: leaf?.end_turn ?? null,
                renderedNodeCount: nodes.length, branchNodeCount: seen.size, chainEnd, tail,
                leafChildren: (conversation.mapping.get(conversation.current_node)?.children ?? []).slice(0, 8).map(summarize) } });
        return reason === 'current_node_missing' || reason === 'chain_unresolved' ? 'unknown' : 'partial';
    };
    const leaf = conversation.current_node ? conversation.mapping.get(conversation.current_node)?.message : undefined;
    if (!conversation.current_node) return incomplete('current_node_missing');
    // Turn termination is a separate fact: a stopped reply can still be fully saved.
    let id: string | undefined = conversation.current_node;
    const seen = new Set<string>();
    while (id) {
        if (seen.has(id)) return incomplete('ancestor_cycle', id);
        seen.add(id);
        const node: ChatGPTConversationNode | undefined = conversation.mapping.get(id);
        if (!node) return incomplete('ancestor_missing', id);
        if (node.message?.recipient === 'local.handoff'
            && !node.message.metadata?.is_visually_hidden_from_conversation
            && !node.message.metadata?.is_thinking_preamble_message
            && !nodes.some(rendered => rendered.id === id)) return incomplete('handoff_content_unrepresented', id);
        if (node.parent == null) return 'complete';
        id = node.parent;
    }
    return incomplete('chain_unresolved');
}

/** Linearize source messages; final Domain validation belongs to L2. */
export function parseChatGPTConversation(input: ChatGPTParseInput): SourceConversationParseResult {
    const { conversation } = input;
    const contentDiagnostics: Diagnostic[] = [];
    const ctx: MarkdownParseContext = {
        diagnostics: contentDiagnostics,
        sourceRef: { providerId: 'chatgpt', locator: `conversation:${conversation.id}` },
    };
    // Preserve the source snapshot produced during branch projection; do not reparse its rendered text.
    const snapshots = new Map<string, ReturnType<typeof chatGPTInteractiveSnapshot>>();
    const nodes = processChatGPTMapping(conversation, snapshots);
    const interactiveSnapshots = nodes.flatMap(node => {
        const raw = conversation.mapping.get(node.id)?.message;
        const snapshot = snapshots.get(node.id);
        return snapshot && raw?.metadata?.model_dil_v2 && raw.content.content_type === 'text'
            ? [{ messageId: raw.id, snapshot }] : [];
    });
    const interactiveIncomplete = interactiveSnapshots.some(({ snapshot }) => snapshot.incomplete);
    for (const { messageId, snapshot } of interactiveSnapshots) {
        if (!snapshot.interactive && !snapshot.modules.length && !snapshot.unsupported.length) continue;
        contentDiagnostics.push({
            id: `chatgpt-interactive-snapshot:${messageId}`, severity: snapshot.incomplete ? 'warning' : 'info',
            code: snapshot.incomplete ? 'CHATGPT_INTERACTIVE_CONTENT_INCOMPLETE' : 'CHATGPT_INTERACTIVE_STATIC_SNAPSHOT',
            message: snapshot.incomplete
                ? 'Some source components could not be parsed and have no usable Markdown fallback.'
                : 'Source components are represented as ordered static content; unsupported content uses provider Markdown when available.',
            sourceRef: { ...ctx.sourceRef, providerMessageId: messageId },
            details: { representation: snapshot.representation,
                interactiveBehaviorPreserved: false, modules: snapshot.modules,
                fallbackBlocks: snapshot.fallbackBlocks, unsupported: snapshot.unsupported },
        });
    }
    const branchSlug = extractChatGPTModelSlug(conversation.mapping, nodes);
    const startId = conversation.current_node || nodes[nodes.length - 1]?.id || '';
    const thinkingByNode = collectChatGPTThinking(
        conversation.mapping,
        new Set(nodes.map((n) => n.id)),
        startId,
    );
    const assets: DomainAsset[] = [];
    const acquisitionHints: Record<string, ResourceAcquisitionHint> = {};
    const seenAssetIds = new Set<string>();
    const messages: DomainMessage[] = nodes.map((node) =>
        messageOfNode(
            node,
            branchSlug,
            assets,
            acquisitionHints,
            seenAssetIds,
            input.assetsByNode.get(node.id),
            thinkingByNode.get(node.id),
            { ...ctx, sourceRef: { ...ctx.sourceRef, providerMessageId: node.id } },
        ),
    );
    const sourceMessageIds = input.source === 'archive' ? undefined
        : new Map(nodes.flatMap((node): [string, string][] => node.message ? [[node.id, node.message.id]] : []));
    registerChatGPTMarkdownAssets({ assets, messages }, sourceMessageIds);
    // Source activity versions travel beside Detail; Index owns updatedAt.
    const sourceVersion = conversation.updatedAtMs;
    const branchQuality = branchCoverage(conversation, nodes, contentDiagnostics);
    const sourceTurn = sourceTurnStatus(conversation);
    const leaf = conversation.mapping.get(conversation.current_node)?.message;
    contentDiagnostics.push({ severity: 'info', code: 'CHATGPT_SOURCE_TURN_STATUS',
        message: 'Source turn completion is independent of snapshot coverage',
        details: { sourceTurn, snapshotCoverage: branchQuality, currentNode: conversation.current_node,
            leafRole: leaf?.author.role ?? null, hidden: leaf?.metadata?.is_visually_hidden_from_conversation ?? false,
            thinkingPreamble: leaf?.metadata?.is_thinking_preamble_message ?? false,
            recipient: leaf?.recipient ?? null, channel: leaf?.channel ?? null,
            contentType: leaf?.content.content_type ?? null, status: leaf?.status ?? null,
            endTurn: leaf?.end_turn ?? null, finishType: leaf?.metadata?.finish_details?.type ?? null } });
    return {
        ...(sourceVersion !== undefined ? { sourceVersion } : {}),
        conversationId: conversation.id,
        conversation: {
            index: parseIndexMetadata({ providerId: 'chatgpt', id: conversation.id,
                title: conversation.title?.trim() || '', titleSource: 'provider',
                createdAt: conversation.createdAtMs, updatedAt: sourceVersion,
                messageCount: messages.length, url: `https://chatgpt.com/c/${conversation.id}` }),
            detail: { ...(sourceVersion !== undefined ? { savedAt: sourceVersion } : {}), quality: contentQuality({ status: interactiveIncomplete ? 'partial' : branchQuality, sourceTurn }), assets, messages },
        },
        diagnostics: contentDiagnostics,
        acquisitionHints,
    };
}
