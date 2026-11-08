/**
 * Pure ChatGPT mapping-tree helpers, ported from pionxzh/chatgpt-exporter (MIT).
 * No fetch, no DOM — fully unit-testable.
 * @unverified-provider-scaffold Awaiting 9222 live-payload verification.
 */
import { chatGPTInteractiveSnapshot } from './interactiveSnapshot.js';
import type {
    ChatGPTApiConversationWithId,
    ChatGPTConversationNode,
    ChatGPTNodeMessage,
} from './chatgptTypes.js';

function isTextContent(
    message: ChatGPTNodeMessage,
): message is ChatGPTNodeMessage & { content: { content_type: 'text'; parts: string[] } } {
    return message.content.content_type === 'text';
}

/** Tool/image messages that carry renderable images are kept; pure tool chatter is dropped. */
function toolMessageHasImage(message: ChatGPTNodeMessage): boolean {
    const content = message.content;
    if (content.content_type === 'execution_output') {
        const messages = message.metadata?.aggregate_result?.messages;
        return Array.isArray(messages) && messages.some((m) => m.message_type === 'image');
    }
    if (content.content_type === 'multimodal_text') {
        return Array.isArray(content.parts) && content.parts.some(
            (p) => typeof p !== 'string' && p.content_type === 'image_asset_pointer',
        );
    }
    return false;
}

/** Mirrors pionxzh shouldSkipMessageInExport: keep only user-visible turns. */
export function shouldSkipChatGPTMessage(message?: ChatGPTNodeMessage): boolean {
    if (!message || !message.content) return true;
    if (message.metadata?.is_visually_hidden_from_conversation || message.metadata?.is_thinking_preamble_message) return true;
    if (message.recipient === 'local.handoff') return message.author.role !== 'assistant' || !message.handoffReason;
    if (message.recipient !== 'all') return true;
    const ct = message.content.content_type;
    if (ct === 'thoughts' || ct === 'reasoning_recap') return true;
    if (
        message.author.role === 'assistant'
        && isTextContent(message)
        && !message.content.parts.join('').trim()
        && !message.metadata?.model_dil_v2
    ) {
        return true;
    }
    if (message.author.role === 'tool') {
        // File-search grinding and other tool chatter stays out, but image
        // results (code-execution output, multimodal asset pointers) are kept
        // so generated/uploaded pictures survive the export.
        if (message.author.name === 'file_search') return true;
        if (!toolMessageHasImage(message)) return true;
        return false;
    }
    return false;
}

/** Bind galleries through static query/resolution IDs; never execute DIL code or
 * infer ordering from componentResults object insertion order. */
function dilGalleryParts(text: string, message: ChatGPTNodeMessage): Array<string | { content_type: string; asset_pointer: string }> | null {
    const markers = [...text.matchAll(/\uE200image_group\uE202([^\uE201]*)\uE201/g)];
    if (!markers.length) return null;
    const dil = message.metadata?.model_dil_v2;
    const results = dil?.appData?.opGenui?.componentResults;
    const bindings = new Map<string, string[]>();
    // This deliberately accepts only observed, literal AsyncImage props. Dynamic
    // expressions remain fallback text instead of being guessed or evaluated.
    for (const match of (dil?.code ?? '').matchAll(/__dil\.jsx\(AsyncImage,\{([^{}]*)\}\)/g)) {
        const query = /"query":("(?:\\.|[^"\\])*")/.exec(match[1]);
        const resolution = /"__resolutionId":__dilConstants\["([^"\]]+)"\]/.exec(match[1]);
        if (!query || !resolution) continue;
        const id = dil?.constants?.get(resolution[1]);
        if (id === undefined) continue;
        try {
            const key: unknown = JSON.parse(query[1]);
            if (typeof key === 'string') bindings.set(key, [...(bindings.get(key) ?? []), id]);
        } catch { /* Nonliteral props are not eligible. */ }
    }
    const resolved = [...(results?.values() ?? [])].filter(item => item?.componentName === 'AsyncImage' && item.status === 'resolved');
    const parts: Array<string | { content_type: string; asset_pointer: string }> = [];
    let cursor = 0, converted = false;
    for (const marker of markers) {
        let result: typeof resolved[number] | undefined;
        try {
            const payload: unknown = JSON.parse(marker[1]);
            if (payload && typeof payload === 'object' && 'query' in payload && Array.isArray(payload.query) && payload.query.length === 1
                && typeof payload.query[0] === 'string') {
                const ids = bindings.get(payload.query[0]);
                if (ids?.length === 1) result = results?.get(ids[0]);
            }
        } catch { /* Preserve malformed markers. */ }
        if (!result && markers.length === 1 && resolved.length === 1) result = resolved[0];
        const selected = result;
        const pointers = selected?.componentName === 'AsyncImage' && selected.status === 'resolved'
            ? selected.imageUrls : [];
        parts.push(text.slice(cursor, marker.index));
        if (pointers.length) {
            parts.push(...[...new Set(pointers)].map(pointer => ({ content_type: 'image_asset_pointer', asset_pointer: pointer })));
            converted = true;
        } else parts.push(marker[0]);
        cursor = (marker.index ?? 0) + marker[0].length;
    }
    parts.push(text.slice(cursor));
    return converted ? parts : null;
}

