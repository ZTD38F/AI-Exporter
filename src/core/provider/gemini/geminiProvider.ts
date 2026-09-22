import type {
    AIProvider,
    ProviderCapabilities,
    ProviderConversationDetail,
    ProviderConversationItem,
    ProviderPageResult,
    ProviderReadiness
} from "../aiProvider.js";
import { ProviderRegistry } from "../providerRegistry.js";
import { GeminiAPIClient } from "../../api/geminiClient.js";
import GeminiClientCredentialManager from "../../api/client/credentialManager.js";

export class GeminiProvider implements AIProvider {
    readonly id = "gemini";
    readonly name = "Google Gemini";
    readonly hostPatterns = ["https://gemini.google.com/*"] as const;

    readonly capabilities: ProviderCapabilities = {
        realtimeObservation: true,
        officialImport: true,
        thoughtBlocks: true,
        incrementalSync: true,
        multiAccount: true,
        workspaces: false,
        collections: false,
        sharedItems: false,
        accountArtifacts: false,
        assets: true
    };

    private client: GeminiAPIClient | null;

    constructor(client?: GeminiAPIClient) {
        this.client = client ?? null;
    }

    private getClient(): GeminiAPIClient {
        if (!this.client) this.client = new GeminiAPIClient();
        return this.client;
    }

    matchesUrl(url: string): boolean {
        try {
            return new URL(url).hostname === "gemini.google.com";
        } catch {
            return false;
        }
    }

    async checkReadiness(context?: any): Promise<ProviderReadiness> {
        const slot = context?.accountSlot || "u0";
        try {
            const cred = await GeminiClientCredentialManager.resolveCred(slot);
            if (cred?.at) {
                return {
                    ready: true,
                    scopeKey: slot,
                    accountName: slot
                };
            }
            return {
                ready: false,
                scopeKey: slot,
                error: "Gemini credentials are not available; open or refresh gemini.google.com."
            };
        } catch (error: any) {
            return {
                ready: false,
                scopeKey: slot,
                error: error?.message || "Gemini credential resolution failed."
            };
        }
    }

    async listConversations(options?: any): Promise<ProviderPageResult<ProviderConversationItem>> {
        const slot = options?.accountSlot || options?.slot || "u0";
        const result = await this.getClient().getAllConversations(
            options?.maxPages ?? 2000,
            options?.onProgress,
            slot,
            options
        );

        const items: ProviderConversationItem[] = result.conversations.map((item: any) => ({
            ...item,
            providerId: this.id,
            scopeKey: slot,
            id: item.id,
            title: item.title
        }));

        return {
            items,
            total: result.total,
            hasMore: !!result.stoppedEarly,
            nextCursor: null,
            stoppedEarly: !!result.stoppedEarly,
            diagnostics: {
                ...(result.diagnostics || {}),
                hitGoogleLimit: result.hitGoogleLimit
            }
        };
    }

    async fetchConversationDetail(conversationId: string, options?: any): Promise<ProviderConversationDetail> {
        const slot = options?.accountSlot || options?.slot || "u0";
        const detail: any = await this.getClient().getConversationDetail(conversationId, slot);

        return {
            ...detail,
            providerId: this.id,
            scopeKey: slot,
            id: detail.id,
            title: detail.title,
            messages: detail.messages || [],
            raw: detail._raw
        };
    }
}

export const defaultGeminiProvider = new GeminiProvider();

if (!ProviderRegistry.get(defaultGeminiProvider.id)) {
    ProviderRegistry.register(defaultGeminiProvider);
}
ProviderRegistry.setDefaultProviderId(defaultGeminiProvider.id);

export default GeminiProvider;
