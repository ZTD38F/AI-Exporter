import type { DeleteManifestItem, LiveConversationObservation } from "./controlPlane.js";

export type DeleteVerificationStatus = "EXPECTED_ABSENT" | "STILL_PRESENT" | "UNKNOWN";
export type KeepVerificationStatus = "EXPECTED_PRESENT" | "MISSING" | "UNKNOWN";

export interface PostDeleteVerification {
    accountId: string;
    accountInventoryComplete: boolean;
    deleteItems: Array<{
        canonicalConversationId: string;
        nativeConversationId: string;
        status: DeleteVerificationStatus;
    }>;
    keepItems: Array<{
        nativeConversationId: string;
        status: KeepVerificationStatus;
    }>;
    criticalIncidents: Array<{
        type: "KEEP_MISSING";
        nativeConversationId: string;
        severity: "CRITICAL";
    }>;
    deletionFailures: number;
    deletionsVerified: number;
    keepIntegrityFailures: number;
}

export function verifyPostDeleteInventory(input: {
    accountId: string;
    accountInventoryComplete: boolean;
    deleteItems: DeleteManifestItem[];
    keepNativeConversationIds: string[];
    liveAfter: LiveConversationObservation[];
}): PostDeleteVerification {
    for (const item of input.deleteItems) {
        if (item.accountId !== input.accountId) {
            throw new Error("Post-delete verification cannot mix account identities");
        }
    }
    for (const item of input.liveAfter) {
        if (item.accountId !== input.accountId) {
            throw new Error("Post-delete live inventory contains a different account");
        }
    }

    const liveIds = new Set(
        input.liveAfter
            .map(item => item.nativeConversationId)
            .filter((value): value is string => Boolean(value))
    );

    const deleteItems = input.deleteItems.map(item => {
        const present = liveIds.has(item.nativeConversationId);
        const status: DeleteVerificationStatus = present
            ? "STILL_PRESENT"
            : input.accountInventoryComplete
                ? "EXPECTED_ABSENT"
                : "UNKNOWN";
        return {
            canonicalConversationId: item.canonicalConversationId,
            nativeConversationId: item.nativeConversationId,
            status
        };
    });

    const keepItems = [...new Set(input.keepNativeConversationIds)].sort().map(nativeConversationId => {
        const present = liveIds.has(nativeConversationId);
        const status: KeepVerificationStatus = present
            ? "EXPECTED_PRESENT"
            : input.accountInventoryComplete
                ? "MISSING"
                : "UNKNOWN";
        return { nativeConversationId, status };
    });

    const criticalIncidents = keepItems
        .filter(item => item.status === "MISSING")
        .map(item => ({
            type: "KEEP_MISSING" as const,
            nativeConversationId: item.nativeConversationId,
            severity: "CRITICAL" as const
        }));

    return {
        accountId: input.accountId,
        accountInventoryComplete: input.accountInventoryComplete,
        deleteItems,
        keepItems,
        criticalIncidents,
        deletionFailures: deleteItems.filter(item => item.status === "STILL_PRESENT").length,
        deletionsVerified: deleteItems.filter(item => item.status === "EXPECTED_ABSENT").length,
        keepIntegrityFailures: criticalIncidents.length
    };
}
