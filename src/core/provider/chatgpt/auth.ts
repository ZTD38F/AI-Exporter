/**
 * ChatGPT browser-session bootstrap.
 *
 * Security invariant: callers must keep the returned bearer token in memory only.
 * Never persist it in chrome.storage.local, IndexedDB, logs, exports or fixtures.
 */
export interface ChatGPTSession {
    accessToken: string;
    expires?: string;
    user?: {
        id?: string;
        email?: string;
        name?: string;
        image?: string;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export class ChatGPTAuthError extends Error {
    readonly code: string;
    readonly status?: number;

    constructor(code: string, message: string, status?: number) {
        super(message);
        this.name = "ChatGPTAuthError";
        this.code = code;
        this.status = status;
    }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function acquireChatGPTSession(fetchImpl: FetchLike = fetch): Promise<ChatGPTSession> {
    let response: Response;
    try {
        response = await fetchImpl("https://chatgpt.com/api/auth/session", {
            method: "GET",
            credentials: "include",
            cache: "no-store",
            redirect: "error",
            headers: {
                Accept: "application/json"
            }
        });
    } catch (error: any) {
        throw new ChatGPTAuthError(
            "SESSION_NETWORK_ERROR",
            `Unable to read the authenticated ChatGPT session: ${error?.message || "network error"}`
        );
    }

    if (response.status === 401 || response.status === 403) {
        throw new ChatGPTAuthError(
            "AUTH_REQUIRED",
            "ChatGPT session is not authenticated. Sign in to chatgpt.com and retry.",
            response.status
        );
    }
    if (!response.ok) {
        throw new ChatGPTAuthError(
            "SESSION_HTTP_ERROR",
            `ChatGPT session endpoint returned HTTP ${response.status}`,
            response.status
        );
    }

    let value: any;
    try {
        value = await response.json();
    } catch {
        throw new ChatGPTAuthError("SESSION_CONTRACT_DRIFT", "ChatGPT session endpoint did not return JSON.");
    }

    const token = value?.accessToken;
    if (typeof token !== "string" || token.length < 20) {
        throw new ChatGPTAuthError(
            "AUTH_REQUIRED",
            "ChatGPT session JSON did not contain a usable access token."
        );
    }

    return value as ChatGPTSession;
}

export function safeSessionSummary(session: ChatGPTSession): Record<string, unknown> {
    return {
        authenticated: true,
        expires: typeof session.expires === "string" ? session.expires : undefined,
        user: session.user ? {
            email: typeof session.user.email === "string" ? session.user.email : undefined,
            name: typeof session.user.name === "string" ? session.user.name : undefined
        } : undefined
    };
}
