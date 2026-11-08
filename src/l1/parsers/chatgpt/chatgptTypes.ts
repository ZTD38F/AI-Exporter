/**
 * ChatGPT decoded Detail shapes, ported from pionxzh/chatgpt-exporter (MIT).
 * Session, list and mapping payloads verified against the logged-in 9222 test profile.
 */

/** Author role used by ChatGPT mapping nodes. */
export type ChatGPTAuthorRole = 'system' | 'assistant' | 'user' | 'tool';

/** Minimal message content union needed for export (text-first). */
export type ChatGPTMessageContent =
    | { content_type: 'text'; parts: string[] }
    | { content_type: 'code'; language: string; text: string }
    | { content_type: 'execution_output'; text: string }
    | { content_type: 'multimodal_text'; parts: Array<string | { content_type: string; asset_pointer?: string }> }
    | { content_type: 'thoughts'; thoughts: Array<{ summary: string; content: string }> }
    | { content_type: 'reasoning_recap'; content: string }
    | { content_type: string; parts?: string[]; text?: string; content?: string };

/** Gallery URLs approved once by the Detail decoder, before message assembly. */
export interface ChatGPTGalleryResult {
    componentName?: string;
    status?: string;
    imageUrls: string[];
}

export interface ChatGPTNodeMessage {
    author: { role: ChatGPTAuthorRole; name?: string };
    content: ChatGPTMessageContent;
    /** Validated Unix milliseconds; raw seconds/strings are decoded at ingress. */
    createdAtMs?: number;
    id: string;
    metadata?: {
        model_slug?: string;
        finish_details?: { type: string; reason?: string };
        is_visually_hidden_from_conversation?: boolean;
        is_thinking_preamble_message?: boolean;
        reasoning_title?: string;
        finished_duration_sec?: number;
        attachments?: Array<{ id: string; name: string; mime_type?: string; size?: number }>;
        aggregate_result?: {
            messages?: Array<{ message_type: string; image_url?: string }>;
        };
        model_dil_v2?: {
            fallbackMarkdown?: string;
            code?: string;
            constants?: ReadonlyMap<string, string>;
            appData?: { opGenui?: { componentResults?: ReadonlyMap<string, ChatGPTGalleryResult> } };
        };
        /** Tether web citations: each entry carries its source in metadata. */
        citations?: Array<{ metadata?: { title?: string; url?: string; text?: string } }>;
        /** New-style grouped web references with item/source lists. */
        content_references?: Array<{
            items?: Array<{ title?: string; url?: string }>;
            sources?: Array<{ title?: string; url?: string }>;
            fallback_items?: Array<{ title?: string; url?: string }>;
            url?: string;
            title?: string;
        }>;
    };
    /** Validated visible explanation of a local Work handoff; excludes its hidden prompt. */
    handoffReason?: string;
    recipient: string;
    channel?: string | null;
    status?: string;
    end_turn?: boolean;
    weight: number;
}

export interface ChatGPTConversationNode {
    children: string[];
    id: string;
    message?: ChatGPTNodeMessage;
    parent?: string;
}

export interface ChatGPTApiConversation {
    /** Validated Unix milliseconds; raw seconds/strings are decoded at ingress. */
    createdAtMs?: number;
    updatedAtMs?: number;
    conversation_id?: string;
    current_node: string;
    mapping: ReadonlyMap<string, ChatGPTConversationNode>;
    title: string;
    is_archived: boolean;
}

export type ChatGPTApiConversationWithId = ChatGPTApiConversation & { id: string };

/** Backend endpoint table. Mirrors pionxzh constants: origin -> backend-api. */
export function chatGPTApiBase(origin: string): string {
    if (origin === 'https://chatgpt.com' || origin === 'https://chat.openai.com') {
        return `${origin}/backend-api`;
    }
    return 'https://chatgpt.com/backend-api';
}

export const CHATGPT_HOSTS = ['chatgpt.com', 'chat.openai.com'];
