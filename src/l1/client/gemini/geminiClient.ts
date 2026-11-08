import { OperationError } from '../../../shared/errors/operationError.js';
import type { Account } from '../../../l2/accountRegistry.js';
import { parseGeminiResponse } from '../../parsers/gemini/rpc/parseResponse.js';
import { isConfirmedGeminiDetailNotFound } from '../../parsers/gemini/rpc/parseDeletion.js';
import GeminiProtocol from "../../protocol/gemini/protocol.js";
import { isDevMode } from "../../../runtime/devMode.js";
import { getErrorMessage } from "../../../shared/utils/errorText.js";
import GeminiClientCredentialManager, {
    getBlFromPage,
    getAtFromPage,
    detectSlot,
    updateCredential,
    resolveCred
} from "./api/credentialManager.js";
import GeminiClientRetryPolicy from "./api/retryPolicy.js";
import GeminiClientRpcClient, {
    postBatchexecute,
    getApiUrl
} from "./api/rpcClient.js";
import GeminiClientPagination, {
    type GeminiListRequestOptions,
    type GeminiListFilter,
    type GeminiDetailRequestOptions,
    type PaginatedDetailResult
} from "./api/pagination.js";
import type { ListParseResult } from "../../parsers/gemini/rpc/parseList.js";
import type { DetailParseResult } from "./api/detailTypes.js";

/** Raised only for a characterized Detail RPC not-found business response. */
export class ConfirmedGeminiConversationNotFound extends OperationError {
    constructor(readonly sourceConversationId: string) {
        super('CONVERSATION_NOT_FOUND', 'Confirmed Gemini Detail not found');
        this.name = 'ConfirmedGeminiConversationNotFound';
    }
}

interface GeminiAPIClientOptions {
    signal?: AbortSignal | null;
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
                } else {
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
            return !!globalThis.__gemExporterAborted;
        }

        getApiUrl(s?: string | null): string {
            return getApiUrl(s);
        }

        async getConversationList(pageToken?: string | null, targetSid?: string | null, customFilter?: GeminiListFilter, opts?: GeminiListRequestOptions): Promise<ListParseResult> {
            let cred = await resolveCred(targetSid, opts && (opts._overrideAt || opts._overrideBl) ? { at: opts._overrideAt, bl: opts._overrideBl } : null);
            let api = getApiUrl(cred.accountSlot || "default");
            const filter: GeminiListFilter = customFilter ?? [0, null, 1];
            const P = GeminiProtocol;
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
                } catch (e) { console.debug("[GemExporter:geminiClient.ts]", e); }

                const retry400 = retryPolicy.handleHttp400 ? await retryPolicy.handleHttp400({
                    resp,
                    snippet,
                    cred,
                    isRetried: !!opts?._retried,
                    getAtFromPage,
                    getBlFromPage,
                    updateCredential
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
                        updateCredential,
                        refreshAtFromPage: credentialManager.getAtFromPage
                    });
                }

                const retryCount = (opts && opts._retryCount) || 0;
                const maxRetries = opts?.maxRetries ?? 3;
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
                if (retry429.aborted) throw new DOMException("用户取消：429 退避等待被中断 (getConversationList)", "AbortError");

                throw new OperationError('SOURCE_HTTP_ERROR', `HTTP ${resp.status} :: ${snippet} sidLen:${String(cred.sid ?? '').length} atLen:${cred.at?.length ?? 0} hasBl:${cred.bl ? 'yes' : 'no'}`, resp.status);
            }
            let txt = await resp.text();
            return parseGeminiResponse(txt).list();
        }

        async fetchConversationPage(conversationId: string, pageToken?: string | null, targetSid?: string | null, opts?: GeminiDetailRequestOptions): Promise<DetailParseResult> {
            let id = conversationId.startsWith("c_") ? conversationId : `c_${conversationId}`;
            let cred = await resolveCred(targetSid, opts && (opts._overrideAt || opts._overrideBl) ? { at: opts._overrideAt, bl: opts._overrideBl } : null);
            let api = getApiUrl(cred.accountSlot || "default");
            const isDev = isDevMode();
            if (isDev) {
                console.log(`[Gemini Exporter Client] fetchConversationPage start: ${id}, api: ${api}, slot: ${cred.accountSlot}, hasAt: ${Boolean(cred.at)}, atLen: ${(cred.at || "").length}`);
            }
            const detailOnly = !!(opts && opts.detailOnly);
            const P = GeminiProtocol;
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
                    updateCredential
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
                        updateCredential,
                        refreshAtFromPage: credentialManager.getAtFromPage
                    });
                }

                const retryCount = (opts && opts._retryCount) || 0;
                const maxRetries = opts?.maxRetries ?? 3;
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
                if (retry429.aborted) throw new DOMException("用户取消：429 退避等待被中断 (fetchConversationPage)", "AbortError");

                console.error(`[Gemini Exporter Client] fetchConversationPage HTTP error ${resp.status} for ${id}:`, snippet);
                throw new OperationError('SOURCE_HTTP_ERROR', `HTTP ${resp.status} ${resp.statusText} :: ${snippet}`, resp.status);
            }

            let text = await resp.text();
            const response = parseGeminiResponse(text);
            try {
                const native = response.detail({ providerId: 'gemini', targetConvId: conversationId });
                const parsed = native;
                if (isDev) {
                    console.log(`[Gemini Exporter Client] fetchConversationPage parsed success: ${id}, msgs: ${parsed.conversation.detail.messages.length}`);
                }
                return parsed;
            } catch (err: unknown) {
                const errMsg = getErrorMessage(err);
                const errCategory = GeminiProtocol.classifyDetailError(text, resp?.status);
                if (isConfirmedGeminiDetailNotFound(response.envelope)) {
                    if (isDev) {
                        console.info(`[Gemini Exporter Client] Conversation ${id} is confirmed deleted on server (BardErrorInfo: 1167). Skipping.`);
                    }
                    throw new ConfirmedGeminiConversationNotFound(id);
                }
                if (errCategory === 'confirmed_deleted') {
                    throw new OperationError('SOURCE_RESPONSE_INVALID', `Unverified Gemini Detail not found (${id})`);
                }
                if (errCategory === 'inaccessible') {
                    throw new Error(`会话暂时不可访问或服务端异常 (${id}) [BardErrorInfo]`);
                }
                console.error(`[Gemini Exporter Client] parseDetail failed for ${id}:`, errMsg, "raw text snippet:", text.slice(0, 400));
                throw new OperationError('SOURCE_RESPONSE_INVALID', `解析详情失败 (${errMsg}): ${text.slice(0, 100)}`, undefined, { cause: err });
            }
        }

        async getConversationDetail(conversationId: string, targetSid?: string | null, account?: Account, signal?: AbortSignal): Promise<PaginatedDetailResult> {
            if (pagination.getConversationDetail) {
                return pagination.getConversationDetail(this, conversationId, targetSid, account, signal);
            }
            throw new Error("pagination module not found");
        }

    }

export { GeminiAPIClient };

