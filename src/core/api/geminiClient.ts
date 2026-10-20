import GeminiProtocol, { GeminiProtocolModule } from "../protocol/protocol.js";
import { isDevMode } from "../utils/utils.js";
import { extractConversationIdFromUrl } from "../utils/pathUtils.js";
import { GeminiResponseParserClass, type GeminiResponseParserFacade } from "./geminiParser.js";
import { __resolveModule } from "../utils/moduleOverrides.js";
import GeminiClientCredentialManager, {
    getBlFromPage,
    getAtFromPage,
    detectSlot,
    loadCredMap,
    resolveCred
} from "./client/credentialManager.js";
import GeminiClientRetryPolicy from "./client/retryPolicy.js";
import GeminiClientRpcClient, {
    postBatchexecute,
    getApiUrl
} from "./client/rpcClient.js";
import GeminiClientPagination, {
    type PaginationOptions,
    type PaginationResult
} from "./client/pagination.js";
import type { ListParseResult } from "./parser/parseList.js";
import type { DetailParseResult } from "./parser/parseDetail.js";

export interface GeminiAPIClientOptions {
    signal?: AbortSignal | null;
    [key: string]: any;
}

function getProtocol(): GeminiProtocolModule {
    return __resolveModule('GeminiProtocol', GeminiProtocol);
}

function getParser(): GeminiResponseParserFacade {
    return GeminiResponseParserClass;
}

