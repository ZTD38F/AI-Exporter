import GeminiProtocol, { GeminiProtocolModule } from "../protocol/protocol.js";
import { isDevMode } from "../utils/utils.js";
import { GeminiResponseParserClass, type GeminiResponseParserFacade } from "./geminiParser.js";
import GeminiClientCredentialManager, {
    GeminiClientCredentialManagerModule,
    GeminiCredentials,
    getBlFromPage,
    getAtFromPage,
    detectSlot,
    getCredStorage,
    loadCredMap,
    resolveCred
} from "./client/credentialManager.js";
import GeminiClientRetryPolicy, {
    GeminiClientRetryPolicyModule,
    handleHttp400,
    handleHttp401,
    handleHttp429
} from "./client/retryPolicy.js";
import GeminiClientRpcClient, {
    GeminiClientRpcClientModule,
    postBatchexecute,
    getApiUrl
} from "./client/rpcClient.js";
import GeminiClientPagination, {
    GeminiClientPaginationModule,
    PaginationOptions,
    PaginationResult,
    getAllConversations,
    getConversationDetail
} from "./client/pagination.js";
import type { ListParseResult } from "./parser/parseList.js";
import type { DetailParseResult } from "./parser/parseDetail.js";

export interface GeminiAPIClientOptions {
    signal?: AbortSignal | null;
    [key: string]: any;
}

function getProtocol(): GeminiProtocolModule {
    if (typeof globalThis !== "undefined" && (globalThis as any).GeminiProtocol) {
        return (globalThis as any).GeminiProtocol;
    }
    return GeminiProtocol;
}

function getParser(): GeminiResponseParserFacade {
    if (typeof globalThis !== "undefined" && (globalThis as any).GeminiResponseParserClass) {
        return (globalThis as any).GeminiResponseParserClass;
    }
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

        // 兼容标准 AbortSignal 及过渡期全局标志（仅作 fallback）
        isAborted(callSignal?: AbortSignal | null): boolean {
            if (this.aborted) return true;
            if (callSignal && callSignal.aborted) return true;
            if (this.signal && this.signal.aborted) return true;
            return !!(
                (typeof window !== "undefined" && ((window as any).__gemExporterAborted || (window as any).window?.__gemExporterAborted)) ||
                (typeof window !== "undefined" && (window as any)['__gemExporterAborted']) || // window.__gemExporterAborted fallback check
                (typeof globalThis !== "undefined" && (globalThis as any).__gemExporterAborted)
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
            let req = pageToken ? JSON.stringify([
                    [
                        [P.RPCS.LIST, JSON.stringify([50, pageToken, filter]), null, "generic"]
                    ]
                ]) :
                JSON.stringify([
                    [
                        [P.RPCS.LIST, JSON.stringify([50, null, filter]), null, "generic"]
                    ]
                ]);

            let resp = await postBatchexecute({
                api,
                rpcids: P.RPCS.LIST,
                fReq: req,
                cred,
                sourcePath: "/app",
                signal: opts?.signal || this.signal
            });

            if (!resp.ok) {
                let snippet = "";
                try {
                    snippet = (await resp.text()).slice(0, 320);
                } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:geminiClient.ts]", e); }

                // 400 Bad Request XSRF token retry
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

                // 401 Unauthorized cleanup
                if (resp.status === 401 && retryPolicy.handleHttp401) {
                    await retryPolicy.handleHttp401({
                        cred,
                        loadCredMap,
                        getCredStorage: credentialManager.getCredStorage
                    });
                }

                // 429 Rate limiting backoff
                const retryCount = (opts && opts._retryCount) || 0;
                const maxRetries = (opts && opts.maxRetries) !== undefined ? opts.maxRetries : 3;
                const retry429 = retryPolicy.handleHttp429 ? await retryPolicy.handleHttp429({
                    resp,
                    retryCount,
                    maxRetries,
                    label: "getConversationList"
                }) : { shouldRetry: false };

                if (retry429.shouldRetry) {
                    return this.getConversationList(pageToken, targetSid, customFilter, {
                        ...(opts || {}),
                        _retryCount: retry429.nextRetryCount
                    });
                }

                throw new Error(`HTTP ${resp.status} :: ${snippet} sid:${cred.sid?.slice(0,6)} atLen:${cred.at?.length} bl:${cred.bl?.slice(0,12)}`);
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

                // 400 Bad Request XSRF token retry
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

                // 401 Unauthorized cleanup
                if (resp.status === 401 && retryPolicy.handleHttp401) {
                    await retryPolicy.handleHttp401({
                        cred,
                        loadCredMap,
                        getCredStorage: credentialManager.getCredStorage
                    });
                }

                // 429 Rate limiting backoff
                const retryCount = (opts && opts._retryCount) || 0;
                const maxRetries = (opts && opts.maxRetries) !== undefined ? opts.maxRetries : 3;
                const retry429 = retryPolicy.handleHttp429 ? await retryPolicy.handleHttp429({
                    resp,
                    retryCount,
                    maxRetries,
                    label: `fetchConversationPage ${id}`
                }) : { shouldRetry: false };
                if (retry429.shouldRetry) {
                    return this.fetchConversationPage(conversationId, pageToken, targetSid, {
                        ...(opts || {}),
                        _retryCount: retry429.nextRetryCount
                    });
                }

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
                const isDeletedOrInaccessible = text && (text.includes("BardErrorInfo") || text.includes("1167"));
                if (isDeletedOrInaccessible) {
                    if (isDev) {
                        console.info(`[Gemini Exporter Client] Conversation ${id} is inaccessible or deleted on server (BardErrorInfo: 1167). Skipping.`);
                    }
                    throw new Error(`会话已在服务端删除或不可访问 (${id})`);
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

        // @contentScriptOnly — requires live page DOM, guarded for non-DOM environments
        getCurrentConversationId(): string | null {
            if (typeof document === "undefined") return null;
            try {
                const glob: any = typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : {});
                let u = new URL(glob.location.href);
                let parts = u.pathname.split("/");
                let idx = parts.indexOf("app");
                if (idx !== -1 && idx < parts.length - 1) return parts[idx + 1];
                let g = parts.indexOf("gem");
                if (g !== -1 && g < parts.length - 2) return parts[g + 2];
                return null;
            } catch {
                return null;
            }
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

declare global {
    var GeminiAPIClient: typeof GeminiAPIClient;
    var getApiUrl: GetApiUrlFn;
    var detectSlot: DetectSlotFn;
    var resolveCred: ResolveCredFn;
    var loadCredMap: LoadCredMapFn;
}

if (typeof globalThis !== "undefined") {
    if (!(globalThis as any).GeminiAPIClient) (globalThis as any).GeminiAPIClient = GeminiAPIClient;
    if (!(globalThis as any).getApiUrl) (globalThis as any).getApiUrl = getApiUrl;
    if (!(globalThis as any).detectSlot) (globalThis as any).detectSlot = detectSlot;
    if (!(globalThis as any).resolveCred) (globalThis as any).resolveCred = resolveCred;
    if (!(globalThis as any).loadCredMap) (globalThis as any).loadCredMap = loadCredMap;
}

if (typeof module === "object" && module.exports) {
    module.exports = GeminiClientExports;
}

export default GeminiClientExports;
