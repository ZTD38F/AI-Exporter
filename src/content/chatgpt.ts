/**
 * Dormant ChatGPT same-origin bridge.
 *
 * This bundle is packaged now but is NOT statically injected. A later UI step
 * will request optional ChatGPT + scripting permissions from a user gesture and
 * inject/register this bundle. Keeping auth and transport here means the bearer
 * token never needs to leave the authenticated chatgpt.com content-script context.
 */
import { acquireChatGPTSession, safeSessionSummary, type ChatGPTSession } from "../core/provider/chatgpt/auth.js";
import { ChatGPTTransport, ChatGPTTransportError } from "../core/provider/chatgpt/transport.js";
import { parseChatGPTWorkspaces, publicWorkspace } from "../core/provider/chatgpt/workspaces.js";

let session: ChatGPTSession | null = null;
let transport: ChatGPTTransport | null = null;
const workspaceIds = new Map<string, string>();

async function ensureTransport(forceRefresh = false): Promise<ChatGPTTransport> {
    if (!transport || !session || forceRefresh) {
        session = await acquireChatGPTSession();
        transport = new ChatGPTTransport(session);
        workspaceIds.clear();
    }
    return transport;
}

function safeError(error: any): { ok: false; code: string; error: string; status?: number } {
    return {
        ok: false,
        code: typeof error?.code === "string" ? error.code : "CHATGPT_BRIDGE_ERROR",
        error: typeof error?.message === "string" ? error.message : "ChatGPT bridge error",
        status: typeof error?.status === "number" ? error.status : undefined
    };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
        if (sender.id && sender.id !== chrome.runtime.id) return false;

        const action = message?.action;
        if (![
            "chatgptPing",
            "chatgptReadiness",
            "chatgptDiscoverWorkspaces",
            "chatgptResetSession"
        ].includes(action)) {
            return false;
        }

        (async () => {
            try {
                if (action === "chatgptPing") {
                    return { ok: true, provider: "chatgpt" };
                }
                if (action === "chatgptResetSession") {
                    session = null;
                    transport = null;
                    workspaceIds.clear();
                    return { ok: true };
                }
                if (action === "chatgptReadiness") {
                    await ensureTransport(true);
                    return {
                        ok: true,
                        provider: "chatgpt",
                        session: safeSessionSummary(session!)
                    };
                }
                if (action === "chatgptDiscoverWorkspaces") {
                    const client = await ensureTransport();
                    let raw: any;
                    try {
                        raw = await client.requestJson("/backend-api/accounts/check/v4-2023-04-27");
                    } catch (error: any) {
                        if (error instanceof ChatGPTTransportError && error.code === "AUTH_REQUIRED") {
                            const refreshed = await ensureTransport(true);
                            raw = await refreshed.requestJson("/backend-api/accounts/check/v4-2023-04-27");
                        } else {
                            throw error;
                        }
                    }
                    const workspaces = await parseChatGPTWorkspaces(raw);
                    workspaceIds.clear();
                    for (const workspace of workspaces) workspaceIds.set(workspace.key, workspace.accountId);
                    return {
                        ok: true,
                        provider: "chatgpt",
                        workspaces: workspaces.map(publicWorkspace)
                    };
                }
                return { ok: false, code: "UNKNOWN_ACTION", error: "Unknown ChatGPT bridge action" };
            } catch (error: any) {
                return safeError(error);
            }
        })().then(sendResponse);

        return true;
    });
}
