import { findGenerationModelMessage, hasGenerationImage } from '../generatedMediaIdentity.js';
import type { FetchBatchMessage } from '../../../types/messages.js';

export interface FetchChatDetailOptions {
    messageSender?: any;
    tabService?: any;
}

export interface FetchChatDetailResult {
    success: boolean;
    results?: any[];
    chat?: any;
    data?: any;
    skipped?: number;
    error?: string;
    status?: number;
    rawResponse?: any;
    [key: string]: any;
}

export interface ResolveChatResult {
    chat: any;
    listTitle?: string;
    displayTitle?: string;
    isConfirmedDeleted: boolean;
    isError: boolean;
    errMsg: string | null;
    convsNeedSave: boolean;
}

export interface SupplementTakeoutMediaOptions {
    appendMarkdownRef?: boolean;
}

export interface BatchWorkerModule {
    fetchChatDetail: (
        requestedItem: any,
        currentIndex: number,
        totalChats: number,
        currentSlot: string,
        skip: boolean,
        format: string,
        abortSignal?: AbortSignal | null,
        options?: FetchChatDetailOptions
    ) => Promise<FetchChatDetailResult>;
    resolveChat: (
        chat: any,
        requestedItem: any,
        listConversation?: any,
        takeoutEngine?: any,
        currentSlot?: string,
        onTitleUpdated?: (id: string, title: string, source: string) => void,
        onLog?: (msg: string, level?: string) => void,
        options?: any
    ) => Promise<ResolveChatResult>;
    supplementTakeoutGeneratedMedia: (
        chat: any,
        nid: string,
        slot?: string,
        takeoutEngine?: any,
        options?: SupplementTakeoutMediaOptions
    ) => void;
    formatDebugInfo?: (debug: any) => string;
}

import {
    normId as utilsNormId,
    shortScope as utilsShortScope,
    cleanTitle as utilsCleanTitle,
    unescapeHtml as utilsUnescapeHtml,
    stripHtmlTags as utilsStripHtmlTags,
    isRealTitle as utilsIsRealTitle,
    resolveTitle as utilsResolveTitle,
    cleanZeroWidth as utilsCleanZeroWidth,
    isBrandPlaceholderTitle as utilsIsBrandPlaceholderTitle,
    sanitizeFileName as utilsSanitizeFileName,
    normalizeReliableTitleSource as utilsNormalizeReliableTitleSource
} from "../../utils/utils.js";
import type { GeminiUtilsModule } from "../../utils/utils.js";
import { __resolveModule } from "../../utils/moduleOverrides.js";
import { I18n as I18nStatic } from "../../utils/i18n.js";
import { ChatFormatter } from "../chatFormatter.js";
import TabService from "../../utils/tabService.js";
import { getConversationDetail } from "../../storage/conversationDetailStore.js";
import { isConfirmedDeletedError } from "../../protocol/protocol.js";

const injectedUtils = (): GeminiUtilsModule | null => __resolveModule('GeminiUtils', null);

const normId = (id?: string | number | null): string => {
    const injected = injectedUtils();
    if (injected?.normId) {
        return injected.normId(id);
    }
    return utilsNormId(id);
};

const shortScope = (id?: string | number | null): string => {
    const injected = injectedUtils();
    if (injected?.shortScope) {
        return injected.shortScope(id);
    }
    return utilsShortScope(id as any);
};

const cleanTitle = (t?: string | null): string => {
    const injected = injectedUtils();
    if (injected?.cleanTitle) {
        return injected.cleanTitle(t);
    }
    return utilsCleanTitle(t);
};

const unescapeHtml = (t?: string | null): string => {
    const injected = injectedUtils();
    if (injected?.unescapeHtml) {
        return injected.unescapeHtml(t);
    }
    return utilsUnescapeHtml(t);
};

const stripHtmlTags = (t?: string | null): string => {
    const injected = injectedUtils();
    if (injected?.stripHtmlTags) {
        return injected.stripHtmlTags(t);
    }
    return utilsStripHtmlTags(t);
};

