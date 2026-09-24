import { createHash } from "node:crypto";

export type VerificationState = "UNVERIFIED" | "PARTIAL" | "VERIFIED" | "FAILED";
export type ReconciliationStatus =
    | "MATCHED"
    | "LIVE_ONLY"
    | "EXPORT_ONLY"
    | "AMBIGUOUS"
    | "DUPLICATE"
    | "MOVED_RENAMED"
    | "UNKNOWN";

export type RetentionClassification =
    | "KEEP_CANONICAL"
    | "KEEP_ACTIVE"
    | "KEEP_UNIQUE"
    | "KEEP_HISTORICAL"
    | "KEEP_UNCERTAIN"
    | "ARCHIVE"
    | "DELETE_EXACT_DUPLICATE"
    | "DELETE_REDUNDANT"
    | "DELETE_SUPERSEDED"
    | "DELETE_LOW_VALUE"
    | "DELETE_EMPTY"
    | "DELETE_TEST"
    | "DELETE_FAILED_EXPERIMENT"
    | "DELETE_TEMPORARY"
    | "DELETE_AFTER_DISTILLATION"
    | "REVIEW_REQUIRED";

export interface IdentityObservation {
    accountId: string;
    nativeConversationId?: string | null;
    stableUrl?: string | null;
    graphFingerprint?: string | null;
    contentFingerprint?: string | null;
    createTime?: string | number | null;
    updateTime?: string | number | null;
    title?: string | null;
}

export interface IdentityEvidence {
    method: "NATIVE_ID" | "STABLE_URL_ID" | "GRAPH_FINGERPRINT" | "CONTENT_FINGERPRINT" | "TIMESTAMP_CONTENT" | "TITLE_ONLY" | "ACCOUNT_MISMATCH";
    value: string;
    strength: "EXACT" | "STRONG" | "WEAK" | "REJECTED";
}

export interface IdentityResolution {
    matched: boolean;
    confidence: number;
    canonicalConversationId: string | null;
    identityEvidence: IdentityEvidence[];
    deletionGrade: boolean;
}

export interface ExportConversationObservation extends IdentityObservation {
    sourceExportId: string;
    title?: string | null;
}

export interface LiveConversationObservation extends IdentityObservation {
    url: string;
    title?: string | null;
    workspace?: string | null;
    archiveState?: "ACTIVE" | "ARCHIVED" | "UNKNOWN";
}

export interface ReconciliationRow {
    canonicalConversationId: string | null;
    accountId: string;
    exportPresence: boolean;
    livePresence: boolean;
    exportNativeId: string | null;
    liveNativeId: string | null;
    title: string | null;
    identityMethod: IdentityEvidence["method"] | null;
    identityConfidence: number;
    status: ReconciliationStatus;
}

export interface LosslessDeleteEvidence {
    rawExportExists: boolean;
    rawSourceHashVerified: boolean;
    conversationParsed: boolean;
    messageGraphComplete: boolean;
    attachmentsPreservedOrExplicitlyUnavailable: boolean;
    knowledgeExtractionComplete: boolean;
    uniqueKnowledgePreserved: boolean;
    provenanceRoundTripVerified: boolean;
    notSoleCriticalSource: boolean;
    noIdentityAmbiguity: boolean;
    noParsingFailure: boolean;
    deletionManifestBackupVerified: boolean;
    liveConversationUniquelyMatched: boolean;
}

export interface DeleteGateResult {
    code: string;
    passed: boolean;
}

export interface DeleteGateEvaluation {
    safeToDelete: boolean;
    gateResults: DeleteGateResult[];
    blockingConditions: string[];
}

export interface ConversationValueEvidence {
    uniqueKnowledgeCount: number;
    uniqueFactCount: number;
    uniqueArtifactCount: number;
    uniqueDecisionCount: number;
    uniqueProcedureCount: number;
    uniqueCodeCount: number;
    uniqueAttachmentCount: number;
    historicalValue: boolean;
    currentOperationalValue: boolean;
    reproducibilityValue: boolean;
    redundancyRatio: number;
    supersededRatio: number;
    noiseRatio: number;
    recoverability: number;
    exportIntegrity: VerificationState;
    knowledgeExtractionCoverage: number;
    messageCount: number;
    exactDuplicateOf?: string | null;
}

