/**
 * Strict, read-only ChatGPT web transport.
 *
 * This is intentionally NOT an arbitrary fetch proxy. Every relative path must
 * match the exporter allowlist before a request can leave the page.
 */
import type { ChatGPTSession, FetchLike } from "./auth.js";

export class ChatGPTTransportError extends Error {
    readonly code: string;
    readonly status?: number;

    constructor(code: string, message: string, status?: number) {
        super(message);
        this.name = "ChatGPTTransportError";
        this.code = code;
        this.status = status;
    }
}

export interface ChatGPTTransportOptions {
    fetchImpl?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    maxRetries?: number;
    maxJsonBytes?: number;
}

const ORIGIN = "https://chatgpt.com";
const DEFAULT_MAX_JSON_BYTES = 25 * 1024 * 1024;

const READ_ONLY_ALLOWLIST: RegExp[] = [
    /^\/backend-api\/accounts\/check\/v4-2023-04-27$/,
    /^\/backend-api\/conversations(?:\?.*)?$/,
    /^\/backend-api\/gizmos\/snorlax\/sidebar(?:\?.*)?$/,
    /^\/backend-api\/gizmos\/[A-Za-z0-9_-]+\/conversations(?:\?.*)?$/,
    /^\/backend-api\/conversation\/[A-Za-z0-9_-]+$/,
    /^\/backend-api\/shared_conversations(?:\?.*)?$/,
    /^\/backend-api\/share\/[A-Za-z0-9_-]+$/,
    /^\/backend-api\/memories(?:\?.*)?$/,
    /^\/backend-api\/user_system_messages(?:\?.*)?$/,
    /^\/backend-api\/settings(?:\?.*)?$/,
    /^\/backend-api\/settings\/beta_features(?:\?.*)?$/,
    /^\/backend-api\/files\/download\/[A-Za-z0-9_-]+(?:\?.*)?$/,
    /^\/backend-api\/files\/[A-Za-z0-9_-]+\/download(?:\?.*)?$/,
    /^\/public-api\/gizmos\/discovery\/mine(?:\?.*)?$/
];

export function validateChatGPTReadPath(path: string): string {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
        throw new ChatGPTTransportError("PATH_REJECTED", "ChatGPT request path must be relative to chatgpt.com.");
    }
    if (path.includes("\\") || /%2e/i.test(path)) {
        throw new ChatGPTTransportError("PATH_REJECTED", "ChatGPT request path contains unsafe traversal syntax.");
    }

    let url: URL;
    try {
        url = new URL(path, ORIGIN);
    } catch {
        throw new ChatGPTTransportError("PATH_REJECTED", "ChatGPT request path is invalid.");
    }
    if (url.origin !== ORIGIN) {
        throw new ChatGPTTransportError("PATH_REJECTED", "ChatGPT request escaped the allowed origin.");
    }
    if (url.pathname.split("/").some(segment => segment === "." || segment === "..")) {
        throw new ChatGPTTransportError("PATH_REJECTED", "ChatGPT request path contains traversal segments.");
    }

    const normalized = url.pathname + url.search;
    if (!READ_ONLY_ALLOWLIST.some(rule => rule.test(normalized))) {
        throw new ChatGPTTransportError("PATH_NOT_ALLOWLISTED", "ChatGPT request path is outside the read-only exporter allowlist.");
    }
    return normalized;
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfter(value: string | null): number | null {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(value);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
    return null;
}

export class ChatGPTTransport {
    private readonly token: string;
    private readonly fetchImpl: FetchLike;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly random: () => number;
    private readonly maxRetries: number;
    private readonly maxJsonBytes: number;
    private cooldownUntil = 0;

    constructor(session: ChatGPTSession, options: ChatGPTTransportOptions = {}) {
        if (!session?.accessToken) throw new ChatGPTTransportError("AUTH_REQUIRED", "Missing ChatGPT access token.");
        this.token = session.accessToken;
        this.fetchImpl = options.fetchImpl || fetch;
        this.sleep = options.sleep || defaultSleep;
        this.random = options.random || Math.random;
        this.maxRetries = Math.max(0, Math.min(options.maxRetries ?? 4, 8));
        this.maxJsonBytes = Math.max(1024, options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES);
    }

    async requestJson(path: string, workspaceId?: string | null): Promise<any> {
        const normalizedPath = validateChatGPTReadPath(path);
        const url = ORIGIN + normalizedPath;

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            const now = Date.now();
            if (this.cooldownUntil > now) {
                await this.sleep(this.cooldownUntil - now);
            }

            let response: Response;
            try {
                const headers: Record<string, string> = {
                    Accept: "application/json",
                    Authorization: `Bearer ${this.token}`,
                    "X-Authorization": `Bearer ${this.token}`
                };
                if (workspaceId) headers["ChatGPT-Account-Id"] = workspaceId;

                response = await this.fetchImpl(url, {
                    method: "GET",
                    credentials: "include",
                    cache: "no-store",
                    redirect: "error",
                    headers
                });
            } catch (error: any) {
                if (attempt >= this.maxRetries) {
                    throw new ChatGPTTransportError(
                        "NETWORK_ERROR",
                        `ChatGPT request failed after bounded retries: ${error?.message || "network error"}`
                    );
                }
                await this.sleep(this.backoffMs(attempt, 1000, 30_000));
                continue;
            }

            if (response.status === 401) {
                throw new ChatGPTTransportError("AUTH_REQUIRED", "ChatGPT authentication expired.", 401);
            }
            if (response.status === 403) {
                throw new ChatGPTTransportError("ACCESS_DENIED", "ChatGPT denied the read-only exporter request.", 403);
            }
            if (response.status === 429) {
                if (attempt >= this.maxRetries) {
                    throw new ChatGPTTransportError("RATE_LIMIT_EXHAUSTED", "ChatGPT rate limit persisted after bounded retries.", 429);
                }
                const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
                const delay = Math.min(120_000, retryAfter ?? this.backoffMs(attempt, 2_000, 60_000));
                this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay);
                continue;
            }
            if ([408, 425, 500, 502, 503, 504].includes(response.status)) {
                if (attempt >= this.maxRetries) {
                    throw new ChatGPTTransportError("TRANSIENT_EXHAUSTED", `ChatGPT returned HTTP ${response.status} after bounded retries.`, response.status);
                }
                await this.sleep(this.backoffMs(attempt, 1000, 30_000));
                continue;
            }
            if (!response.ok) {
                throw new ChatGPTTransportError("HTTP_ERROR", `ChatGPT returned HTTP ${response.status}.`, response.status);
            }

            const declared = response.headers.get("content-length");
            if (declared && /^\d+$/.test(declared) && Number(declared) > this.maxJsonBytes) {
                throw new ChatGPTTransportError("RESPONSE_TOO_LARGE", "ChatGPT JSON response exceeded the configured safety limit.");
            }

            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > this.maxJsonBytes) {
                throw new ChatGPTTransportError("RESPONSE_TOO_LARGE", "ChatGPT JSON response exceeded the configured safety limit.");
            }

            try {
                return JSON.parse(new TextDecoder().decode(bytes));
            } catch {
                throw new ChatGPTTransportError("CONTRACT_DRIFT", "ChatGPT returned an incompatible non-JSON response.");
            }
        }

        throw new ChatGPTTransportError("UNREACHABLE", "ChatGPT request terminated unexpectedly.");
    }

    private backoffMs(attempt: number, base: number, cap: number): number {
        const exp = Math.min(cap, base * (2 ** attempt));
        return Math.min(cap, Math.round(exp + this.random() * Math.min(1000, base)));
    }
}
