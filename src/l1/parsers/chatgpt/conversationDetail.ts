/**
 * ChatGPT detail enrichment: thinking -> reasoning blocks, web citations,
 * uploaded-file records. Pure functions ported from pionxzh/chatgpt-exporter
 * (MIT), shaped into our neutral Domain vocabulary like the Gemini parser.
 * @unverified-provider-scaffold Citations verified present in live payloads;
 * thoughts/reasoning_recap verified present; upload round-trip still open.
 */
import type { DomainCitation } from '../../../l2/conversationDetail.js';
import type {
    ChatGPTConversationNode,
} from './chatgptTypes.js';

export interface ChatGPTThinking {
    thoughts: Array<{ summary: string; content: string }>;
    activities: string[];
    durationSeconds?: number;
}

function emptyThinking(): ChatGPTThinking {
    return { thoughts: [], activities: [] };
}

function hasThinking(t: ChatGPTThinking): boolean {
    return t.thoughts.length > 0 || t.activities.length > 0;
}

/**
 * Walk the raw mapping leaf->root (pionxzh attachThinkingToNodes) and collect
 * hidden reasoning (thoughts / reasoning_recap / preamble / activity titles)
 * onto the assistant node that follows them. Returns nodeId -> thinking.
 */
export function collectChatGPTThinking(
    mapping: ReadonlyMap<string, ChatGPTConversationNode>,
    resultNodeIds: Set<string>,
    startNodeId: string,
): Map<string, ChatGPTThinking> {
    const out = new Map<string, ChatGPTThinking>();
    let currentId: string | undefined = startNodeId;
    const visited = new Set<string>();
    let targetId: string | null = null;
    let thinking = emptyThinking();

    const flush = (): void => {
        if (targetId && hasThinking(thinking)) {
            const prev = out.get(targetId);
            if (prev) {
                out.set(targetId, {
                    thoughts: [...prev.thoughts, ...thinking.thoughts],
                    activities: [...prev.activities, ...thinking.activities],
                    durationSeconds: prev.durationSeconds ?? thinking.durationSeconds,
                });
            } else {
                out.set(targetId, thinking);
            }
        }
    };

    while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const id: string = currentId;
        const node: ChatGPTConversationNode | undefined = mapping.get(id);
        if (!node || node.parent === undefined) break;
        const message = node.message;
        if (message?.content) {
            const ct = message.content.content_type;
            if (resultNodeIds.has(node.id) && message.author.role !== 'user') {
                flush();
                targetId = node.id;
                thinking = emptyThinking();
            } else if (ct === 'reasoning_recap') {
                const duration = message.metadata?.finished_duration_sec;
                if (duration !== undefined) {
                    thinking.durationSeconds = duration;
                } else {
                    const raw = message.content.content ?? '';
                    const match = raw.match(/(\d+)/);
                    if (match?.[1]) thinking.durationSeconds = Number.parseInt(match[1], 10);
                }
            } else if (ct === 'thoughts' && 'thoughts' in message.content && Array.isArray(message.content.thoughts)) {
                thinking.thoughts.unshift(
                    ...message.content.thoughts
                        .filter((t: { summary: string; content: string }) => t.content || t.summary)
                        .map((t: { summary: string; content: string }) => ({ summary: t.summary, content: t.content })),
                );
            } else if (ct === 'text' && message.metadata?.is_thinking_preamble_message) {
                const parts = Array.isArray(message.content.parts) ? message.content.parts : [];
                const text = parts.join('\n');
                if (text) thinking.thoughts.unshift({ summary: '', content: text });
            } else if (message.metadata?.reasoning_title) {
                const title = message.metadata.reasoning_title;
                const at = thinking.activities.indexOf(title);
                if (at !== -1) thinking.activities.splice(at, 1);
                thinking.activities.unshift(title);
            } else if (message.author.role === 'user' && !message.metadata?.is_visually_hidden_from_conversation) {
                flush();
                targetId = null;
                thinking = emptyThinking();
            }
        }
        currentId = node.parent;
    }
    flush();
    return out;
}

/** Web citations for one node, deduplicated by URL (Gemini citationsOf parity). */
export function citationsOfChatGPTNode(node: ChatGPTConversationNode): DomainCitation[] {
    const citations: DomainCitation[] = [];
    const seen = new Set<string>();
    const push = (url?: string, title?: string): void => {
        const clean = (url ?? '').trim();
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        citations.push({
            id: `citation-${citations.length}`,
            url: clean,
            ...(title ? { title } : {}),
        });
    };
    const meta = node.message?.metadata;
    for (const cite of meta?.citations ?? []) {
        push(cite.metadata?.url, cite.metadata?.title);
    }
    for (const ref of meta?.content_references ?? []) {
        for (const item of [...(ref.items ?? []), ...(ref.sources ?? []), ...(ref.fallback_items ?? [])]) {
            push(item.url, item.title);
        }
        push(ref.url, ref.title);
    }
    return citations;
}

interface ChatGPTUploadedFile {
    id: string;
    name: string;
    mediaType?: string;
    byteLength?: number;
}

/** Non-image user uploads recorded on the message (bytes resolved later). */
export function uploadedFilesOfChatGPTNode(node: ChatGPTConversationNode): ChatGPTUploadedFile[] {
    const out: ChatGPTUploadedFile[] = [];
    for (const a of node.message?.metadata?.attachments ?? []) {
        if (a.mime_type?.startsWith('image/')) continue;
        out.push({
            id: a.id,
            name: a.name,
            ...(a.mime_type ? { mediaType: a.mime_type } : {}),
            ...(a.size !== undefined ? { byteLength: a.size } : {}),
        });
    }
    return out;
}
