// rpcClient.ts - Low-level HTTP POST and batchexecute RPC communication
import type { GeminiProtocolModule } from "../../protocol/protocol.js";

const GEMINI_API_URL = "https://gemini.google.com/_/BardChatUi/data/batchexecute";

export interface RpcRequestOptions {
    api: string;
    rpcids: string;
    fReq: string;
    cred?: any;
    sourcePath?: string;
    timeoutMs?: number;
    signal?: AbortSignal | null;
}

export interface GeminiClientRpcClientModule {
    GEMINI_API_URL: string;
    getProtocol: () => GeminiProtocolModule;
    getUtils: () => any;
    getParser: () => any;
    getApiUrl: (slot?: string | null) => string;
    nextReqid: () => string;
    generateFallbackSid: () => string;
    postBatchexecute: (options: RpcRequestOptions) => Promise<Response>;
}

declare global {
    var GeminiClientRpcClient: GeminiClientRpcClientModule;
}

import { GeminiProtocol } from "../../protocol/protocol.js";
import { GeminiUtils } from "../../utils/utils.js";
import { GeminiResponseParserClass } from "../geminiParser.js";

function getProtocol(): GeminiProtocolModule {
    return GeminiProtocol;
}

const nextReqid = GeminiProtocol.createReqidGenerator();

function getUtils(): any {
    return GeminiUtils;
}

function getParser(): any {
    return GeminiResponseParserClass;
}


    function getApiUrl(slot?: string | null): string {
        if (slot && slot !== "default") {
            let t = slot.startsWith("/") ? slot : (slot.startsWith("u/") ? `/${slot}` : slot.replace(/^u/, "/u/"));
            return `https://gemini.google.com${t}/_/BardChatUi/data/batchexecute`;
        }
        return GEMINI_API_URL;
    }

    function generateFallbackSid(): string {
        return String(Math.floor(Math.random() * 1e19));
    }

    /**
     * Executes raw batchexecute POST request with automatic timeout and signal handling
     */
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
            "f.sid": cred?.sid || generateFallbackSid(),
            _reqid: nextReqid(),
            rt: "c"
        });

        const body = new URLSearchParams();
        body.append("f.req", fReq);
        if (cred?.at) body.append("at", cred.at);

        let controller: AbortController | null = null;
        let timeoutId: any = null;

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
                signal: signal || (controller ? controller.signal : undefined)
            });
            return resp;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }
    }

export {
    GEMINI_API_URL,
    getProtocol,
    getUtils,
    getParser,
    getApiUrl,
    nextReqid,
    generateFallbackSid,
    postBatchexecute
};

export const GeminiClientRpcClient: GeminiClientRpcClientModule = {
    GEMINI_API_URL,
    getProtocol,
    getUtils,
    getParser,
    getApiUrl,
    nextReqid,
    generateFallbackSid,
    postBatchexecute
};

if (typeof globalThis !== 'undefined') (globalThis as any).GeminiClientRpcClient = GeminiClientRpcClient;
if (typeof module === 'object' && module.exports) module.exports = GeminiClientRpcClient;

export default GeminiClientRpcClient;

