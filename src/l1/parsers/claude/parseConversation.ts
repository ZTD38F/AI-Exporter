import type { BlockNode } from '../../../l2/content/blocks.js';
import type { DomainAsset, DomainMessage } from '../../../l2/conversationDetail.js';
import type { Diagnostic } from '../../../shared/diagnostics/diagnostic.js';
import type { SourceConversationParseResult } from '../parsingResult.js';
import { parseMarkdownToBlocks, type MarkdownParseContext } from '../shared/markdown/index.js';
import { parseIndexMetadata } from '../shared/parseIndexMetadata.js';
import { decodeClaudeDetail, type ClaudeDetailEvidence, type ClaudeSourceMessage, type ClaudeSourceFile } from './decodeDetail.js';
import { createToolState, isCapturedArtifactFile, parseToolUse, parseToolResult, type ToolState } from './parseTools.js';

function paragraph(text: string): BlockNode { return { type: 'paragraph', children: [{ type: 'text', text }] }; }
function markdown(text: string, id: string, ctx: MarkdownParseContext): BlockNode[] {
    return text.trim() ? parseMarkdownToBlocks(text, id, ctx) : [];
}
interface Branch { messages: ClaudeSourceMessage[]; quality: 'complete' | 'partial' | 'unknown' }
function currentBranch(data: ClaudeDetailEvidence): Branch {
    const byId = new Map<string, ClaudeSourceMessage>();
    for (const message of data.messages) byId.set(message.uuid, message);
    if (byId.size !== data.messages.length) throw new TypeError('Duplicate Claude message UUID');
    if (!data.currentLeafId || !byId.has(data.currentLeafId)) {
        // Never silently call a guessed branch complete.
        return { messages: [...byId.values()]
            .sort((a, b) => a.sortIndex - b.sortIndex), quality: 'unknown' };
    }
    const result: ClaudeSourceMessage[] = [], visited = new Set<string>();
    let id: string | null = data.currentLeafId;
    let quality: Branch['quality'] = 'complete';
    while (id) {
        const node = byId.get(id);
        if (visited.has(id) || !node) { quality = 'partial'; break; }
        visited.add(id);
        result.push(node);
        const parent = node.parentId;
        if (parent === null) break;
        if (parent === undefined) { quality = 'partial'; break; }
        id = parent;
    }
    return { messages: result.reverse(), quality };
}
function contentOf(message: ClaudeSourceMessage, ctx: MarkdownParseContext, tools: ToolState, assets: DomainAsset[]):
    { content: BlockNode[]; reasoning: BlockNode[]; incomplete: boolean } {
    const id = message.uuid;
    const content: BlockNode[] = [], reasoning: BlockNode[] = [];
    let incomplete = message.truncated || ['user_canceled', 'error', 'max_tokens', 'tool_use', 'pause_turn', 'model_context_window_exceeded'].includes(message.stopReason ?? '');
    const missing = (code: string, message: string) => {
        incomplete = true;
        ctx.diagnostics.push({ severity: 'warning', code, message, sourceRef: ctx.sourceRef });
    };
    if (incomplete) missing('claude.message.truncated', 'Message was truncated or canceled');
    const unresolved: { file: ClaudeSourceFile; name: string; generated: boolean }[] = [];
    for (const { entry, generated } of [...message.attachments.map(entry => ({ entry, generated: false })),
        ...message.files.map(entry => ({ entry, generated: true }))]) {
        if (!entry) { missing('claude.attachment.invalid', 'Invalid attachment metadata'); continue; }
        const name = entry.name;
        if (entry.extractedContent?.trim()) {
            content.push(paragraph('Attachment: ' + name));
            content.push(...markdown(entry.extractedContent, id, ctx));
        } else unresolved.push({ file: entry, name, generated });
    }
    if (message.content) {
        for (const block of message.content) {
            if (block.kind === 'invalid') {
                missing('claude.content.invalid', 'Invalid content block');
            } else if (block.kind === 'text') {
                content.push(...markdown(block.text, id, ctx));
            } else if (block.kind === 'thinking') {
                reasoning.push(...markdown(block.thinking, id, ctx));
            } else if (block.kind === 'tool_use') {
                const parsed = parseToolUse(block, tools, text => markdown(text, id, ctx));
                content.push(...parsed.blocks);
                for (const issue of parsed.issues) missing('claude.tool_use.unsupported', issue);
            } else if (block.kind === 'tool_result') {
                const parsed = parseToolResult(block, text => markdown(text, id, ctx));
                content.push(...parsed.blocks);
                for (const issue of parsed.issues) missing('claude.tool_result.unsupported', issue);
            } else if (block.kind === 'unsupported') {
                missing('claude.content.unsupported', 'Unsupported content block: ' + block.sourceType);
            }
        }
    } else if (message.text !== undefined) {
        content.push(...markdown(message.text, id, ctx));
    } else { missing('claude.content.missing', 'Message has no content'); }
    for (const { file, name, generated } of unresolved) {
        if (generated && isCapturedArtifactFile(message, file, tools)) continue;
        const fileId = file.fileId;
        if (generated && file.success && file.fileKind === 'blob' && file.downloadSource === 'files-api' && fileId) {
            const assetId = 'claude-file:' + fileId;
            if (!assets.some(asset => asset.id === assetId)) assets.push({ id: assetId, kind: 'file', name,
                sourceUri: assetId, ...(file.sizeBytes !== undefined ? { byteLength: file.sizeBytes } : {}) });
            content.push({ type: 'file', assetId, label: name });
            continue;
        }
        content.push(paragraph('Attachment: ' + name));
        missing('claude.attachment.unavailable', 'Attachment bytes or extracted text unavailable');
    }
    return { content, reasoning, incomplete };
}

