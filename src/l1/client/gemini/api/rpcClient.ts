import type { GeminiProtocolModule } from "../../../protocol/gemini/protocol.js";
import type { GeminiCredentials } from './credentialManager.js';

const GEMINI_API_URL = "https://gemini.google.com/_/BardChatUi/data/batchexecute";

interface RpcRequestOptions {
    api: string;
    rpcids: string;
    fReq: string;
    cred?: Partial<GeminiCredentials>;
    sourcePath?: string;
    timeoutMs?: number;
    signal?: AbortSignal | null;
}

interface GeminiClientRpcClientModule {
    GEMINI_API_URL: string;
    getProtocol: () => GeminiProtocolModule;
    getApiUrl: (slot?: string | null) => string;
    nextReqid: () => string;
    generateFallbackSid: () => string;
    postBatchexecute: (options: RpcRequestOptions) => Promise<Response>;
    mergeAbortSignals: (signals: Array<AbortSignal | null | undefined>) => AbortSignal | undefined;
}

import { GeminiProtocol } from "../../../protocol/gemini/protocol.js";
import { generateFallbackSid } from "./credentialManager.js";

function getProtocol(): GeminiProtocolModule {
    return GeminiProtocol;
}

const nextReqid = GeminiProtocol.createReqidGenerator();

    function getApiUrl(slot?: string | null): string {
        if (slot && slot !== "default") {
            let t = slot.startsWith("/") ? slot : (slot.startsWith("u/") ? `/${slot}` : slot.replace(/^u/, "/u/"));
            return `https://gemini.google.com${t}/_/BardChatUi/data/batchexecute`;
        }
        return GEMINI_API_URL;
    }

    function mergeAbortSignals(signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
        const active = signals.filter((s): s is AbortSignal => !!s);
        if (active.length === 0) return undefined;
        if (active.length === 1) return active[0];
        return AbortSignal.any(active);
    }

    async function postBatchexecute(options: RpcRequestOptions): Promise<Response> {
        const {
            api,
            rpcids,
            fReq,
            cred,
            sourcePath = "/app",
            timeoutMs = 0,
            signal
        } = options;

        const P = getProtocol();
        const params = new URLSearchParams({
            rpcids,
            "source-path": sourcePath,
            bl: cred?.bl || P.BL_FALLBACK,
            "f.sid": String(cred?.sid || generateFallbackSid()),
            _reqid: nextReqid(),
            rt: "c"
        });

        const body = new URLSearchParams();
        body.append("f.req", fReq);
        if (cred?.at) body.append("at", cred.at);

        let controller: AbortController | null = null;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;

        if (timeoutMs > 0 && typeof AbortController !== "undefined") {
            controller = new AbortController();
            timeoutId = setTimeout(() => {
                try { controller?.abort(); } catch (_) {}
            }, timeoutMs);
        }

        try {
            const resp = await fetch(`${api}?${params}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                    "X-Same-Domain": "1"
                },
                body: body.toString(),
                credentials: "include",
                signal: mergeAbortSignals([signal, controller ? controller.signal : null])
            });
            return resp;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }
    }

export { getApiUrl, postBatchexecute };

const GeminiClientRpcClient: GeminiClientRpcClientModule = {
    GEMINI_API_URL,
    getProtocol,
    getApiUrl,
    nextReqid,
    generateFallbackSid,
    postBatchexecute,
    mergeAbortSignals
};

export default GeminiClientRpcClient;