/** Copy a node so repeat exports never mutate the cached raw mapping. */
function copyChatGPTNode(node: ChatGPTConversationNode, snapshots?: Map<string, ReturnType<typeof chatGPTInteractiveSnapshot>>): ChatGPTConversationNode {
    const message = node.message;
    if (!message) return { ...node };
    if (message.recipient === 'local.handoff' && message.handoffReason) {
        return { ...node, message: { ...message, recipient: 'all',
            content: { content_type: 'text', parts: ['Continue in ChatGPT Work\n\n' + message.handoffReason] } } };
    }
    if (isTextContent(message)) {
        const snapshot = message.metadata?.model_dil_v2
            ? chatGPTInteractiveSnapshot(message.content.parts.join(''), message.metadata.model_dil_v2.fallbackMarkdown)
            : undefined;
        if (snapshot) snapshots?.set(node.id, snapshot);
        // Normalize the provider fallback dialect only after source selection.
        // Rewriting fallback first can invent a disagreement with correct source
        // and replace exact code bodies with provider-reformatted code.
        const parts = snapshot ? [snapshot.fallbackBlocks ? snapshot.text.replace(
            /\\\(([\s\S]*?)\\\)/g, (_raw, math: string) => `\\(${math.replace(/\\\\\|/g, '\\Vert{}')}\\)`)
            : snapshot.text] : [...message.content.parts];
        const gallery = dilGalleryParts(parts.join(''), message);
        return {
            ...node,
            message: { ...message, content: gallery ? { content_type: 'multimodal_text', parts: gallery }
                : { content_type: 'text', parts }, metadata: message.metadata && { ...message.metadata } },
        };
    }
    return {
        ...node,
        message: { ...message, metadata: message.metadata && { ...message.metadata } },
    };
}

export function extractChatGPTLinearNodes(
    mapping: ReadonlyMap<string, ChatGPTConversationNode>,
    startNodeId: string,
    snapshots?: Map<string, ReturnType<typeof chatGPTInteractiveSnapshot>>,
): ChatGPTConversationNode[] {
    const result: ChatGPTConversationNode[] = [];
    let currentId: string | undefined = startNodeId;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const node: ChatGPTConversationNode | undefined = mapping.get(currentId);
        if (!node || node.parent === undefined) break;
        const role = node.message?.author.role;
        const ct = node.message?.content.content_type;
        if (
            role !== 'system'
            && ct !== 'model_editable_context'
            && ct !== 'user_editable_context'
            && !shouldSkipChatGPTMessage(node.message)
        ) {
            result.unshift(copyChatGPTNode(node, snapshots));
        }
        currentId = node.parent;
    }
    return result;
}