const credentialManager = GeminiClientCredentialManager;
const retryPolicy = GeminiClientRetryPolicy;
const rpcClient = GeminiClientRpcClient;
const pagination = GeminiClientPagination;

    class GeminiAPIClient {
        public aborted: boolean;
        public signal: AbortSignal | null;

        constructor(options: GeminiAPIClientOptions = {}) {
            this.aborted = false;
            this.signal = options?.signal || null;
            if (this.signal) {
                if (this.signal.aborted) {
                    this.aborted = true;
                } else if (typeof this.signal.addEventListener === "function") {
                    this.signal.addEventListener("abort", () => {
                        this.aborted = true;
                    }, { once: true });
                }
            }
        }

        abort(): void {
            this.aborted = true;
        }

        // 兼容标准 AbortSignal 及过渡期全局标志（仅作 fallback: window.__gemExporterAborted）
        isAborted(callSignal?: AbortSignal | null): boolean {
            if (this.aborted) return true;
            if (callSignal && callSignal.aborted) return true;
            if (this.signal && this.signal.aborted) return true;
            return !!(
                (typeof globalThis !== "undefined" && (globalThis as any).__gemExporterAborted) ||
                (typeof window !== "undefined" && (window as any).__gemExporterAborted)
            );
        }

        getApiUrl(s?: string | null): string {
            return getApiUrl(s);
        }

        async getConversationList(pageToken?: string | null, targetSid?: string | null, customFilter?: any, opts?: any): Promise<ListParseResult> {
            let cred = await resolveCred(targetSid, opts && (opts._overrideAt || opts._overrideBl) ? { at: opts._overrideAt, bl: opts._overrideBl } : null);
            let api = getApiUrl(cred.accountSlot || "default");
            const filter = customFilter || [0, null, 1];
            const P = getProtocol();
            // JSPB request layout: [pageSize=50, pageToken, filter]
            let req = JSON.stringify([
                [
                    [P.RPCS.LIST, JSON.stringify([50, pageToken || null, filter]), null, "generic"]
                ]
            ]);

            let resp = await postBatchexecute({
                api,
                rpcids: P.RPCS.LIST,
                fReq: req,
                cred,
                sourcePath: "/app",
                timeoutMs: 30000,
                signal: opts?.signal || this.signal
            });

            if (!resp.ok) {
                let snippet = "";
                try {
                    snippet = (await resp.text()).slice(0, 320);
                } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:geminiClient.ts]", e); }

                const retry400 = retryPolicy.handleHttp400 ? await retryPolicy.handleHttp400({
                    resp,
                    snippet,
                    cred,
                    isRetried: !!opts?._retried,
                    getAtFromPage,
                    getBlFromPage,
                    loadCredMap,
                    getCredStorage: credentialManager.getCredStorage
                }) : { shouldRetry: false };

                if (retry400.shouldRetry) {
                    return this.getConversationList(pageToken, targetSid, customFilter, {
                        ...(opts || {}),
                        _retried: true,
                        _overrideAt: retry400.freshAt,
                        _overrideBl: retry400.freshBl
                    });
                }

                if (resp.status === 401 && retryPolicy.handleHttp401) {
                    await retryPolicy.handleHttp401({
                        cred,
                        loadCredMap,
                        getCredStorage: credentialManager.getCredStorage,
                        refreshAtFromPage: credentialManager.getAtFromPage
                    });
                }

                const retryCount = (opts && opts._retryCount) || 0;
                const maxRetries = (opts && opts.maxRetries) !== undefined ? opts.maxRetries : 3;
                const retry429 = retryPolicy.handleHttp429 ? await retryPolicy.handleHttp429({
                    resp,
                    retryCount,
                    maxRetries,
                    signal: opts?.signal || this.signal,
                    label: "getConversationList"
                }) : { shouldRetry: false };

                if (retry429.shouldRetry) {
                    return this.getConversationList(pageToken, targetSid, customFilter, {
                        ...(opts || {}),
                        _retryCount: retry429.nextRetryCount
                    });
                }
                if ((retry429 as any).aborted) throw new Error("用户取消：429 退避等待被中断 (getConversationList)");

                throw new Error(`HTTP ${resp.status} :: ${snippet} sidLen:${cred.sid?.length ?? 0} atLen:${cred.at?.length ?? 0} hasBl:${cred.bl ? 'yes' : 'no'}`);
            }
            let txt = await resp.text();
            return getParser().parseList(txt);
        }

        // Note: If all.length >= 500 or pagination flags hitGoogleLimit / 429 errors,
        // UI layer provides browsing window limit guidance to recommend Takeout.
        async getAllConversations(maxPages: number | PaginationOptions = 2000, onProgress?: any, targetSid?: string | null, opts?: any): Promise<PaginationResult> {
            if (pagination.getAllConversations) {
                return pagination.getAllConversations(this, maxPages, onProgress, targetSid, opts);
            }
            throw new Error("pagination module not found");
        }

        async fetchConversationPage(conversationId: string, pageToken?: string | null, targetSid?: string | null, opts?: any): Promise<DetailParseResult> {
            let id = conversationId.startsWith("c_") ? conversationId : `c_${conversationId}`;
            let cred = await resolveCred(targetSid, opts && (opts._overrideAt || opts._overrideBl) ? { at: opts._overrideAt, bl: opts._overrideBl } : null);
            let api = getApiUrl(cred.accountSlot || "default");
            const isDev = isDevMode();
            if (isDev) {
                console.log(`[Gemini Exporter Client] fetchConversationPage start: ${id}, api: ${api}, slot: ${cred.accountSlot}, hasAt: ${Boolean(cred.at)}, atLen: ${(cred.at || "").length}`);
            }
            const detailOnly = !!(opts && opts.detailOnly);
            const P = getProtocol();
            const rpcids = detailOnly ? P.RPCS.DETAIL : `${P.RPCS.DETAIL},${P.RPCS.LIST}`;
            // JSPB request layout:
            // DETAIL: [convId, 10|null, pageToken, 1, [1], [4], null, 1]
            // META: [1, null, [null, null, 1, null, 1, convId]]

            let innerDetail = (opts && opts.altParams)
                ? JSON.stringify([id, null, pageToken || null, 1, [1], [4], null, 1])
                : JSON.stringify([id, 10, pageToken || null, 1, [1], [4], null, 1]);
            let innerMeta = JSON.stringify([1, null, [null, null, 1, null, 1, id]]);
            let fReq = detailOnly
                ? JSON.stringify([[[P.RPCS.DETAIL, innerDetail, null, "generic"]]])
                : JSON.stringify([[[P.RPCS.DETAIL, innerDetail, null, "generic"], [P.RPCS.LIST, innerMeta, null, "generic"]]]);

            let resp = await postBatchexecute({
                api,
                rpcids,
                fReq,
                cred,
                sourcePath: "/app",
                timeoutMs: 15000,
                signal: opts?.signal || this.signal
            });

            if (!resp.ok) {
                let snippet = "";
                try {
                    snippet = (await resp.text()).slice(0, 320);
                } catch { /* intentional: best-effort cleanup */ }

                const retry400 = retryPolicy.handleHttp400 ? await retryPolicy.handleHttp400({
                    resp,
                    snippet,
                    cred,
                    isRetried: !!opts?._retriedXsrf,
                    getAtFromPage,
                    getBlFromPage,
                    loadCredMap,
                    getCredStorage: credentialManager.getCredStorage
                }) : { shouldRetry: false };

                if (retry400.shouldRetry) {
                    return this.fetchConversationPage(conversationId, pageToken, targetSid, {
                        ...(opts || {}),
                        _retriedXsrf: true,
                        _overrideAt: retry400.freshAt,
                        _overrideBl: retry400.freshBl
                    });
                }

                if (resp.status === 401 && retryPolicy.handleHttp401) {
                    await retryPolicy.handleHttp401({
                        cred,
                        loadCredMap,
                        getCredStorage: credentialManager.getCredStorage,
                        refreshAtFromPage: credentialManager.getAtFromPage
                    });
                }

                const retryCount = (opts && opts._retryCount) || 0;
                const maxRetries = (opts && opts.maxRetries) !== undefined ? opts.maxRetries : 3;
                const retry429 = retryPolicy.handleHttp429 ? await retryPolicy.handleHttp429({
                    resp,
                    retryCount,
                    maxRetries,
                    signal: opts?.signal || this.signal,
                    label: `fetchConversationPage ${id}`
                }) : { shouldRetry: false };
                if (retry429.shouldRetry) {
                    return this.fetchConversationPage(conversationId, pageToken, targetSid, {
                        ...(opts || {}),
                        _retryCount: retry429.nextRetryCount
                    });
                }
                if ((retry429 as any).aborted) throw new Error("用户取消：429 退避等待被中断 (fetchConversationPage)");

                console.error(`[Gemini Exporter Client] fetchConversationPage HTTP error ${resp.status} for ${id}:`, snippet);
                throw new Error(`HTTP ${resp.status} ${resp.statusText} :: ${snippet}`);
            }

            let text = await resp.text();
            try {
                let parsed = getParser().parseDetail(text, conversationId);
                if (isDev) {
                    console.log(`[Gemini Exporter Client] fetchConversationPage parsed success: ${id}, msgs: ${parsed.messages?.length}`);
                }
                return parsed;
            } catch (err: any) {
                const errCategory = getProtocol().classifyDetailError(text, resp?.status);
                if (errCategory === 'confirmed_deleted') {
                    if (isDev) {
                        console.info(`[Gemini Exporter Client] Conversation ${id} is confirmed deleted on server (BardErrorInfo: 1167). Skipping.`);
                    }
                    throw new Error(`会话已在服务端删除 (${id}) [BardErrorInfo: 1167]`);
                }
                if (errCategory === 'rate_limited') {
                    throw new Error(`Google 服务端限流或到达上限 (${id}) [BardErrorInfo: 1096]`);
                }
                if (errCategory === 'inaccessible') {
                    throw new Error(`会话暂时不可访问或服务端异常 (${id}) [BardErrorInfo]`);
                }
                console.error(`[Gemini Exporter Client] parseDetail failed for ${id}:`, err.message, "raw text snippet:", text.slice(0, 400));
                throw new Error(`解析详情失败 (${err.message}): ${text.slice(0, 100)}`);
            }
        }

        async getConversationDetail(conversationId: string, targetSid?: string | null): Promise<DetailParseResult> {
            if (pagination.getConversationDetail) {
                return pagination.getConversationDetail(this, conversationId, targetSid);
            }
            throw new Error("pagination module not found");
        }

        getCurrentConversationId(url?: string): string | null {
            const targetUrl = url || (typeof window !== "undefined" && window.location ? window.location.href : null);
            if (!targetUrl) return null;
            return extractConversationIdFromUrl(targetUrl);
        }
    }

export {
    GeminiAPIClient,
    getApiUrl,
    detectSlot,
    resolveCred,
    loadCredMap,
    credentialManager,
    retryPolicy,
    rpcClient,
    pagination
};

export const GeminiClientExports = {
    GeminiAPIClient,
    getApiUrl,
    detectSlot,
    resolveCred,
    loadCredMap,
    credentialManager,
    retryPolicy,
    rpcClient,
    pagination
};

type GetApiUrlFn = typeof getApiUrl;
type DetectSlotFn = typeof detectSlot;
type ResolveCredFn = typeof resolveCred;
type LoadCredMapFn = typeof loadCredMap;



if (typeof module === "object" && module.exports) {
    module.exports = GeminiClientExports;
}

export default GeminiClientExports;
