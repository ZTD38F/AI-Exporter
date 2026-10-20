import {
    BatchWorker,
    resolveConversationData,
    supplementTakeoutGeneratedMedia,
    type FetchChatDetailResult,
} from '../../engine/export/batchWorker.js';
import {
    AssetPipeline as AssetPipelineStatic,
    type AssetPipelineInstance,
} from '../../engine/assetPipeline.js';
import { __getModuleOverride, __resolveModule } from '../../utils/moduleOverrides.js';
import { normId } from '../../utils/pathUtils.js';
import TabService from '../../utils/tabService.js';
import type { CanonicalConversationBundle } from '../canonical/conversation.js';
import type { Diagnostic } from '../canonical/diagnostics.js';
import {
    classifyAttachmentKind,
    extractAttachmentInlineBytes,
} from '../canonical/gemini/normalizeAssets.js';
import { normalizeGeminiConversation } from '../canonical/index.js';
import type { RenderDiagnostic } from '../canonical/rendering.js';
import type { InlineByteStore } from '../assets/index.js';

export const PDF_NO_MESSAGES = 'PDF_NO_MESSAGES';
export const PDF_DETAIL_FETCH_FAILED = 'PDF_DETAIL_FETCH_FAILED';

export function toRenderDiagnostic(d: Diagnostic): RenderDiagnostic {
    return {
        severity: d.severity,
        code: d.code,
        message: d.message,
        path: d.path,
    };
}

export function hasUsableMessages(chat: any): boolean {
    if (!chat || typeof chat !== 'object') return false;
    if (Array.isArray(chat.messages) && chat.messages.length > 0) return true;
    if (Array.isArray(chat.turns) && chat.turns.length > 0) return true;
    return false;
}

/**
 * Extract the chat from a fetchChatDetail result using the exact contract
 * ExportOrchestrator uses: results[0] wins, then chat. Never invent fields.
 */
export function extractChatFromDetailResult(res: FetchChatDetailResult, nid: string, fallback: any): any {
    const chunkResults = res.results || (res.chat ? [res.chat] : []);
    const chat = chunkResults[0] || fallback;
    if (chat && typeof chat === 'object') chat.id = nid;
    return chat;
}

/**
 * Resolve a full conversation for a metadata-only list item via the same
 * BatchWorker.fetchChatDetail path the normal export uses. The normalizer
 * stays a pure data transform — no network fetch is ever put inside it.
 */
export async function resolveFullChatDetail(args: {
    id: string;
    title: string;
    index: number;
    total: number;
    currentSlot: string;
    skip: boolean;
    signal: AbortSignal;
    fetchChatDetail: typeof BatchWorker.fetchChatDetail;
    onLog: (msg: string, level?: string) => void;
}): Promise<{ ok: true; chat: any } | { ok: false; error: string }> {
    const { id, title, index, total, currentSlot, skip, signal, fetchChatDetail, onLog } = args;
    const nid = normId(id);
    let res: FetchChatDetailResult | null = null;
    try {
        res = await fetchChatDetail({ id: nid, title }, index, total, currentSlot, skip, 'pdf', signal);
    } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
    }
    if (!res || !res.success) {
        return { ok: false, error: (res && res.error) || 'unknown error' };
    }
    const chat = extractChatFromDetailResult(res, nid, { id: nid, title });
    const msgCount = Array.isArray(chat?.messages) ? chat.messages.length : 0;
    onLog(`[PDF] ${title || nid}: resolved full conversation detail (${msgCount} messages)`, 'info');
    return { ok: true, chat };
}

export interface PreparedPdfItemSuccess {
    ok: true;
    id: string;
    title: string;
    bundle: CanonicalConversationBundle;
    byteStore: InlineByteStore;
    diagnostics: RenderDiagnostic[];
}

export interface PreparedPdfItemFailure {
    ok: false;
    id: string;
    title: string;
    error: string;
    diagnostics: RenderDiagnostic[];
}

export type PreparedPdfItemResult = PreparedPdfItemSuccess | PreparedPdfItemFailure;