/** Latest model_slug on the current branch wins (model can change mid-chat). */
export function extractChatGPTModelSlug(
    mapping: ReadonlyMap<string, ChatGPTConversationNode>,
    linearNodes: ChatGPTConversationNode[],
): string {
    for (let i = linearNodes.length - 1; i >= 0; i -= 1) {
        const slug = linearNodes[i]?.message?.metadata?.model_slug;
        if (slug) return slug;
    }
    for (const node of mapping.values()) {
        const slug = node.message?.metadata?.model_slug;
        if (slug) return slug;
    }
    return '';
}

/**
 * Linearize current_node -> root without auto-merging adjacent assistant turns
 * so per-turn structure, citations and model metadata stay intact.
 */
export function processChatGPTMapping(
    conversation: ChatGPTApiConversationWithId,
    snapshots?: Map<string, ReturnType<typeof chatGPTInteractiveSnapshot>>,
): ChatGPTConversationNode[] {
    const startId =
        conversation.current_node
        || [...conversation.mapping.values()].find((n) => !n.children || n.children.length === 0)?.id;
    // An empty/unattributable mapping is incomplete source evidence, not a parser crash.
    // The L1 caller will return zero messages and L2 quality remains 'unknown'.
    if (!startId) return [];
    return extractChatGPTLinearNodes(conversation.mapping, startId, snapshots);
}

function chatGPTNodeText(node: ChatGPTConversationNode): string {
    const content = node.message?.content;
    if (!content) return '';
    if (content.content_type === 'text') return Array.isArray(content.parts) ? content.parts.join('') : '';
    if (content.content_type === 'code' || content.content_type === 'execution_output') {
        return content.text ?? '';
    }
    if (content.content_type === 'multimodal_text') {
        return (content.parts ?? [])
            .map((p: string | { content_type: string; asset_pointer?: string }) => (typeof p === 'string' ? p : ''))
            .join('');
    }
    if (content.content_type === 'reasoning_recap') return content.content ?? '';
    return '';
}

/** Deterministic asset id derived from the pointer (stable across exports). */
export function assetIdForPointer(pointer: string): string {
    if (/^https:\/\//.test(pointer)) {
        // Signed gallery URLs can exceed filesystem component limits.
        let hash = 0xcbf29ce484222325n;
        for (const byte of new TextEncoder().encode(pointer)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
        return `img-url-${hash.toString(16).padStart(16, '0')}`;
    }
    return `img-${pointer.replace('sediment://', '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

type ChatGPTNodeSegment =
    | { kind: 'text'; text: string }
    | { kind: 'image'; pointer: string };

/**
 * Ordered text and image segments of a node so mixed text+image turns
 * (`multimodal_text` and `execution_output`) preserve their in-place order.
 */
export function chatGPTNodeSegments(node: ChatGPTConversationNode): ChatGPTNodeSegment[] {
    const content = node.message?.content;
    if (!content) return [];
    if (content.content_type === 'multimodal_text' && Array.isArray(content.parts)) {
        const segments: ChatGPTNodeSegment[] = [];
        let pendingText = '';
        const flushText = (): void => {
            if (pendingText.trim()) {
                segments.push({ kind: 'text', text: pendingText });
            }
            pendingText = '';
        };
        for (const p of content.parts) {
            if (typeof p === 'string') {
                pendingText += p;
            } else if (p.content_type === 'image_asset_pointer' && p.asset_pointer) {
                flushText();
                segments.push({ kind: 'image', pointer: p.asset_pointer });
            }
        }
        flushText();
        return segments;
    }
    if (content.content_type === 'execution_output') {
        const segments: ChatGPTNodeSegment[] = [];
        const text = content.text ?? '';
        if (text.trim()) {
            segments.push({ kind: 'text', text });
        }
        const messages = node.message?.metadata?.aggregate_result?.messages;
        if (Array.isArray(messages)) {
            for (const m of messages) {
                if (m.message_type === 'image' && m.image_url) {
                    segments.push({ kind: 'image', pointer: m.image_url });
                }
            }
        }
        return segments;
    }
    const text = chatGPTNodeText(node);
    return text.trim() ? [{ kind: 'text', text }] : [];
}

export function chatGPTNodeRole(node: ChatGPTConversationNode): 'user' | 'assistant' {
    return node.message?.author.role === 'user' ? 'user' : 'assistant';
}