export interface RetentionDecision {
    classification: RetentionClassification;
    confidence: number;
    reasonCodes: string[];
    uniqueInformationRemaining: number;
    safeToDelete: boolean;
    blockingConditions: string[];
}

export interface DeleteManifestItem {
    accountId: string;
    workspace?: string | null;
    canonicalConversationId: string;
    nativeConversationId: string;
    url: string;
    title: string | null;
    classification: RetentionClassification;
    reasonCodes: string[];
    identityConfidence: number;
    deletionConfidence: number;
    rawExportLocation: string;
    rawHash: string;
    knowledgeExtractionState: VerificationState;
    knowledgeUnitsPreserved: number;
    uniqueInformationRemaining: number;
    attachmentsState: "PRESERVED" | "UNAVAILABLE_EXPLICIT" | "NONE";
    dependencies: string[];
    gateResults: DeleteGateResult[];
    safeToDelete: boolean;
    plannedAction: "DELETE";
}

export interface DeletionManifest {
    schemaVersion: 1;
    manifestId: string;
    generationTimestamp: string;
    softwareVersion: string;
    sourceExportHashes: string[];
    liveInventorySnapshotHash: string;
    items: DeleteManifestItem[];
    manifestSha256: string;
}

function normalizeTimestamp(value: string | number | null | undefined): string {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    return String(value);
}

function stableObject(value: any): any {
    if (Array.isArray(value)) return value.map(stableObject);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map(key => [key, stableObject(value[key])])
    );
}

export function stableJson(value: any): string {
    return JSON.stringify(stableObject(value));
}

export function sha256Hex(value: string | Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}

