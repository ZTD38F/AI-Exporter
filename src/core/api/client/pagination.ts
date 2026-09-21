import { isDevMode } from "../../utils/utils.js";
import type { ConversationListItem } from "../parser/parseList.js";
import type { DetailParseResult } from "../parser/parseDetail.js";

export interface PaginationProgressInfo {
    page: number;
    added: number;
    total: number;
    hasMore: boolean;
    batch?: ConversationListItem[];
    stoppedEarly?: boolean;
    reason?: string;
}

export interface PaginationOptions {
    maxPages?: number;
    onProgress?: ((info: PaginationProgressInfo) => void) | null;
    targetSid?: string | null;
    existingMap?: Map<string, any> | null;
    incremental?: boolean;
    unchangedThreshold?: number;
    signal?: AbortSignal | null;
    [key: string]: any;
}

export interface PaginationResult {
    conversations: ConversationListItem[];
    total: number;
    stoppedEarly?: boolean;
    unchangedStreak?: number;
    diagnostics: any;
    hitGoogleLimit: boolean;
}

export interface GeminiClientPaginationModule {
    getAllConversations: (client: any, maxPages?: number | PaginationOptions, onProgress?: ((info: PaginationProgressInfo) => void) | null, targetSid?: string | null, opts?: PaginationOptions) => Promise<PaginationResult>;
    getConversationDetail: (client: any, conversationId: string, targetSid?: string | null) => Promise<DetailParseResult>;
}

