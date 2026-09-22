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
import ChatGPTClient from "../core/provider/chatgpt/client.js";
import { captureChatGPTInventory } from "../core/provider/chatgpt/inventory.js";
import { captureChatGPTAccountInventory } from "../core/provider/chatgpt/accountInventory.js";
import { normalizeChatGPTConversation } from "../core/provider/chatgpt/graph.js";

let session: ChatGPTSession | null = null;
let transport: ChatGPTTransport | null = null;
const workspaceIds = new Map<string, string>();
const MAX_DETAIL_MESSAGE_BYTES = 16 * 1024 * 1024;

function assertDetailMessageSize(raw: any): void {
    let encodedBytes = 0;
    try {
        encodedBytes = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
    } catch {
        const error: any = new Error("ChatGPT conversation detail could not be serialized safely");
        error.code = "DETAIL_SERIALIZATION_FAILED";
        throw error;
    }
    if (encodedBytes > MAX_DETAIL_MESSAGE_BYTES) {
        const error: any = new Error(
            `ChatGPT conversation detail is too large for the current extension message bridge (${encodedBytes} bytes > ${MAX_DETAIL_MESSAGE_BYTES})`
        );
        error.code = "DETAIL_TOO_LARGE_FOR_MESSAGE";
        throw error;
    }
}

async function ensureTransport(forceRefresh = false): Promise<ChatGPTTransport> {
    if (!transport || !session || forceRefresh) {
        session = await acquireChatGPTSession();
        transport = new ChatGPTTransport(session);
        workspaceIds.clear();
    }
    return transport;
}

async function discoverWorkspaces(): Promise<ReturnType<typeof parseChatGPTWorkspaces> extends Promise<infer T> ? T : never> {
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
    return workspaces;
}

async function resolveWorkspaceAccountId(workspaceKey: string): Promise<string> {
    let accountId = workspaceIds.get(workspaceKey);
    if (!accountId) {
        await discoverWorkspaces();
        accountId = workspaceIds.get(workspaceKey);
    }
    if (!accountId) {
        throw new Error("Unknown ChatGPT workspace key");
    }
    return accountId;
}

function safeError(error: any): { ok: false; code: string; error: string; status?: number } {
    return {
        ok: false,
        code: typeof error?.code === "string" ? error.code : "CHATGPT_BRIDGE_ERROR",
        error: typeof error?.message === "string" ? error.message : "ChatGPT bridge error",
        status: typeof error?.status === "number" ? error.status : undefined
    };
}

const BRIDGE_SENTINEL = "__AI_EXPORTER_CHATGPT_BRIDGE_V1__";
const bridgeGlobal = globalThis as any;

if (!bridgeGlobal[BRIDGE_SENTINEL] && typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    bridgeGlobal[BRIDGE_SENTINEL] = true;
    chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
        if (sender.id && sender.id !== chrome.runtime.id) return false;

        const action = message?.action;
        if (![
            "chatgptPing",
            "chatgptReadiness",
            "chatgptDiscoverWorkspaces",
            "chatgptConversationInventory",
            "chatgptConversationDetail",
            "chatgptAccountInventory",
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
                    const workspaces = await discoverWorkspaces();
                    return {
                        ok: true,
                        provider: "chatgpt",
                        workspaces: workspaces.map(publicWorkspace)
                    };
                }
                if (action === "chatgptConversationInventory") {
                    const workspaceKey = typeof message?.workspaceKey === "string" ? message.workspaceKey : "";
                    if (!workspaceKey) {
                        return { ok: false, code: "WORKSPACE_REQUIRED", error: "ChatGPT workspace key is required" };
                    }
                    const workspaceId = await resolveWorkspaceAccountId(workspaceKey);
                    let client = new ChatGPTClient(await ensureTransport());
                    try {
                        const inventory = await captureChatGPTInventory(client, workspaceId, workspaceKey, {
                            pageSize: 100,
                            maxPages: 10_000
                        });
                        return {
                            ok: true,
                            provider: "chatgpt",
                            inventory
                        };
                    } catch (error: any) {
                        if (error instanceof ChatGPTTransportError && error.code === "AUTH_REQUIRED") {
                            client = new ChatGPTClient(await ensureTransport(true));
                            const refreshedWorkspaceId = await resolveWorkspaceAccountId(workspaceKey);
                            const inventory = await captureChatGPTInventory(client, refreshedWorkspaceId, workspaceKey, {
                                pageSize: 100,
                                maxPages: 10_000
                            });
                            return {
                                ok: true,
                                provider: "chatgpt",
                                inventory
                            };
                        }
                        throw error;
                    }
                }
                if (action === "chatgptConversationDetail") {
                    const workspaceKey = typeof message?.workspaceKey === "string" ? message.workspaceKey : "";
                    const conversationId = typeof message?.conversationId === "string" ? message.conversationId : "";
                    if (!workspaceKey) {
                        return { ok: false, code: "WORKSPACE_REQUIRED", error: "ChatGPT workspace key is required" };
                    }
                    if (!conversationId) {
                        return { ok: false, code: "CONVERSATION_REQUIRED", error: "ChatGPT conversation id is required" };
                    }

                    const fetchAndNormalize = async (forceRefresh = false) => {
                        if (forceRefresh) await ensureTransport(true);
                        const workspaceId = await resolveWorkspaceAccountId(workspaceKey);
                        const client = new ChatGPTClient(await ensureTransport());
                        const raw = await client.conversationDetail(conversationId, workspaceId);
                        assertDetailMessageSize(raw);
                        return normalizeChatGPTConversation(raw, conversationId, workspaceKey);
                    };

                    try {
                        const detail = await fetchAndNormalize(false);
                        return {
                            ok: true,
                            provider: "chatgpt",
                            detail
                        };
                    } catch (error: any) {
                        if (error instanceof ChatGPTTransportError && error.code === "AUTH_REQUIRED") {
                            const detail = await fetchAndNormalize(true);
                            return {
                                ok: true,
                                provider: "chatgpt",
                                detail
                            };
                        }
                        throw error;
                    }
                }
                if (action === "chatgptAccountInventory") {
                    const workspaceKey = typeof message?.workspaceKey === "string" ? message.workspaceKey : "";
                    if (!workspaceKey) {
                        return { ok: false, code: "WORKSPACE_REQUIRED", error: "ChatGPT workspace key is required" };
                    }
                    const workspaceId = await resolveWorkspaceAccountId(workspaceKey);
                    let client = new ChatGPTClient(await ensureTransport());
                    try {
                        const inventory = await captureChatGPTAccountInventory(client, workspaceId, workspaceKey, {
                            maxPages: 10_000
                        });
                        return {
                            ok: true,
                            provider: "chatgpt",
                            inventory
                        };
                    } catch (error: any) {
                        if (error instanceof ChatGPTTransportError && error.code === "AUTH_REQUIRED") {
                            client = new ChatGPTClient(await ensureTransport(true));
                            const refreshedWorkspaceId = await resolveWorkspaceAccountId(workspaceKey);
                            const inventory = await captureChatGPTAccountInventory(client, refreshedWorkspaceId, workspaceKey, {
                                maxPages: 10_000
                            });
                            return {
                                ok: true,
                                provider: "chatgpt",
                                inventory
                            };
                        }
                        throw error;
                    }
                }
                return { ok: false, code: "UNKNOWN_ACTION", error: "Unknown ChatGPT bridge action" };
            } catch (error: any) {
                return safeError(error);
            }
        })().then(sendResponse);

        return true;
    });
}