/** Pure Claude wire data -> shared Domain. Rendering remains entirely in L4. */
export function parseClaudeConversation(raw: unknown, requestedId: string): SourceConversationParseResult {
    const data = decodeClaudeDetail(raw, requestedId);
    const branch = currentBranch(data);
    const diagnostics: Diagnostic[] = [];
    const ctx: MarkdownParseContext = {
        diagnostics, sourceRef: { providerId: 'claude', locator: 'conversation:' + requestedId },
    };
    if (branch.quality !== 'complete') diagnostics.push({ severity: 'warning',
        code: 'claude.branch.' + branch.quality,
        message: branch.quality === 'partial' ? 'Current branch has a missing or cyclic parent'
            : 'Current branch leaf is unavailable', sourceRef: ctx.sourceRef });
    let partial = false;
    const sourceModel = data.model;
    const messages: DomainMessage[] = [];
    const assets: DomainAsset[] = [];
    const tools = createToolState(branch.messages);
    for (const message of branch.messages) {
        if (message.sender !== 'human' && message.sender !== 'assistant') continue;
        const rendered = contentOf(message, { ...ctx,
            sourceRef: { ...ctx.sourceRef, providerMessageId: message.uuid } }, tools, assets);
        if (rendered.incomplete) partial = true;
        const timestamp = message.createdAt;
        const model = message.model ?? sourceModel;
        messages.push({
            id: message.uuid, role: message.sender === 'human' ? 'user' : 'assistant',
            content: rendered.content,
            ...(rendered.reasoning.length ? { reasoning: rendered.reasoning } : {}),
            ...(timestamp !== undefined ? { timestamp } : {}),
            ...(model ? { model } : {}),
        });
    }
    const sourceVersion = data.updatedAt;
    const createdAt = data.createdAt;
    const quality = branch.quality === 'complete' && partial ? 'partial' : branch.quality;
    return {
        conversationId: requestedId,
        ...(sourceVersion !== undefined ? { sourceVersion } : {}),
        conversation: {
            index: parseIndexMetadata({ providerId: 'claude', id: requestedId,
                title: data.name,
                titleSource: 'provider', createdAt, updatedAt: sourceVersion,
                url: 'https://claude.ai/chat/' + requestedId }),
            detail: { ...(sourceVersion !== undefined ? { savedAt: sourceVersion } : {}),
                quality: { status: messages.length ? quality : 'unknown' }, assets, messages },
        },
        diagnostics, acquisitionHints: {},
    };
}