export function nativeConversationIdFromUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const match = String(url).match(/(?:^|\/)c\/([A-Za-z0-9_-]+)(?:[/?#]|$)/);
    return match ? match[1] : null;
}

function canonicalKey(observation: IdentityObservation): string {
    const native = observation.nativeConversationId?.trim() || nativeConversationIdFromUrl(observation.stableUrl);
    if (native) return \`native:\${native}\`;
    if (observation.graphFingerprint) return \`graph:\${observation.graphFingerprint}\`;
    if (observation.contentFingerprint) {
        return \`content:\${observation.contentFingerprint}:created:\${normalizeTimestamp(observation.createTime)}\`;
    }
    return \`unresolved:\${stableJson({
        createTime: normalizeTimestamp(observation.createTime),
        updateTime: normalizeTimestamp(observation.updateTime),
        title: observation.title || ""
    })}\`;
}

export function canonicalConversationIdFor(
    observation: IdentityObservation,
    existingCanonicalId?: string | null
): string {
    if (existingCanonicalId) return existingCanonicalId;
    return \`cc_\${sha256Hex(\`\${observation.accountId}\\0\${canonicalKey(observation)}\`).slice(0, 32)}\`;
}

function exactUrlId(observation: IdentityObservation): string | null {
    return nativeConversationIdFromUrl(observation.stableUrl);
}

export function resolveConversationIdentity(
    left: IdentityObservation,
    right: IdentityObservation,
    existingCanonicalId?: string | null
): IdentityResolution {
    if (left.accountId !== right.accountId) {
        return {
            matched: false,
            confidence: 0,
            canonicalConversationId: null,
            identityEvidence: [{ method: "ACCOUNT_MISMATCH", value: \`\${left.accountId} != \${right.accountId}\`, strength: "REJECTED" }],
            deletionGrade: false
        };
    }

    const evidence: IdentityEvidence[] = [];
    const leftNative = left.nativeConversationId?.trim() || null;
    const rightNative = right.nativeConversationId?.trim() || null;
    if (leftNative && rightNative) {
        if (leftNative === rightNative) {
            evidence.push({ method: "NATIVE_ID", value: leftNative, strength: "EXACT" });
            return {
                matched: true,
                confidence: 1,
                canonicalConversationId: canonicalConversationIdFor(left, existingCanonicalId),
                identityEvidence: evidence,
                deletionGrade: true
            };
        }
        evidence.push({ method: "NATIVE_ID", value: \`\${leftNative} != \${rightNative}\`, strength: "REJECTED" });
        return { matched: false, confidence: 0, canonicalConversationId: null, identityEvidence: evidence, deletionGrade: false };
    }

    const leftUrl = exactUrlId(left);
    const rightUrl = exactUrlId(right);
    if (leftUrl && rightUrl) {
        if (leftUrl === rightUrl) {
            evidence.push({ method: "STABLE_URL_ID", value: leftUrl, strength: "EXACT" });
            return {
                matched: true,
                confidence: 0.995,
                canonicalConversationId: canonicalConversationIdFor(left, existingCanonicalId),
                identityEvidence: evidence,
                deletionGrade: true
            };
        }
        evidence.push({ method: "STABLE_URL_ID", value: \`\${leftUrl} != \${rightUrl}\`, strength: "REJECTED" });
        return { matched: false, confidence: 0, canonicalConversationId: null, identityEvidence: evidence, deletionGrade: false };
    }

    if (left.graphFingerprint && right.graphFingerprint && left.graphFingerprint === right.graphFingerprint) {
        evidence.push({ method: "GRAPH_FINGERPRINT", value: left.graphFingerprint, strength: "STRONG" });
        return {
            matched: true,
            confidence: 0.97,
            canonicalConversationId: canonicalConversationIdFor(left, existingCanonicalId),
            identityEvidence: evidence,
            deletionGrade: true
        };
    }

    if (left.contentFingerprint && right.contentFingerprint && left.contentFingerprint === right.contentFingerprint) {
        evidence.push({ method: "CONTENT_FINGERPRINT", value: left.contentFingerprint, strength: "STRONG" });
        const timeMatch =
            normalizeTimestamp(left.createTime) !== ""
            && normalizeTimestamp(left.createTime) === normalizeTimestamp(right.createTime);
        if (timeMatch) {
            evidence.push({
                method: "TIMESTAMP_CONTENT",
                value: \`\${normalizeTimestamp(left.createTime)}|\${left.contentFingerprint}\`,
                strength: "STRONG"
            });
        }
        const confidence = timeMatch ? 0.94 : 0.9;
        return {
            matched: true,
            confidence,
            canonicalConversationId: canonicalConversationIdFor(left, existingCanonicalId),
            identityEvidence: evidence,
            deletionGrade: confidence >= 0.94
        };
    }

    if (left.title && right.title && left.title.trim() === right.title.trim()) {
        evidence.push({ method: "TITLE_ONLY", value: left.title.trim(), strength: "WEAK" });
    }
    return {
        matched: false,
        confidence: evidence.length ? 0.2 : 0,
        canonicalConversationId: null,
        identityEvidence: evidence,
        deletionGrade: false
    };
}

const DELETE_GATES: Array<[keyof LosslessDeleteEvidence, string]> = [
    ["rawExportExists", "A_RAW_EXPORT_EXISTS"],
    ["rawSourceHashVerified", "B_RAW_SOURCE_HASH_VERIFIED"],
    ["conversationParsed", "C_CONVERSATION_PARSED"],
    ["messageGraphComplete", "D_MESSAGE_GRAPH_COMPLETE"],
    ["attachmentsPreservedOrExplicitlyUnavailable", "E_ATTACHMENTS_ACCOUNTED_FOR"],
    ["knowledgeExtractionComplete", "F_KNOWLEDGE_EXTRACTION_COMPLETE"],
    ["uniqueKnowledgePreserved", "G_UNIQUE_KNOWLEDGE_PRESERVED"],
    ["provenanceRoundTripVerified", "H_PROVENANCE_ROUND_TRIP"],
    ["notSoleCriticalSource", "I_NOT_SOLE_CRITICAL_SOURCE"],
    ["noIdentityAmbiguity", "J_NO_IDENTITY_AMBIGUITY"],
    ["noParsingFailure", "K_NO_PARSING_FAILURE"],
    ["deletionManifestBackupVerified", "L_MANIFEST_BACKUP_VERIFIED"],
    ["liveConversationUniquelyMatched", "M_LIVE_MATCH_UNIQUE"]
];

export function evaluateLosslessDeleteGate(evidence: LosslessDeleteEvidence): DeleteGateEvaluation {
    const gateResults = DELETE_GATES.map(([field, code]) => ({ code, passed: evidence[field] === true }));
    const blockingConditions = gateResults.filter(result => !result.passed).map(result => result.code);
    return {
        safeToDelete: blockingConditions.length === 0,
        gateResults,
        blockingConditions
    };
}

function uniqueInformationCount(value: ConversationValueEvidence): number {
    return value.uniqueKnowledgeCount
        + value.uniqueFactCount
        + value.uniqueArtifactCount
        + value.uniqueDecisionCount
        + value.uniqueProcedureCount
        + value.uniqueCodeCount
        + value.uniqueAttachmentCount;
}

export function classifyConversationRetention(
    value: ConversationValueEvidence,
    gate: DeleteGateEvaluation
): RetentionDecision {
    const uniqueInformationRemaining = uniqueInformationCount(value);
    const blockers = [...gate.blockingConditions];

    if (uniqueInformationRemaining > 0) {
        return {
            classification: "KEEP_UNIQUE",
            confidence: 1,
            reasonCodes: ["UNIQUE_INFORMATION_REMAINS"],
            uniqueInformationRemaining,
            safeToDelete: false,
            blockingConditions: blockers
        };
    }

    if (!gate.safeToDelete) {
        return {
            classification: "REVIEW_REQUIRED",
            confidence: 1,
            reasonCodes: ["LOSSLESS_GATE_BLOCKED"],
            uniqueInformationRemaining,
            safeToDelete: false,
            blockingConditions: blockers
        };
    }

    if (value.exactDuplicateOf) {
        return {
            classification: "DELETE_EXACT_DUPLICATE",
            confidence: 1,
            reasonCodes: ["EXACT_DUPLICATE", "ZERO_UNIQUE_INFORMATION", "LOSSLESS_GATE_PASSED"],
            uniqueInformationRemaining,
            safeToDelete: true,
            blockingConditions: []
        };
    }

    if (value.messageCount === 0 && value.uniqueAttachmentCount === 0) {
        return {
            classification: "DELETE_EMPTY",
            confidence: 0.99,
            reasonCodes: ["EMPTY_CONVERSATION", "ZERO_UNIQUE_INFORMATION", "LOSSLESS_GATE_PASSED"],
            uniqueInformationRemaining,
            safeToDelete: true,
            blockingConditions: []
        };
    }

    return {
        classification: value.currentOperationalValue ? "KEEP_ACTIVE" : value.historicalValue ? "KEEP_HISTORICAL" : "KEEP_CANONICAL",
        confidence: 0.9,
        reasonCodes: ["NO_PROVEN_SAFE_DELETION_CLASS"],
        uniqueInformationRemaining,
        safeToDelete: false,
        blockingConditions: []
    };
}

function bestIdentityMethod(resolution: IdentityResolution): IdentityEvidence["method"] | null {
    return resolution.identityEvidence.find(item => item.strength === "EXACT" || item.strength === "STRONG")?.method || null;
}

export function reconcileConversations(
    exports: ExportConversationObservation[],
    live: LiveConversationObservation[]
): ReconciliationRow[] {
    const rows: ReconciliationRow[] = [];
    const usedLive = new Set<number>();

    for (const exported of exports) {
        let best: { index: number; resolution: IdentityResolution } | null = null;
        for (let index = 0; index < live.length; index++) {
            if (usedLive.has(index)) continue;
            const resolution = resolveConversationIdentity(exported, live[index]);
            if (!resolution.matched) continue;
            if (!best || resolution.confidence > best.resolution.confidence) best = { index, resolution };
        }

        if (best) {
            const matchedLive = live[best.index];
            usedLive.add(best.index);
            rows.push({
                canonicalConversationId: best.resolution.canonicalConversationId,
                accountId: exported.accountId,
                exportPresence: true,
                livePresence: true,
                exportNativeId: exported.nativeConversationId || null,
                liveNativeId: matchedLive.nativeConversationId || nativeConversationIdFromUrl(matchedLive.url),
                title: matchedLive.title || exported.title || null,
                identityMethod: bestIdentityMethod(best.resolution),
                identityConfidence: best.resolution.confidence,
                status: exported.title && matchedLive.title && exported.title !== matchedLive.title ? "MOVED_RENAMED" : "MATCHED"
            });
        } else {
            rows.push({
                canonicalConversationId: canonicalConversationIdFor(exported),
                accountId: exported.accountId,
                exportPresence: true,
                livePresence: false,
                exportNativeId: exported.nativeConversationId || null,
                liveNativeId: null,
                title: exported.title || null,
                identityMethod: null,
                identityConfidence: 0,
                status: "EXPORT_ONLY"
            });
        }
    }

    for (let index = 0; index < live.length; index++) {
        if (usedLive.has(index)) continue;
        const item = live[index];
        rows.push({
            canonicalConversationId: canonicalConversationIdFor({
                ...item,
                nativeConversationId: item.nativeConversationId || nativeConversationIdFromUrl(item.url)
            }),
            accountId: item.accountId,
            exportPresence: false,
            livePresence: true,
            exportNativeId: null,
            liveNativeId: item.nativeConversationId || nativeConversationIdFromUrl(item.url),
            title: item.title || null,
            identityMethod: null,
            identityConfidence: 0,
            status: "LIVE_ONLY"
        });
    }

    return rows.sort((a, b) =>
        a.accountId.localeCompare(b.accountId)
        || (a.canonicalConversationId || "").localeCompare(b.canonicalConversationId || "")
    );
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object") {
        Object.freeze(value);
        for (const child of Object.values(value as any)) deepFreeze(child);
    }
    return value;
}

function manifestPayload(manifest: Omit<DeletionManifest, "manifestSha256">): string {
    return stableJson(manifest);
}

export function buildDeletionManifest(input: {
    manifestId: string;
    generationTimestamp: string;
    softwareVersion: string;
    sourceExportHashes: string[];
    liveInventorySnapshotHash: string;
    items: DeleteManifestItem[];
}): DeletionManifest {
    if (!input.items.length) throw new Error("Deletion manifest cannot be empty");
    for (const item of input.items) {
        if (!item.safeToDelete) throw new Error(\`Unsafe manifest item: \${item.canonicalConversationId}\`);
        if (item.gateResults.some(gate => !gate.passed)) {
            throw new Error(\`Manifest item has failed gate: \${item.canonicalConversationId}\`);
        }
        if (!item.nativeConversationId || !item.rawHash || !item.rawExportLocation) {
            throw new Error(\`Manifest item is missing deletion evidence: \${item.canonicalConversationId}\`);
        }
    }

    const payload: Omit<DeletionManifest, "manifestSha256"> = {
        schemaVersion: 1,
        manifestId: input.manifestId,
        generationTimestamp: input.generationTimestamp,
        softwareVersion: input.softwareVersion,
        sourceExportHashes: [...new Set(input.sourceExportHashes)].sort(),
        liveInventorySnapshotHash: input.liveInventorySnapshotHash,
        items: [...input.items].sort((a, b) =>
            a.accountId.localeCompare(b.accountId)
            || a.canonicalConversationId.localeCompare(b.canonicalConversationId)
        )
    };
    return deepFreeze({
        ...payload,
        manifestSha256: sha256Hex(manifestPayload(payload))
    });
}

export function verifyDeletionManifest(manifest: DeletionManifest): boolean {
    const { manifestSha256, ...payload } = manifest;
    return /^[a-f0-9]{64}$/.test(manifestSha256)
        && sha256Hex(manifestPayload(payload)) === manifestSha256
        && manifest.items.every(item => item.safeToDelete && item.gateResults.every(gate => gate.passed));
}