export interface PreparePdfItemContext {
    conversations?: any[];
    fetchChatDetail?: typeof BatchWorker.fetchChatDetail;
    index?: number;
    total?: number;
    currentSlot?: string;
    skip?: boolean;
    signal?: AbortSignal;
    onLog?: (msg: string, level?: string) => void;
    includeAssets?: boolean;
    takeoutEngine?: any;
    assetPipeline?: Pick<AssetPipelineInstance, 'acquireAssetBytes'> | null;
    fetchAssetDelegate?: (params: any) => Promise<any>;
    fetchAsset?: (params: any) => Promise<any>;
    getGeminiTab?: (slot?: string) => Promise<any>;
    sendToGeminiTab?: (message: any, slot?: string, timeoutMs?: number) => Promise<any>;
    maxAssetRetries?: number;
}

function cloneAttachmentList(list: any): any[] | undefined {
    if (!Array.isArray(list)) return undefined;
    return list.map((item) => (item && typeof item === 'object' ? { ...item } : item));
}

function cloneMessageForHydration(msg: any): any {
    if (!msg || typeof msg !== 'object') return msg;
    return {
        ...msg,
        ...(Array.isArray(msg.attachments) ? { attachments: cloneAttachmentList(msg.attachments) } : {}),
        ...(Array.isArray(msg.images) ? { images: cloneAttachmentList(msg.images) } : {}),
        ...(Array.isArray(msg.documents) ? { documents: cloneAttachmentList(msg.documents) } : {}),
    };
}

function cloneChatForHydration(chat: any): any {
    if (!chat || typeof chat !== 'object') return chat;
    return {
        ...chat,
        ...(Array.isArray(chat.messages) ? { messages: chat.messages.map(cloneMessageForHydration) } : {}),
        ...(Array.isArray(chat.turns) ? {
            turns: chat.turns.map((t: any) => {
                if (!t || typeof t !== 'object') return t;
                return {
                    ...t,
                    ...(Array.isArray(t.messages) ? { messages: t.messages.map(cloneMessageForHydration) } : {}),
                    ...(Array.isArray(t.attachments) ? { attachments: cloneAttachmentList(t.attachments) } : {}),
                    ...(Array.isArray(t.images) ? { images: cloneAttachmentList(t.images) } : {}),
                };
            }),
        } : {}),
    };
}

interface ImageHydrationGroup {
    key: string;
    mergedItem: any;
    targets: any[];
}

function collectImageHydrationGroups(chat: any): ImageHydrationGroup[] {
    const groups = new Map<string, ImageHydrationGroup>();
    const registerItem = (item: any, forceImage: boolean): void => {
        if (!item || typeof item !== 'object') return;
        const candidate = forceImage ? { ...item, type: item.type || 'image' } : item;
        if (!classifyAttachmentKind(candidate).isImage) return;
        const existingBytes = extractAttachmentInlineBytes(item);
        if (existingBytes && existingBytes.byteLength > 0) return;

        const key = item.localName || item.resolvedUrl || item.sourceUrl || item.url || item.src || item.fileName || item.name;
        if (!key || typeof key !== 'string') return;

        let group = groups.get(key);
        if (!group) {
            group = {
                key,
                mergedItem: { ...candidate },
                targets: [item],
            };
            groups.set(key, group);
        } else {
            for (const [k, v] of Object.entries(candidate)) {
                if (v !== undefined && group.mergedItem[k] === undefined) {
                    group.mergedItem[k] = v;
                }
            }
            if (!group.targets.includes(item)) {
                group.targets.push(item);
            }
        }
    };

    const visitHolder = (holder: any): void => {
        if (!holder || typeof holder !== 'object') return;
        for (const att of holder.attachments ?? []) registerItem(att, false);
        for (const img of holder.images ?? []) registerItem(img, true);
    };

    for (const msg of chat?.messages ?? []) visitHolder(msg);
    for (const turn of chat?.turns ?? []) {
        visitHolder(turn);
        for (const msg of turn?.messages ?? []) visitHolder(msg);
    }

    return [...groups.values()];
}

