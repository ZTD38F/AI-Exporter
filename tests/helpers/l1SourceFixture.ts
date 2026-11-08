import { parseGeminiDetailEvidence } from '../../src/l1/parsers/gemini/rpc/parseConversation.js';
import { classifyDetailBody } from '../../src/l1/parsers/gemini/rpc/emptyDetail.js';
import type { GeminiDetailEvidence, GeminiMessageEvidence } from '../../src/l1/parsers/gemini/rpc/detailEvidence.js';
import { extractImageEvidence } from '../../src/l1/parsers/gemini/rpc/sourceAttachments.js';
import { parseList } from '../../src/l1/parsers/gemini/rpc/parseList.js';
import { listGen as geminiListGen } from '../fixtures/providers/gemini.js';

/** Native source fixtures intentionally contain neither Account UUID nor trusted Domain. */
export function sourceMessage(id: string, content = id, role: 'user' | 'model' = 'model'): GeminiMessageEvidence {
    return { id, content, role, timestamp: null, attachmentCount: 0, messageCount: 1, structuredImages: [] };
}
export function sourceDetail(overrides: Partial<GeminiDetailEvidence> = {}) {
    return parseGeminiDetailEvidence({ id: 'source_chat_123', title: 'Source title', titleSource: 'rpc',
        messages: [sourceMessage('answer')], updatedAt: 1700000000000,
        url: 'https://gemini.google.com/app/source_chat_123', nextPageToken: null, attachmentCount: 0,
        bodyShape: classifyDetailBody(overrides._raw, overrides.id ?? 'source_chat_123'), ...overrides }, { providerId: 'gemini' });
}
/** Parsed native List evidence; all wire construction lives in listGen(key). */
export function sourceList(key: Parameters<typeof geminiListGen>[0]) {
    return parseList(geminiListGen(key));
}
export function activityHtml(answer = '<p>Answer</p>', id = 'source_chat_123', time = '2026-09-02T12:00:00Z') {
    return `<div class="outer-cell"><a href="https://gemini.google.com/app/${id}">Conversation</a><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted Question<br>${time}<br>${answer}</div></div>`;
}
export function takeoutArchive(html = activityHtml(), entries: Record<string, { async: (type: string) => Promise<unknown>; _data?: { uncompressedSize: number } }> = {}) {
    return { file() {}, files: { 'Takeout/Gemini/MyActivity.html': { _data: { uncompressedSize: html.length }, async: async () => html }, ...entries } } as unknown as File;
}

/** Build source evidence for adapter-level fixtures, without a persisted-record parser. */
export function sourceConversation(input: { id: string; title?: string; messages: (Partial<GeminiMessageEvidence> & Pick<GeminiMessageEvidence, 'id' | 'content' | 'role'>)[] }) {
    return sourceDetail({ id: input.id, title: input.title, messages: input.messages.map(message => ({
        ...sourceMessage(message.id, message.content, message.role), ...message,
        structuredImages: message.structuredImages ?? (message.structuredContent ? extractImageEvidence(message.structuredContent) : []),
    })) });
}