declare global {
    var GeminiClientPagination: GeminiClientPaginationModule;
}

    /**
     * Traverses all conversation list pages with incremental detection and Google limit tracking
     */
    async function getAllConversations(client: any, maxPages: number | PaginationOptions = 2000, onProgress?: ((info: PaginationProgressInfo) => void) | null, targetSid?: string | null, opts?: PaginationOptions): Promise<PaginationResult> {
        if (typeof maxPages === "object" && maxPages !== null) {
            opts = maxPages;
            maxPages = opts.maxPages !== undefined ? opts.maxPages : 2000;
            onProgress = opts.onProgress || null;
            targetSid = opts.targetSid || null;
        }
        if (!maxPages || typeof maxPages !== "number") maxPages = 2000;
        opts = opts || {};
        const existingMap = opts.existingMap || null;
        const incremental = !!opts.incremental;
        const unchangedThreshold = opts.unchangedThreshold || 5;
        let all: ConversationListItem[] = [],
            seen = new Set<string>(),
            token: string | null = null;
        let unchangedStreak = 0;
        const diagLog: any = {
            startTime: new Date().toISOString(),
            maxPages,
            incremental,
            totalPagesFetched: 0,
            totalConversations: 0,
            stopReason: "就绪（尚未触发同步）",
            hitGoogleLimit: false,
            pageHistory: []
        };
        client.aborted = false;

        const isAborted = () => {
            if (opts?.signal?.aborted) return true;
            if (typeof client.isAborted === "function") return client.isAborted(opts?.signal);
            return !!(
                client.aborted ||
                (typeof window !== "undefined" && (window as any).__gemExporterAborted) ||
                (typeof globalThis !== "undefined" && (globalThis as any).__gemExporterAborted)
            );
        };

        let reachedMax = true;
        for (let i = 0; i < maxPages; i++) {
            if (isAborted()) {
                diagLog.stopReason = `用户手动终止同步 (已拉取 ${i} 页，共 ${all.length} 条)`;
                console.log(`[Gemini Exporter] getAllConversations aborted by user at page ${i + 1}`);
                reachedMax = false;
                break;
            }
            let res: any;
            try {
                res = await client.getConversationList(token, targetSid, undefined, { signal: opts?.signal });
            } catch (err: any) {
                console.warn(`[Gemini Exporter] getAllConversations page ${i + 1} stopped:`, err.message || err);
                const errMsg = String(err?.message || err);
                const isLimit = errMsg.includes("BardErrorInfo")
                    || errMsg.includes("1096")
                    || errMsg.includes("429")
                    || /quota|rate\s*limit|resource_exhausted|too\s*many\s*requests/i.test(errMsg);
                if (isLimit) {
                    diagLog.hitGoogleLimit = true;
                }
                diagLog.stopReason = `网络或服务异常: ${err.message || err}`;
                reachedMax = false;
                if (all.length > 0) {
                    break;
                }
                throw err;
            }
            diagLog.totalPagesFetched = i + 1;
            diagLog.pageHistory.push({
                page: i + 1,
                requestedToken: token ? { len: token.length, preview: token.slice(0, 20) + "..." } : null,
                count: res?.conversations?.length || 0,
                hasNextPageToken: !!res?.nextPageToken,
                nextTokenPreview: res?.nextPageToken ? { len: res.nextPageToken.length, preview: res.nextPageToken.slice(0, 20) + "..." } : null,
                debugInfo: res?._debug || null
            });
            let added = 0;
            if (Array.isArray(res?.conversations)) {
                for (let c of res.conversations) {
                    if (!seen.has(c.id)) {
                        seen.add(c.id);
                        all.push(c);
                        added++;
                        if (incremental && existingMap) {
                            const stored = existingMap.get(c.id);
                            if (stored && stored.timestamp && c.timestamp) {
                                const sameTime = Math.abs(stored.timestamp - c.timestamp) < 60000;
                                const sameTitle = !stored.title || !c.title || stored.title === c.title;
                                if (sameTime && sameTitle) {
                                    unchangedStreak++;
                                } else {
                                    unchangedStreak = 0;
                                }
                            } else if (!stored) {
                                unchangedStreak = 0;
                            } else {
                                unchangedStreak = 0;
                            }
                            if (unchangedStreak >= unchangedThreshold) {
                                diagLog.stopReason = `增量同步命中连续 ${unchangedStreak} 条已存在历史，早退终止`;
                                diagLog.totalConversations = all.length;
                                diagLog.endTime = new Date().toISOString();
                                if (onProgress) onProgress({
                                    page: i + 1,
                                    added,
                                    total: all.length,
                                    hasMore: false,
                                    stoppedEarly: true,
                                    reason: "增量同步完成"
                                });
                                return {
                                    conversations: all,
                                    total: all.length,
                                    stoppedEarly: true,
                                    unchangedStreak,
                                    diagnostics: diagLog,
                                    hitGoogleLimit: !!diagLog.hitGoogleLimit
                                };
                            }
                        }
                    }
                }
            }
            if (!res?.conversations || res.conversations.length === 0) {
                const isGoogleLimit = res?._debug?.bardError || res?._debug?.error === "BARD_ERROR_INFO";
                if (isGoogleLimit) {
                    diagLog.hitGoogleLimit = true;
                    diagLog.stopReason = `Google 服务端翻页到达极限 (BardErrorInfo: 游标链已达服务端上限)`;
                } else {
                    diagLog.stopReason = `第 ${i + 1} 页返回 0 条数据，Google 服务端已无更早历史`;
                }
                reachedMax = false;
                console.log(`[Gemini Exporter] getAllConversations reached end at page ${i + 1}, total: ${all.length}, reason: ${diagLog.stopReason}`);
                break;
            }
            if (onProgress) onProgress({
                page: i + 1,
                added,
                total: all.length,
                hasMore: !!res.nextPageToken,
                batch: res.conversations
            });
            if (!res.nextPageToken) {
                diagLog.stopReason = `第 ${i + 1} 页未返回下页游标 nextPageToken，Google 服务端游标已到底`;
                reachedMax = false;
                console.log(`[Gemini Exporter] getAllConversations finished at page ${i + 1}, total: ${all.length}, hitGoogleLimit: ${diagLog.hitGoogleLimit}`);
                break;
            }
            token = res.nextPageToken;
            const pageDelay = incremental ? 50 : 120;
            await new Promise(r => setTimeout(r, pageDelay));
        }
        if (reachedMax && maxPages > 0) {
            diagLog.stopReason = `已达到最大页数限制 (${maxPages} 页)`;
        }
        diagLog.totalConversations = all.length;
        diagLog.endTime = new Date().toISOString();
        return {
            conversations: all,
            total: all.length,
            diagnostics: diagLog,
            hitGoogleLimit: !!diagLog.hitGoogleLimit
        };
    }

    /**
     * Traverses and aggregates all turns of a conversation detail with metadata-only retry
     */
    async function getConversationDetail(client: any, conversationId: string, targetSid?: string | null): Promise<DetailParseResult> {
        const MAX_DETAIL_PAGES = 250;

        type PageCollection = {
            first: any;
            messages: any[];
            remainingToken: string | null;
            pagesFetched: number;
            stopReason: "end_of_history" | "token_loop" | "safety_limit";
        };

        const collectPages = async (pageOptions?: any): Promise<PageCollection> => {
            let msgs: any[] = [];
            let token: string | null = null;
            let first: any = null;
            let pagesFetched = 0;
            let stopReason: PageCollection["stopReason"] = "end_of_history";
            const seenTokens = new Set<string>();
            const seenMsgIds = new Set<string>();
            const cleanConvId = String(conversationId).replace(/^c_/, "");

            while (pagesFetched < MAX_DETAIL_PAGES) {
                const page: any = await client.fetchConversationPage(
                    conversationId,
                    token,
                    targetSid,
                    pageOptions
                );
                if (!first) first = page;

                const fresh = (Array.isArray(page?.messages) ? page.messages : []).filter((m: any) => {
                    const mid = m?.id;
                    if (mid === null || mid === undefined || mid === "") return true;
                    const midStr = String(mid);
                    // Some Gemini payloads use the conversation id as a synthetic
                    // message id. Keep those entries rather than accidentally
                    // deduplicating legitimate turns.
                    if (midStr.replace(/^c_/, "") === cleanConvId) return true;
                    if (seenMsgIds.has(midStr)) return false;
                    seenMsgIds.add(midStr);
                    return true;
                });
                msgs = [...fresh, ...msgs];
                pagesFetched++;

                const nextToken: string | null = page?.nextPageToken || null;
                if (!nextToken) {
                    token = null;
                    stopReason = "end_of_history";
                    break;
                }

                if (seenTokens.has(nextToken)) {
                    token = nextToken;
                    stopReason = "token_loop";
                    break;
                }

                seenTokens.add(nextToken);
                token = nextToken;
            }

            if (token && pagesFetched >= MAX_DETAIL_PAGES && stopReason !== "token_loop") {
                stopReason = "safety_limit";
            }

            return {
                first,
                messages: msgs,
                remainingToken: token,
                pagesFetched,
                stopReason
            };
        };

        let collected = await collectPages();
        let first = collected.first;
        let msgs = collected.messages;

        if (!first) throw new Error("no data");

        // If the primary request returned metadata-only (no messages, but raw data present),
        // retry the same complete pagination flow using DETAIL-only RPC and alternate params.
        if (!msgs.length && first._raw) {
            const inner = first._raw;
            const looksMetadataOnly = Array.isArray(inner) && inner[0] === null && inner[1] === null
                && Array.isArray(inner[2]) && inner[2].length > 0
                && typeof inner[2][0]?.[0] === "string" && inner[2][0][0].startsWith("c_");
            if (looksMetadataOnly) {
                try {
                    const primaryTitle = first.title;
                    const primaryTitles = first.titles;
                    const primarySource = first.titleSource;
                    const retryCollected = await collectPages({ detailOnly: true, altParams: true });
                    if (retryCollected.first && retryCollected.messages.length > 0) {
                        collected = retryCollected;
                        first = retryCollected.first;
                        msgs = retryCollected.messages;
                        if (primarySource === "rpc" && primaryTitle && primaryTitle !== "未命名对话" && first.titleSource !== "rpc") {
                            first.title = primaryTitle;
                            first.titles = { ...(first.titles || {}), ...(primaryTitles || {}) };
                            first.titleSource = "rpc";
                        }
                    }
                } catch (retryErr: any) {
                    if (isDevMode()) {
                        console.warn("[Gemini Exporter Client] metadata-only retry also failed:", retryErr.message);
                    }
                }
            }
        }

        const paginationComplete = collected.stopReason === "end_of_history" && !collected.remainingToken;
        let allTimestamps = msgs.map(m => m.timestamp).filter((x: any): x is number => typeof x === "number" && Number.isFinite(x) && x > 0);
        let minTs = allTimestamps.length ? Math.min(...allTimestamps) : (first.createdAt || null);
        let maxTs = allTimestamps.length ? Math.max(...allTimestamps) : (first.updatedAt || minTs || null);
        let attachmentCount = msgs.reduce((a: number, m: any) => a + (m.attachmentCount || 0), 0);
        let cleanId = String(conversationId).replace(/^c_/, "").trim();

        return {
            ...first,
            id: cleanId,
            messages: msgs,
            messageCount: msgs.length,
            timestamp: maxTs,
            createdAt: minTs,
            chatTime: maxTs,
            updatedAt: maxTs,
            attachmentCount,
            // Do not leak the first page's token into the aggregate result.
            // A non-null token here now always means the aggregate is incomplete.
            nextPageToken: paginationComplete ? null : collected.remainingToken,
            pagination: {
                pagesFetched: collected.pagesFetched,
                complete: paginationComplete,
                stopReason: collected.stopReason,
                remainingToken: paginationComplete ? null : collected.remainingToken
            }
        };
    }

export {
    getAllConversations,
    getConversationDetail
};

export const GeminiClientPagination: GeminiClientPaginationModule = {
    getAllConversations,
    getConversationDetail
};

if (typeof globalThis !== "undefined" && !(globalThis as any).GeminiClientPagination) {
    (globalThis as any).GeminiClientPagination = GeminiClientPagination;
}
if (typeof module === "object" && module.exports) {
    module.exports = GeminiClientPagination;
}
export default GeminiClientPagination;
