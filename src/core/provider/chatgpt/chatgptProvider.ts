import type {
    AIProvider,
    ProviderCapabilities,
    ProviderConversationDetail,
    ProviderConversationItem,
    ProviderMembership,
    ProviderPageResult,
    ProviderReadiness
} from "../aiProvider.js";
import { ProviderRegistry } from "../providerRegistry.js";
import { getAITab, sendToAITab } from "../../utils/tabService.js";

const CHATGPT_PROVIDER_ID = "chatgpt";
const LIST_TIMEOUT_MS = 5 * 60 * 1000;
const DETAIL_TIMEOUT_MS = 90 * 1000;
const READINESS_TIMEOUT_MS = 15 * 1000;

function requireWorkspaceKey(options?: any): string {
    const workspaceKey = typeof options?.workspaceKey === "string" ? options.workspaceKey.trim() : "";
    if (!workspaceKey) {
        throw new Error("ChatGPT workspaceKey is required");
    }
    return workspaceKey;
}

function timestampMs(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
    }
    if (typeof value === "string" && value.trim()) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            return numeric < 1_000_000_000_000 ? Math.round(numeric * 1000) : Math.round(numeric);
        }
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function remoteVersionMarker(item: any): string | null {
    for (const key of ["update_time", "updated_at", "create_time", "created_at"]) {
        const value = item?.[key];
        if (value !== null && value !== undefined && String(value).trim()) {
            return String(value);
        }
    }
    return null;
}

function mapMemberships(value: any): ProviderMembership[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter(item => item && typeof item === "object" && typeof item.scope === "string")
        .map(item => ({
            ...item,
            scope: item.scope,
            collectionId:
                typeof item.projectId === "string"
                    ? item.projectId
                    : typeof item.shareId === "string"
                        ? item.shareId
                        : undefined,
            collectionName: typeof item.projectName === "string" ? item.projectName : undefined
        }));
}

function mapInventoryItem(
    item: any,
    memberships: any,
    workspaceKey: string
): ProviderConversationItem {
    const id = typeof item?.id === "string" && item.id
        ? item.id
        : typeof item?.conversation_id === "string" && item.conversation_id
            ? item.conversation_id
            : "";

    if (!id) throw new Error("ChatGPT inventory item is missing a conversation id");

    const title = typeof item?.title === "string" && item.title.trim()
        ? item.title.trim()
        : "Untitled ChatGPT Conversation";

    return {
        ...item,
        providerId: CHATGPT_PROVIDER_ID,
        scopeKey: workspaceKey,
        id,
        title,
        url: `https://chatgpt.com/c/${id}`,
        createdAt: timestampMs(item?.create_time ?? item?.created_at),
        updatedAt: timestampMs(item?.update_time ?? item?.updated_at),
        remoteVersionMarker: remoteVersionMarker(item),
        memberships: mapMemberships(memberships)
    };
}

function bridgeError(response: any, fallback: string): Error {
    const message = typeof response?.error === "string" && response.error ? response.error : fallback;
    const error: any = new Error(message);
    if (typeof response?.code === "string") error.code = response.code;
    if (typeof response?.status === "number") error.status = response.status;
    return error;
}

export class ChatGPTProvider implements AIProvider {
    readonly id = CHATGPT_PROVIDER_ID;
    readonly name = "ChatGPT";
    readonly hostPatterns = ["https://chatgpt.com/*"] as const;

    readonly capabilities: ProviderCapabilities = {
        realtimeObservation: false,
        officialImport: false,
        thoughtBlocks: true,
        incrementalSync: false,
        multiAccount: true,
        workspaces: true,
        collections: true,
        sharedItems: true,
        accountArtifacts: true,
        // Resolver/discovery is implemented, but binary signed-CDN capture is
        // intentionally not advertised until browser/CORS live staging proves it.
        assets: false
    };

    matchesUrl(url: string): boolean {
        try {
            return new URL(url).hostname === "chatgpt.com";
        } catch {
            return false;
        }
    }

    async checkReadiness(_context?: any): Promise<ProviderReadiness> {
        try {
            const tab = await getAITab(this.id);
            if (!tab) {
                return {
                    ready: false,
                    error: "Open chatgpt.com after enabling ChatGPT access in AI Exporter."
                };
            }

            const response = await sendToAITab(
                this.id,
                { action: "chatgptReadiness" },
                undefined,
                READINESS_TIMEOUT_MS
            );

            if (!response?.ok) {
                return {
                    ready: false,
                    error: typeof response?.error === "string"
                        ? response.error
                        : "ChatGPT bridge is not ready.",
                    diagnostics: {
                        code: response?.code,
                        status: response?.status
                    }
                };
            }

            return {
                ready: true,
                accountName:
                    typeof response?.session?.user?.email === "string"
                        ? response.session.user.email
                        : typeof response?.session?.user?.name === "string"
                            ? response.session.user.name
                            : "ChatGPT"
            };
        } catch (error: any) {
            return {
                ready: false,
                error: error?.message || "ChatGPT is not ready.",
                diagnostics: {
                    code: error?.code,
                    status: error?.status
                }
            };
        }
    }

