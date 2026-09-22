import { ChatGPTTransportError } from "./transport.js";

export interface ChatGPTWorkspace {
    key: string;
    accountId: string;
    name: string;
    raw: any;
}

async function sha256Hex(value: string): Promise<string> {
    if (!globalThis.crypto?.subtle) {
        throw new ChatGPTTransportError("CRYPTO_UNAVAILABLE", "Web Crypto is required for workspace isolation.");
    }
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function workspaceKey(accountId: string): Promise<string> {
    const digest = await sha256Hex(`chatgpt-web-workspace-v1\0${accountId}`);
    return `chatgpt-${digest.slice(0, 32)}`;
}

export async function parseChatGPTWorkspaces(raw: any): Promise<ChatGPTWorkspace[]> {
    const accounts = raw && typeof raw === "object" ? raw.accounts : null;
    const values: any[] = Array.isArray(accounts)
        ? accounts
        : accounts && typeof accounts === "object"
            ? Object.values(accounts)
            : [];

    const result: ChatGPTWorkspace[] = [];
    const seen = new Set<string>();

    for (const item of values) {
        if (!item || typeof item !== "object" || item.is_deactivated === true) continue;
        const account = item.account && typeof item.account === "object" ? item.account : item;
        const accountId = typeof account.account_id === "string" ? account.account_id : "";
        if (!accountId || seen.has(accountId)) continue;
        seen.add(accountId);

        result.push({
            key: await workspaceKey(accountId),
            accountId,
            name: typeof account.account_name === "string" && account.account_name.trim()
                ? account.account_name.trim()
                : accountId,
            raw: item
        });
    }

    if (!result.length) {
        throw new ChatGPTTransportError(
            "WORKSPACE_CONTRACT_DRIFT",
            "ChatGPT account discovery returned no active workspaces; refusing to guess a workspace scope."
        );
    }

    return result.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

export function publicWorkspace(workspace: ChatGPTWorkspace): Record<string, unknown> {
    return {
        key: workspace.key,
        name: workspace.name
    };
}
