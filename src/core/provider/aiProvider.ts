/**
 * Provider-neutral contracts for AI Exporter.
 *
 * This layer deliberately contains no DOM, Chrome API, or provider-specific wire
 * assumptions. Provider adapters translate their native APIs into these shapes.
 */
import type { ChatMessage } from "../../types/conversation.js";

export type ProviderId = string;

export interface ProviderConversationItem {
    providerId: ProviderId;
    scopeKey: string;
    id: string;
    title: string;
    url?: string;
    createdAt?: number | string | null;
    updatedAt?: number | string | null;
    remoteVersionMarker?: string | null;
    memberships?: ProviderMembership[];
    [key: string]: any;
}

export interface ProviderConversationDetail {
    providerId: ProviderId;
    scopeKey: string;
    id: string;
    title: string;
    messages: ChatMessage[];
    url?: string;
    createdAt?: number | string | null;
    updatedAt?: number | string | null;
    raw?: unknown;
    integrity?: ProviderObjectIntegrity;
    [key: string]: any;
}

export interface ProviderMembership {
    scope: string;
    collectionId?: string;
    collectionName?: string;
    [key: string]: any;
}

export interface ProviderPageDiagnostics {
    pagesFetched?: number;
    termination?: "complete" | "stopped_early" | "cycle" | "safety_limit" | "error";
    error?: string;
    [key: string]: any;
}

export interface ProviderPageResult<T> {
    items: T[];
    total?: number;
    hasMore?: boolean;
    nextCursor?: string | null;
    stoppedEarly?: boolean;
    diagnostics?: ProviderPageDiagnostics | any;
}

export interface ProviderCapabilities {
    realtimeObservation: boolean;
    officialImport: boolean;
    thoughtBlocks: boolean;
    incrementalSync: boolean;
    multiAccount: boolean;
    workspaces: boolean;
    collections: boolean;
    sharedItems: boolean;
    accountArtifacts: boolean;
    assets: boolean;
}

export interface ProviderReadiness {
    ready: boolean;
    scopeKey?: string;
    accountName?: string;
    error?: string;
    diagnostics?: Record<string, unknown>;
}

export type ProviderObjectState =
    | "DISCOVERED"
    | "FETCHED"
    | "RAW_VERIFIED"
    | "NORMALIZED"
    | "ASSETS_VERIFIED"
    | "VERIFIED"
    | "PARTIAL"
    | "FAILED"
    | "AUTH_REQUIRED";

export interface ProviderObjectIntegrity {
    state: ProviderObjectState;
    complete: boolean;
    rawSha256?: string;
    expectedAssets?: number;
    verifiedAssets?: number;
    reasons?: string[];
    diagnostics?: Record<string, unknown>;
}

export interface AIProvider {
    readonly id: ProviderId;
    readonly name: string;
    readonly hostPatterns: readonly string[];
    readonly capabilities: ProviderCapabilities;

    matchesUrl(url: string): boolean;
    checkReadiness(context?: any): Promise<ProviderReadiness>;
    listConversations(options?: any): Promise<ProviderPageResult<ProviderConversationItem>>;
    fetchConversationDetail(conversationId: string, options?: any): Promise<ProviderConversationDetail>;
}