function resolvePdfAssetPipeline(context: PreparePdfItemContext): {
    pipeline: Pick<AssetPipelineInstance, 'acquireAssetBytes'> | null;
    takeoutEngine: any;
    maxRetries?: number;
} {
    const takeoutEngine = context.takeoutEngine
        ?? __resolveModule('TakeoutEngine', null)
        ?? (typeof window !== 'undefined' ? (window as any).TakeoutEngine : null);
    const hasTabTransport = Boolean(
        context.getGeminiTab ||
        context.sendToGeminiTab ||
        (typeof chrome !== 'undefined' && (chrome as any)?.tabs)
    );
    const overridePipelineClass = __getModuleOverride('AssetPipeline');
    const hasDelegate = Boolean(context.fetchAssetDelegate || context.fetchAsset);
    const hasAcquisitionSource = Boolean(
        context.assetPipeline ||
        hasDelegate ||
        hasTabTransport ||
        takeoutEngine ||
        overridePipelineClass
    );
    if (!hasAcquisitionSource) {
        return { pipeline: null, takeoutEngine: null };
    }
    if (context.assetPipeline && typeof context.assetPipeline.acquireAssetBytes === 'function') {
        return {
            pipeline: context.assetPipeline,
            takeoutEngine,
            maxRetries: context.maxAssetRetries,
        };
    }

    const AssetPipelineClass = (overridePipelineClass || AssetPipelineStatic) as typeof AssetPipelineStatic;
    const getGeminiTab = context.getGeminiTab ?? (hasTabTransport
        ? async (slot?: string) => (__resolveModule('TabService', TabService))?.getGeminiTab?.(slot) ?? null
        : undefined);
    const sendToGeminiTab = context.sendToGeminiTab ?? (hasTabTransport
        ? (message: any, slot?: string, timeoutMs?: number) => (__resolveModule('TabService', TabService)).sendToGeminiTab(message, slot, timeoutMs)
        : undefined);

    const pipeline = new AssetPipelineClass({
        currentSlot: context.currentSlot,
        useZip: false,
        takeoutEngine,
        getGeminiTab,
        sendToGeminiTab,
        fetchAssetDelegate: context.fetchAssetDelegate || context.fetchAsset,
        onLog: context.onLog,
    });

    const maxRetries = typeof context.maxAssetRetries === 'number'
        ? context.maxAssetRetries
        : (!hasDelegate && !hasTabTransport ? 0 : undefined);

    return { pipeline, takeoutEngine, maxRetries };
}