const isRealTitle = (t?: string | null, fallbackId?: string | number): boolean => {
    const injected = injectedUtils();
    if (injected?.isRealTitle) {
        return injected.isRealTitle(t, fallbackId);
    }
    return utilsIsRealTitle(t, fallbackId);
};

const resolveTitle = (chat?: any) => {
    const injected = injectedUtils();
    if (injected?.resolveTitle) {
        return injected.resolveTitle(chat);
    }
    return utilsResolveTitle(chat);
};

const cleanZeroWidth = (t?: any): string => {
    const injected = injectedUtils();
    if (injected?.cleanZeroWidth) {
        return injected.cleanZeroWidth(t);
    }
    return utilsCleanZeroWidth(t);
};

const isBrandPlaceholderTitle = (t?: any): boolean => {
    const injected = injectedUtils();
    if (injected?.isBrandPlaceholderTitle) {
        return injected.isBrandPlaceholderTitle(t);
    }
    return utilsIsBrandPlaceholderTitle(t);
};

    async function fetchChatDetail(
        requestedItem: any,
        currentIndex: number,
        totalChats: number,
        currentSlot: string,
        skip: boolean,
        format: string,
        abortSignal?: AbortSignal | null,
        options: FetchChatDetailOptions = {}
    ): Promise<FetchChatDetailResult> {
        const nid = normId(requestedItem.id);
        const messageSender = options.messageSender || null;
        const tabService = options.tabService || __resolveModule('TabService', TabService);

        return new Promise<FetchChatDetailResult>(async (resolve) => {
            let settled = false;
            const onAbort = () => {
                if (!settled) {
                    settled = true;
                    resolve({ success: false, error: 'aborted' });
                }
            };
            if (abortSignal) {
                if (abortSignal.aborted) return onAbort();
                abortSignal.addEventListener('abort', onAbort, { once: true });
            }

            try {
                if (tabService && tabService.sendToGeminiTab) {
                    const directRes = await tabService.sendToGeminiTab({
                        action: 'getConversationDetail',
                        conversationId: nid,
                        accountSlot: currentSlot
                    }, currentSlot);
                    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
                    if (!settled) {
                        if (directRes && directRes.success) {
                            settled = true;
                            const chat = directRes.data || directRes.chat || directRes;
                            resolve({ success: true, results: [chat], skipped: 0 });
                            return;
                        } else if (directRes && directRes.error) {
                            settled = true;
                            resolve(directRes);
                            return;
                        } else if (directRes !== null && directRes !== undefined) {
                            settled = true;
                            resolve({ success: false, error: 'Malformed direct response envelope', rawResponse: directRes });
                            return;
                        }
                    }
                }
            } catch (directErr: any) {
                if (String(directErr?.message || '').includes('aborted')) {
                    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
                    if (!settled) { settled = true; resolve({ success: false, error: 'aborted' }); }
                    return;
                }
            }

            const sender = messageSender || (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage ? chrome.runtime.sendMessage.bind(chrome.runtime) : null);

            if (sender) {
                const msg: FetchBatchMessage = {
                    action: 'fetchBatch',
                    ids: [requestedItem],
                    format,
                    skipExported: skip,
                    globalOffset: currentIndex,
                    globalTotal: totalChats,
                    accountSlot: currentSlot
                };
                try {
                    sender(msg, (response: any) => {
                        if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
                        if (!settled) {
                            settled = true;
                            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
                                resolve({ success: false, error: chrome.runtime.lastError.message });
                            } else {
                                resolve(response);
                            }
                        }
                    });
                } catch (sendErr: any) {
                    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
                    if (!settled) {
                        settled = true;
                        resolve({ success: false, error: sendErr?.message || String(sendErr) });
                    }
                }
            } else {
                if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
                if (!settled) {
                    settled = true;
                    resolve({ success: false, error: 'chrome.runtime not available' });
                }
            }
        });
    }

    function supplementTakeoutGeneratedMedia(
        chat: any,
        nid: string,
        slot: string = 'u0',
        takeoutEngine?: any,
        options: SupplementTakeoutMediaOptions = {}
    ): void {
        const appendMarkdownRef = options.appendMarkdownRef ?? true;
        if (takeoutEngine && typeof takeoutEngine.getTakeoutMediaForChat === 'function' && Array.isArray(chat?.messages) && chat.messages.length > 0) {
            const takeoutMedia = takeoutEngine.getTakeoutMediaForChat(nid, slot);
            if (takeoutMedia && takeoutMedia.length > 0) {
                for (const tm of takeoutMedia) {
                    if (!tm?.isGenerated || !tm?.filename) continue;
                    const generation = tm.generation || (tm.providerRequestId ? {
                        chatId: nid,
                        providerRequestId: tm.providerRequestId,
                        generationOrdinal: 0,
                        imageOrdinal: tm.imageOrdinal ?? 0,
                    } : null);
                    const eventTarget = generation ? findGenerationModelMessage(chat, generation) : null;
                    if (eventTarget && generation && hasGenerationImage(eventTarget, generation)) continue;
                    const candidates = generation ? (eventTarget ? [eventTarget] : []) : chat.messages;
                    const alreadyHas = candidates.some((m: any) =>
                        (m.images && m.images.some((im: any) => im.fileName === tm.filename || (im.localName && im.localName.includes(tm.filename)))) ||
                        (m.attachments && m.attachments.some((at: any) => at.fileName === tm.filename || (at.localName && at.localName.includes(tm.filename)))) ||
                        (typeof m.content === 'string' && m.content.includes(tm.filename))
                    );
                    if (!alreadyHas) {
                        const imgObj = {
                            url: tm.filename,
                            name: tm.filename,
                            fileName: tm.filename,
                            localName: `assets/${tm.filename}`,
                            source: 'takeout',
                            isGenerated: true,
                            providerRequestId: tm.providerRequestId || generation?.providerRequestId,
                            imageOrdinal: tm.imageOrdinal ?? generation?.imageOrdinal,
                            ...(generation ? { generation } : {})
                        };
                        const targetModelMsg = generation ? eventTarget : chat.messages.slice().reverse().find((m: any) => m.role === 'model' || m.role === 'assistant');
                        if (targetModelMsg) {
                            targetModelMsg.images = targetModelMsg.images || [];
                            targetModelMsg.attachments = targetModelMsg.attachments || [];
                            targetModelMsg.images.push(imgObj);
                            targetModelMsg.attachments.push(imgObj);
                            if (appendMarkdownRef) {
                                if (typeof targetModelMsg.content !== 'string') targetModelMsg.content = '';
                                if (!targetModelMsg.content.includes(tm.filename)) {
                                    targetModelMsg.content = (targetModelMsg.content ? targetModelMsg.content + '\n\n' : '') + `![Generated Image](assets/${tm.filename})`;
                                }
                            }
                        } else {
                            chat.messages.push({
                                role: 'model',
                                content: appendMarkdownRef ? `![Generated Image](assets/${tm.filename})` : '',
                                timestamp: generation?.time ?? null,
                                providerRequestId: tm.providerRequestId || generation?.providerRequestId,
                                ...(generation ? { generation } : {}),
                                images: [imgObj],
                                attachments: [imgObj]
                            });
                        }
                    }
                }
            }
        }
    }

    /** Shared acquisition policy: usable online data, then Takeout, then stored detail. */
    export async function resolveConversationData(
        chat: any,
        nid: string,
        listConversation?: any,
        takeoutEngine?: any,
        slot: string = 'u0',
        onLog: (msg: string, level?: string) => void = (() => {}),
    ): Promise<any> {
        if ((chat.error || chat._empty || !chat.messages || chat.messages.length === 0)) {
            if (takeoutEngine) {
                const fbChat = takeoutEngine.getTakeoutOfflineChat(nid, slot);
                if (fbChat && fbChat.messages && fbChat.messages.length > 0) {
                    chat = {
                        ...fbChat,
                        id: nid,
                        title: isRealTitle(chat.title, nid) ? chat.title : fbChat.title,
                        url: `https://gemini.google.com/app/${nid}`
                    };
                    delete chat.error;
                    delete chat._empty;
                    const I18n = __resolveModule('I18n', I18nStatic);
                    onLog(I18n.t('logTakeoutChatRecovered', chat.title || nid), 'info');
                }
            }
            if (chat.error || chat._empty || !chat.messages || chat.messages.length === 0) {
                try {
                    const detail = await getConversationDetail(nid);
                    if (detail && Array.isArray(detail.messages) && detail.messages.length > 0) {
                        chat = {
                            ...(listConversation || {}),
                            id: nid,
                            title: isRealTitle(chat.title, nid) ? chat.title : (listConversation?.title || nid),
                            messages: detail.messages,
                            turns: detail.turns,
                            url: (listConversation && listConversation.url) || `https://gemini.google.com/app/${nid}`
                        };
                        delete chat.error;
                        delete chat._empty;
                        const I18n = __resolveModule('I18n', I18nStatic);
                        onLog(I18n.t('logTakeoutChatRecovered', chat.title || nid), 'info');
                    }
                } catch { /* intentional */ }
            }
        }

        return chat;
    }

    async function resolveChat(
        chat: any,
        requestedItem: any,
        listConversation?: any,
        takeoutEngine?: any,
        currentSlot?: string,
        onTitleUpdated: (id: string, title: string, source: string) => void = (() => {}),
        onLog: (msg: string, level?: string) => void = (() => {}),
        options: any = {}
    ): Promise<ResolveChatResult> {
        const nid = normId(requestedItem.id);
        const slot = currentSlot || 'u0';
        let convsNeedSave = false;

        chat = await resolveConversationData(chat, nid, listConversation, takeoutEngine, slot, onLog);

        supplementTakeoutGeneratedMedia(chat, nid, slot, takeoutEngine);

        if (Array.isArray(chat.messages) && chat.messages.length > 0) {
            const scope = shortScope(nid);
            for (let mi = 0; mi < chat.messages.length; mi++) {
                const m = chat.messages[mi];
                if (m.role !== 'model' || !m.content || typeof m.content !== 'string') continue;

                const hasExistingDoc = (m.attachments && m.attachments.some((a: any) => a.type === 'file' && a.contentMarkdown)) ||
                                       (m.documents && m.documents.some((d: any) => d.contentMarkdown));
                if (hasExistingDoc) continue;

                const isHtmlReport = /<h1[^>]*>/i.test(m.content) && m.content.length > 3000;
                const isMdReport = /(?:^|\n)#\s+[^\n]+/m.test(m.content) && m.content.length > 3000;

                if (isHtmlReport || isMdReport) {
                    let docTitle = '';
                    let docMarkdown = '';

                    if (isHtmlReport) {
                        const h1Match = m.content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
                        if (h1Match) {
                            docTitle = cleanTitle(stripHtmlTags(unescapeHtml(h1Match[1])));
                        }
                        const convHtml = ChatFormatter.convertHtmlToMarkdown;
                        docMarkdown = convHtml ? convHtml(m.content) : m.content.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match: string, lvl: string, txt: string) => `\n${'#'.repeat(parseInt(lvl, 10))} ${txt.trim()}\n`);
                    } else {
                        const h1Match = m.content.match(/(?:^|\n)#\s+([^\n]+)/);
                        if (h1Match) {
                            docTitle = cleanTitle(h1Match[1]);
                        }
                        docMarkdown = m.content;
                    }

                    if (!docTitle) docTitle = 'Deep Research Report';
                    const safeDocTitle = utilsSanitizeFileName(docTitle, 'report').slice(0, 60);
                    const localName = `files/${scope}${safeDocTitle}.md`;

                    if (!docMarkdown.trim().startsWith('#')) {
                        docMarkdown = `# ${docTitle}\n\n${docMarkdown.trim()}`;
                    }

                    const docObj = {
                        type: 'file',
                        id: `${nid}_doc_${mi + 1}`,
                        title: docTitle,
                        name: `${safeDocTitle}.md`,
                        localName,
                        contentMarkdown: docMarkdown,
                        source: 'extracted-report'
                    };

                    m.documents = m.documents || [];
                    m.attachments = m.attachments || [];
                    m.documents.push(docObj);
                    m.attachments.push(docObj);
                }
            }
        }

        if (chat.error || chat._empty) {
            const isConfirmedDeleted = !!chat.isDeleted
                || !!chat._debug?.isNotFound
                || !!chat._debug?.domDebug?.isNotFound
                || !!chat._debug?.batchexecuteEmptyDebug?.isDeleted
                || isConfirmedDeletedError(chat.error)
                || isConfirmedDeletedError(chat._debug?.batchexecuteEmptyDebug?.error);

            const rawTitle = chat.title || nid;
            const cleanedTitle = cleanZeroWidth(rawTitle);
            const displayTitle = !isBrandPlaceholderTitle(rawTitle) && cleanedTitle ? cleanedTitle : nid;
            const I18n = __resolveModule('I18n', I18nStatic);

            if (isConfirmedDeleted) {
                try {
                    const storage = __resolveModule('StorageService', (typeof window !== 'undefined' && (window as any).StorageService) || null);
                    if (storage && typeof storage.removeConversation === 'function') {
                        await storage.removeConversation(currentSlot || 'u0', nid);
                        const sender = options.messageSender || (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage ? chrome.runtime.sendMessage.bind(chrome.runtime) : null);
                        if (sender) {
                            const p = sender({ action: 'syncUpdate', slot: currentSlot || 'u0', count: -1, from: 'export-prune-deleted' });
                            if (p && p.catch) p.catch(() => {});
                        }
                    }
                } catch (e) {
                    if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:batchWorker.ts]', e);
                }
                onLog(I18n.t('logChatDeletedAndPruned', displayTitle), 'warn');

                return {
                    chat,
                    displayTitle,
                    isConfirmedDeleted: true,
                    isError: true,
                    errMsg: I18n.t('logChatDeletedAndPruned', displayTitle),
                    convsNeedSave: false
                };
            }

            const hasNoMessages = !chat.messages || (Array.isArray(chat.messages) && chat.messages.length === 0);
            const isFatalError = typeof chat.error === 'string' && (
                chat.error.includes('429') ||
                chat.error.includes('401') ||
                chat.error.includes('403') ||
                chat.error.includes('500') ||
                chat.error.includes('502') ||
                chat.error.includes('503') ||
                chat.error.includes('NetworkError') ||
                chat.error.includes('Failed to fetch') ||
                chat.error.includes('超时') ||
                chat.error.includes('timeout') ||
                chat.error.includes('抓取异常')
            );

            if (!isFatalError && hasNoMessages) {
                delete chat.error;
                delete chat._empty;
                chat.messages = [];
                chat.isEmpty = true;
                onLog(I18n.t('logEmptyChatExported', displayTitle), 'info');
            } else {
                const debugInfo = formatDebugInfo(chat._debug) || (chat._raw ? ` _raw_len=${JSON.stringify(chat._raw).length}` : '');
                const errMsg = (chat.error || '云端返回内容为空（服务端未返回任何消息，可能为限频、对话已被清空/归档或新格式未兼容）') + debugInfo;
                onLog(I18n.t('logExportSkipped', displayTitle, errMsg), 'error');

                return {
                    chat,
                    displayTitle,
                    isConfirmedDeleted: false,
                    isError: true,
                    errMsg,
                    convsNeedSave: false
                };
            }
        }

        if (!isRealTitle(chat.title, chat.id) && Array.isArray(chat.messages)) {
            const firstUser = chat.messages.find((m: any) => m.role === 'user' && m.content && m.content.trim());
            if (firstUser) {
                let candidate = firstUser.content.trim();
                candidate = candidate.replace(/^(请问一下|请问|我想问一下|我想问|你能帮我|帮我|你能|请教一下|请教|都说|那么|那个|如果说|如果|我发现|为什么)\s*[,，:：]?\s*/i, '');
                const breakMatch = candidate.match(/^([^，。？！\n\r\t,?!]{4,35})/);
                if (breakMatch && breakMatch[1]) {
                    candidate = breakMatch[1].trim();
                } else {
                    candidate = candidate.slice(0, 30).trim();
                }
                if (isRealTitle(candidate, chat.id)) {
                    chat.title = candidate;
                    chat.titleSource = 'sniff';
                    chat.titles = chat.titles || {};
                    chat.titles.sniff = candidate;
                }
            }
        }

        let finalTitle = chat.title || listConversation?.title || chat.id;

        if (listConversation) {
            listConversation.titles = listConversation.titles || {};
            for (const [k, v] of Object.entries(listConversation.titles)) {
                if (isBrandPlaceholderTitle(v) || (!utilsNormalizeReliableTitleSource(k) && k !== 'legacy')) {
                    delete listConversation.titles[k];
                }
            }
            if (chat.titles && typeof chat.titles === 'object') {
                for (const [k, v] of Object.entries(chat.titles)) {
                    const reliableK = utilsNormalizeReliableTitleSource(k);
                    if (reliableK && typeof v === 'string' && !isBrandPlaceholderTitle(v)) {
                        listConversation.titles[reliableK] = v;
                    }
                }
            }
            const reliableChatSource = utilsNormalizeReliableTitleSource(chat.titleSource);
            if (reliableChatSource && isRealTitle(chat.title, chat.id) && chat.title !== chat.id) {
                listConversation.titles[reliableChatSource] = cleanTitle(chat.title);
            }
            const resolved = resolveTitle(listConversation);
            const cleanResolved = cleanZeroWidth(resolved.title);
            if (resolved.title && /^(Google\s+)?(Gemini|Bard|Google\s+AI)$/i.test(cleanResolved)) {
                if (typeof console !== 'undefined' && console.warn) {
                    console.warn('[Export] skip bad brand resolved title', nid, resolved.title);
                }
            } else if (listConversation.title !== resolved.title || listConversation.titleSource !== resolved.source) {
                listConversation.title = resolved.title;
                listConversation.titleSource = resolved.source;
                convsNeedSave = true;
                onTitleUpdated(nid, listConversation.title, listConversation.titleSource);
            }
            finalTitle = listConversation.title;
        } else if (isRealTitle(chat.title, chat.id)) {
            finalTitle = cleanTitle(chat.title);
        }
        chat.title = finalTitle;

        return {
            chat,
            listTitle: finalTitle,
            isConfirmedDeleted: false,
            isError: false,
            errMsg: null,
            convsNeedSave
        };
    }

    function formatDebugInfo(debug: any): string {
        if (!debug) return '';
        if (typeof debug === 'string') return ` ${debug.slice(0, 300)}`;
        try {
            if (debug.batchexecuteEmptyDebug?.error) {
                return ` (RPC: ${debug.batchexecuteEmptyDebug.error})`;
            }
            if (debug.error) {
                return ` (${debug.error})`;
            }
            if (debug.domDebug?.error) {
                return ` (DOM: ${debug.domDebug.error})`;
            }
            const simplified: Record<string, any> = {};
            for (const k of Object.keys(debug)) {
                if (k === 'rawPreview' || k === 'topPreview') continue;
                simplified[k] = debug[k];
            }
            const str = JSON.stringify(simplified);
            return str && str !== '{}' ? ` ${str.slice(0, 300)}` : '';
        } catch {
            return '';
        }
    }

export {
    fetchChatDetail,
    resolveChat,
    supplementTakeoutGeneratedMedia,
    formatDebugInfo
};

export const BatchWorker: BatchWorkerModule = {
    fetchChatDetail,
    resolveChat,
    supplementTakeoutGeneratedMedia,
    formatDebugInfo
};

export default BatchWorker;

