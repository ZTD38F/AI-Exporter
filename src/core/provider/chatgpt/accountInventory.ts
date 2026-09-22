import ChatGPTClient from "./client.js";
import { cursorChain, type InventoryOptions, type PaginationEvidence } from "./inventory.js";
import { ChatGPTTransportError } from "./transport.js";

export type ChatGPTAccountArtifactKind =
    | "memories"
    | "custom_instructions"
    | "settings"
    | "beta_features";

export interface ChatGPTAccountInventoryResult {
    schemaVersion: 1;
    providerId: "chatgpt";
    workspaceKey: string;
    accountInventoryComplete: boolean;
    artifacts: Partial<Record<ChatGPTAccountArtifactKind, any>>;
    customGpts: any[];
    evidence: PaginationEvidence[];
    errors: Array<{
        scope: string;
        code: string;
        message: string;
    }>;
}

const ACCOUNT_ARTIFACTS: readonly ChatGPTAccountArtifactKind[] = [
    "memories",
    "custom_instructions",
    "settings",
    "beta_features"
];

function safeError(scope: string, error: any): { scope: string; code: string; message: string } {
    return {
        scope,
        code: typeof error?.code === "string" ? error.code : "ACCOUNT_ARTIFACT_FAILED",
        message: typeof error?.message === "string"
            ? error.message.slice(0, 1000)
            : "ChatGPT account artifact failed"
    };
}

function mustRethrow(error: any): boolean {
    return error instanceof ChatGPTTransportError && error.code === "AUTH_REQUIRED"
        || error?.code === "ABORTED";
}

/**
 * Capture non-conversation account surfaces that are part of the supported
 * ChatGPT web contract. This deliberately stays separate from conversation
 * inventory so neither result can overstate full-backup completeness.
 */
export async function captureChatGPTAccountInventory(
    client: ChatGPTClient,
    workspaceId: string,
    workspaceKey: string,
    options: InventoryOptions = {}
): Promise<ChatGPTAccountInventoryResult> {
    const artifacts: Partial<Record<ChatGPTAccountArtifactKind, any>> = {};
    const errors: ChatGPTAccountInventoryResult["errors"] = [];
    const evidence: PaginationEvidence[] = [];

    for (const kind of ACCOUNT_ARTIFACTS) {
        if (options.signal?.aborted) {
            throw Object.assign(new Error("ChatGPT account inventory was aborted"), { code: "ABORTED" });
        }
        try {
            artifacts[kind] = await client.accountArtifact(kind, workspaceId);
        } catch (error: any) {
            if (mustRethrow(error)) throw error;
            errors.push(safeError(`account:${kind}`, error));
        }
    }

    let customGpts: any[] = [];
    try {
        const gptResult = await cursorChain(
            cursor => client.myGptsPage(cursor, workspaceId),
            "custom_gpts",
            null,
            options
        );
        customGpts = gptResult.items;
        evidence.push(gptResult.evidence);
    } catch (error: any) {
        if (mustRethrow(error)) throw error;
        errors.push(safeError("custom_gpts", error));
    }

    return {
        schemaVersion: 1,
        providerId: "chatgpt",
        workspaceKey,
        accountInventoryComplete:
            errors.length === 0
            && ACCOUNT_ARTIFACTS.every(kind => Object.prototype.hasOwnProperty.call(artifacts, kind))
            && evidence.length === 1
            && evidence[0].complete,
        artifacts,
        customGpts,
        evidence,
        errors
    };
}