export async function preparePdfItem(
    selectedItem: any,
    context: PreparePdfItemContext = {},
): Promise<PreparedPdfItemResult> {
    const rawId = selectedItem?.id ?? '';
    const id = normId(rawId);
    const title = selectedItem?.title || id;
    const signal = context.signal ?? new AbortController().signal;
    const onLog = context.onLog ?? (() => {});
    const currentSlot = context.currentSlot ?? 'u0';
    const index = context.index ?? 0;
    const total = context.total ?? 1;
    const skip = context.skip ?? false;

    const listChat = Array.isArray(context.conversations)
        ? context.conversations.find((c: any) => normId(c?.id) === id)
        : null;
    const selectedChat = typeof selectedItem === 'object' ? selectedItem : { id, title };

    const diagnostics: RenderDiagnostic[] = [];
    let chat: any = listChat ?? selectedChat;

    if (!hasUsableMessages(chat)) {
        let fetchError: string | undefined;
        if (context.fetchChatDetail) {
            const fetched = await resolveFullChatDetail({
                id, title, index, total, currentSlot, skip, signal,
                fetchChatDetail: context.fetchChatDetail, onLog,
            });
            if (signal.aborted) return { ok: false, id, title, error: 'aborted', diagnostics };
            if (fetched.ok) chat = fetched.chat;
            else fetchError = fetched.error;
        }
        const takeout = context.takeoutEngine
            ?? __getModuleOverride('TakeoutEngine')
            ?? (typeof window !== 'undefined' ? (window as any).TakeoutEngine : null);
        chat = await resolveConversationData(chat, id, listChat, takeout, currentSlot, onLog);
        if (signal.aborted) return { ok: false, id, title, error: 'aborted', diagnostics };
        if (!hasUsableMessages(chat)) {
            return {
                ok: false, id, title, diagnostics,
                error: `[${PDF_NO_MESSAGES}] ${fetchError || 'No usable conversation after online, Takeout and cache resolution'}`,
            };
        }
    }

    const workingChat = cloneChatForHydration(chat);
    if (workingChat && typeof workingChat === 'object' && !workingChat.id) {
        workingChat.id = id;
    }

    const { pipeline, takeoutEngine, maxRetries } = context.includeAssets === false
        ? { pipeline: null, takeoutEngine: null, maxRetries: undefined }
        : resolvePdfAssetPipeline({ ...context, currentSlot, onLog });

    if (takeoutEngine) {
        supplementTakeoutGeneratedMedia(workingChat, id, currentSlot, takeoutEngine, {
            appendMarkdownRef: false,
        });
    }

    if (pipeline && typeof pipeline.acquireAssetBytes === 'function') {
        const groups = collectImageHydrationGroups(workingChat);
        for (const group of groups) {
            if (signal.aborted) {
                return { ok: false, id, title, error: 'aborted', diagnostics };
            }
            const acquired = await pipeline.acquireAssetBytes(group.mergedItem, workingChat, {
                isImage: true,
                listTitle: title,
                signal,
                ...(typeof maxRetries === 'number' ? { maxRetries } : {}),
            });
            if (signal.aborted || acquired.failReason === 'aborted') {
                return { ok: false, id, title, error: 'aborted', diagnostics };
            }
            if (acquired.ok && acquired.bytes && acquired.bytes.byteLength > 0) {
                for (const target of group.targets) {
                    target.dataBuffer = acquired.bytes;
                    if (acquired.mimeType && !target.mimeType && !target.mime) {
                        target.mimeType = acquired.mimeType;
                    }
                }
            } else {
                const reason = acquired.failReason || 'image direct download failed';
                for (const target of group.targets) {
                    target.failureReason = reason;
                }
                onLog(
                    `[PDF] [${title || id}] 图片获取失败 (${acquired.localName}): ${reason}`,
                    'warn',
                );
            }
        }
    }

    const { bundle, diagnostics: normDiags, byteStore } = await normalizeGeminiConversation(workingChat as any);
    for (const d of normDiags) diagnostics.push(toRenderDiagnostic(d));
    const integrityError = normDiags.find((d) => d.severity === 'error' && (d.code === 'MSG_BAD_ID' || d.code === 'MSG_DUP_ID'));
    if (integrityError) {
        return { ok: false, id, title, error: `[${integrityError.code}] ${integrityError.message}`, diagnostics };
    }


    // Hydrate any standalone inline markdown remote images (not backed by m.attachments / m.images)
    if (pipeline && typeof pipeline.acquireAssetBytes === 'function') {
        for (const asset of bundle.assets) {
            if (asset.kind !== 'image' || asset.status !== 'remote' || !asset.sourceUrl) continue;
            if (signal.aborted) {
                return { ok: false, id, title, error: 'aborted', diagnostics };
            }
            const acquired = await pipeline.acquireAssetBytes(
                {
                    url: asset.sourceUrl,
                    sourceUrl: asset.sourceUrl,
                    fileName: asset.name,
                    localName: asset.storageRef || `assets/${asset.name || asset.id}`,
                },
                workingChat,
                {
                    isImage: true,
                    listTitle: title,
                    signal,
                    ...(typeof maxRetries === 'number' ? { maxRetries } : {}),
                },
            );
            if (signal.aborted || acquired.failReason === 'aborted') {
                return { ok: false, id, title, error: 'aborted', diagnostics };
            }
            if (acquired.ok && acquired.bytes && acquired.bytes.byteLength > 0) {
                const storageRef = asset.storageRef || `assets/inline-remote/${asset.id}`;
                byteStore.put(storageRef, acquired.bytes);
                asset.storageRef = storageRef;
                asset.status = 'available';
                asset.sizeBytes = acquired.bytes.byteLength;
                if (acquired.mimeType && !asset.mimeType) {
                    asset.mimeType = acquired.mimeType;
                }
            } else {
                const reason = acquired.failReason || 'image direct download failed';
                asset.status = 'failed';
                asset.failureReason = reason;
                onLog(
                    `[PDF] [${title || id}] 图片获取失败 (${acquired.localName}): ${reason}`,
                    'warn',
                );
            }
        }
    }

    if ((bundle?.conversation?.messages?.length ?? 0) === 0) {
        return {
            ok: false,
            id,
            title,
            error: `[${PDF_NO_MESSAGES}] Conversation detail resolved without any messages; refusing to generate an empty PDF.`,
            diagnostics,
        };
    }

    return {
        ok: true,
        id,
        title,
        bundle,
        byteStore,
        diagnostics,
    };
}