    async discoverWorkspaces(): Promise<Array<{ key: string; name: string }>> {
        const response = await sendToAITab(
            this.id,
            { action: "chatgptDiscoverWorkspaces" },
            undefined,
            READINESS_TIMEOUT_MS
        );
        if (!response?.ok) throw bridgeError(response, "ChatGPT workspace discovery failed");
        if (!Array.isArray(response.workspaces)) {
            throw new Error("ChatGPT workspace response is incompatible");
        }
        return response.workspaces
            .filter((item: any) =>
                item
                && typeof item.key === "string"
                && typeof item.name === "string"
            )
            .map((item: any) => ({ key: item.key, name: item.name }));
    }

    async getAccountInventory(workspaceKey: string): Promise<any> {
        if (!workspaceKey) throw new Error("ChatGPT workspaceKey is required");
        const response = await sendToAITab(
            this.id,
            {
                action: "chatgptAccountInventory",
                workspaceKey
            },
            undefined,
            LIST_TIMEOUT_MS
        );
        if (!response?.ok) throw bridgeError(response, "ChatGPT account inventory failed");
        return response.inventory;
    }

    async listConversations(options?: any): Promise<ProviderPageResult<ProviderConversationItem>> {
        const workspaceKey = requireWorkspaceKey(options);
        const response = await sendToAITab(
            this.id,
            {
                action: "chatgptConversationInventory",
                workspaceKey
            },
            undefined,
            LIST_TIMEOUT_MS
        );
        if (!response?.ok) throw bridgeError(response, "ChatGPT conversation inventory failed");

        const inventory = response.inventory;
        if (!inventory || typeof inventory !== "object" || !inventory.listings || typeof inventory.listings !== "object") {
            throw new Error("ChatGPT conversation inventory response is incompatible");
        }

        const memberships = inventory.memberships && typeof inventory.memberships === "object"
            ? inventory.memberships
            : {};
        const items = Object.values(inventory.listings).map((item: any) => {
            const id = typeof item?.id === "string"
                ? item.id
                : typeof item?.conversation_id === "string"
                    ? item.conversation_id
                    : "";
            return mapInventoryItem(item, memberships[id], workspaceKey);
        });

        const complete = inventory.conversationInventoryComplete === true;

        return {
            items,
            total: items.length,
            hasMore: !complete,
            nextCursor: null,
            stoppedEarly: !complete,
            diagnostics: {
                provider: this.id,
                workspaceKey,
                complete,
                evidence: Array.isArray(inventory.evidence) ? inventory.evidence : [],
                errors: Array.isArray(inventory.errors) ? inventory.errors : [],
                projects: inventory.projects && typeof inventory.projects === "object"
                    ? Object.keys(inventory.projects).length
                    : 0,
                shares: inventory.shares && typeof inventory.shares === "object"
                    ? Object.keys(inventory.shares).length
                    : 0
            }
        };
    }

    async fetchConversationDetail(
        conversationId: string,
        options?: any
    ): Promise<ProviderConversationDetail> {
        if (typeof conversationId !== "string" || !conversationId.trim()) {
            throw new Error("ChatGPT conversation id is required");
        }
        const workspaceKey = requireWorkspaceKey(options);

        const response = await sendToAITab(
            this.id,
            {
                action: "chatgptConversationDetail",
                workspaceKey,
                conversationId
            },
            undefined,
            DETAIL_TIMEOUT_MS
        );
        if (!response?.ok) throw bridgeError(response, "ChatGPT conversation detail failed");

        const detail = response.detail;
        if (
            !detail
            || typeof detail !== "object"
            || detail.providerId !== this.id
            || detail.scopeKey !== workspaceKey
            || typeof detail.id !== "string"
            || !Array.isArray(detail.messages)
        ) {
            throw new Error("ChatGPT conversation detail response is incompatible");
        }
        return detail as ProviderConversationDetail;
    }
}

export const defaultChatGPTProvider = new ChatGPTProvider();
if (!ProviderRegistry.get(defaultChatGPTProvider.id)) {
    ProviderRegistry.register(defaultChatGPTProvider);
}

export default ChatGPTProvider;
