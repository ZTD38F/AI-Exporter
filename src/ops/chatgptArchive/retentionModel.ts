import type {
    DeleteGateEvaluation,
    RetentionClassification,
    VerificationState
} from "./controlPlane.js";
import type { KnowledgeMapSnapshot, KnowledgeType } from "./knowledgeMap.js";

export interface ConversationValueInput {
    canonicalConversationId: string;
    messageCount: number;
    attachmentCount: number;
    crossReferences?: number;
    historicalValue?: boolean;
    currentOperationalValue?: boolean;
    reproducibilityValue?: boolean;
    noiseItems?: number;
    recoverabilityChecks: boolean[];
    exportIntegrity: VerificationState;
    knowledgeExtractionCoverage: number;
    identityConfidence: number;
    exactDuplicateOf?: string | null;
    explicitDisposition?: "TEST" | "TEMPORARY" | "FAILED_EXPERIMENT" | null;
}

export interface ConversationValueModel {
    uniqueKnowledgeCount: number;
    uniqueFactCount: number;
    uniqueArtifactCount: number;
    uniqueDecisionCount: number;
    uniqueProcedureCount: number;
    uniqueCodeCount: number;
    uniqueAttachmentCount: number;
    crossReferences: number;
    knowledgeDependencyCount: number;
    historicalValue: boolean;
    currentOperationalValue: boolean;
    reproducibilityValue: boolean;
    redundancyRatio: number;
    supersededRatio: number;
    noiseRatio: number;
    recoverability: number;
    exportIntegrity: VerificationState;
    knowledgeExtractionCoverage: number;
    deletionConfidence: number;
    deletionConfidenceBasis: {
        gatePassRatio: number;
        identityConfidence: number;
        extractionCoverage: number;
        uniqueInformationRemaining: number;
    };
}

export interface TransparentRetentionDecision {
    classification: RetentionClassification;
    confidence: number;
    reasonCodes: string[];
    evidence: ConversationValueModel;
    uniqueInformationRemaining: number;
    safeToDelete: boolean;
    blockingConditions: string[];
}

const ARTIFACT_TYPES = new Set<KnowledgeType>(["FILE", "DOCUMENT", "RESOURCE"]);
const CODE_TYPES = new Set<KnowledgeType>(["CODE_COMPONENT", "COMMAND", "CONFIGURATION"]);

function ratio(numerator: number, denominator: number): number {
    return denominator > 0 ? numerator / denominator : 0;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function sourceConversationSet(unit: any): Set<string> {
    return new Set((unit.sources || []).map((source: any) => source.canonicalConversationId));
}

export function computeConversationValue(
    map: KnowledgeMapSnapshot,
    input: ConversationValueInput,
    gate: DeleteGateEvaluation
): ConversationValueModel {
    const units = map.units.filter(unit =>
        unit.sources.some(source => source.canonicalConversationId === input.canonicalConversationId)
    );
    const unique = units.filter(unit => sourceConversationSet(unit).size === 1);
    const redundant = units.filter(unit => sourceConversationSet(unit).size > 1);
    const superseded = units.filter(unit => unit.supersededBy.length > 0);
    const unitIds = new Set(units.map(unit => unit.knowledgeId));
    const relatedEdges = map.edges.filter(edge =>
        unitIds.has(edge.fromKnowledgeId) || unitIds.has(edge.toKnowledgeId)
    );

    const uniqueDecisionCount = unique.filter(unit => unit.type === "DECISION").length;
    const uniqueProcedureCount = unique.filter(unit => unit.type === "PROCEDURE" || unit.type === "WORKFLOW").length;
    const uniqueCodeCount = unique.filter(unit => CODE_TYPES.has(unit.type)).length;
    const uniqueArtifactCount = unique.filter(unit => ARTIFACT_TYPES.has(unit.type)).length;
    const specialized = new Set([
        "DECISION", "PROCEDURE", "WORKFLOW", "CODE_COMPONENT", "COMMAND", "CONFIGURATION",
        "FILE", "DOCUMENT", "RESOURCE"
    ]);
    const uniqueFactCount = unique.filter(unit => !specialized.has(unit.type)).length;
    const uniqueAttachmentCount = input.attachmentCount;
    const uniqueKnowledgeCount = unique.length;

    const checks = input.recoverabilityChecks || [];
    const recoverability = checks.length ? ratio(checks.filter(Boolean).length, checks.length) : 0;
    const gatePassRatio = ratio(gate.gateResults.filter(item => item.passed).length, gate.gateResults.length);
    const extractionCoverage = clamp01(input.knowledgeExtractionCoverage);
    const identityConfidence = clamp01(input.identityConfidence);
    const uniqueInformationRemaining =
        uniqueFactCount + uniqueArtifactCount + uniqueDecisionCount
        + uniqueProcedureCount + uniqueCodeCount + uniqueAttachmentCount;

    const deletionConfidence = uniqueInformationRemaining > 0 || !gate.safeToDelete
        ? 0
        : Math.min(gatePassRatio, extractionCoverage, identityConfidence, recoverability);

    const totalSignals = Math.max(1, units.length + input.messageCount);
    return {
        uniqueKnowledgeCount,
        uniqueFactCount,
        uniqueArtifactCount,
        uniqueDecisionCount,
        uniqueProcedureCount,
        uniqueCodeCount,
        uniqueAttachmentCount,
        crossReferences: input.crossReferences ?? relatedEdges.length,
        knowledgeDependencyCount: relatedEdges.length,
        historicalValue: Boolean(input.historicalValue || units.some(unit => unit.currentOrHistorical === "HISTORICAL")),
        currentOperationalValue: Boolean(
            input.currentOperationalValue
            || units.some(unit => unit.currentOrHistorical === "CURRENT" && unit.status === "ACTIVE")
        ),
        reproducibilityValue: Boolean(input.reproducibilityValue),
        redundancyRatio: ratio(redundant.length, units.length),
        supersededRatio: ratio(superseded.length, units.length),
        noiseRatio: ratio(input.noiseItems ?? 0, totalSignals),
        recoverability,
        exportIntegrity: input.exportIntegrity,
        knowledgeExtractionCoverage: extractionCoverage,
        deletionConfidence,
        deletionConfidenceBasis: {
            gatePassRatio,
            identityConfidence,
            extractionCoverage,
            uniqueInformationRemaining
        }
    };
}

export function classifyWithTransparentValue(
    map: KnowledgeMapSnapshot,
    input: ConversationValueInput,
    gate: DeleteGateEvaluation
): TransparentRetentionDecision {
    const value = computeConversationValue(map, input, gate);
    const uniqueInformationRemaining = value.deletionConfidenceBasis.uniqueInformationRemaining;
    const blockers = [...gate.blockingConditions];

    if (input.exportIntegrity !== "VERIFIED" || input.knowledgeExtractionCoverage < 1) {
        return {
            classification: "KEEP_UNCERTAIN",
            confidence: 1,
            reasonCodes: [
                input.exportIntegrity !== "VERIFIED" ? "EXPORT_INTEGRITY_NOT_VERIFIED" : "",
                input.knowledgeExtractionCoverage < 1 ? "KNOWLEDGE_EXTRACTION_INCOMPLETE" : ""
            ].filter(Boolean),
            evidence: value,
            uniqueInformationRemaining,
            safeToDelete: false,
            blockingConditions: blockers
        };
    }

    if (uniqueInformationRemaining > 0) {
        return {
            classification: "KEEP_UNIQUE",
            confidence: 1,
            reasonCodes: ["UNIQUE_INFORMATION_REMAINS"],
            evidence: value,
            uniqueInformationRemaining,
            safeToDelete: false,
            blockingConditions: blockers
        };
    }

    if (value.currentOperationalValue) {
        return {
            classification: "KEEP_ACTIVE",
            confidence: 1,
            reasonCodes: ["CURRENT_OPERATIONAL_VALUE"],
            evidence: value,
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
            evidence: value,
            uniqueInformationRemaining,
            safeToDelete: false,
            blockingConditions: blockers
        };
    }

    if (input.exactDuplicateOf) {
        return {
            classification: "DELETE_EXACT_DUPLICATE",
            confidence: value.deletionConfidence,
            reasonCodes: ["EXACT_DUPLICATE", "ZERO_UNIQUE_INFORMATION", "LOSSLESS_GATE_PASSED"],
            evidence: value,
            uniqueInformationRemaining,
            safeToDelete: true,
            blockingConditions: []
        };
    }

    if (input.messageCount === 0 && input.attachmentCount === 0) {
        return {
            classification: "DELETE_EMPTY",
            confidence: value.deletionConfidence,
            reasonCodes: ["EMPTY_CONVERSATION", "LOSSLESS_GATE_PASSED"],
            evidence: value,
            uniqueInformationRemaining,
            safeToDelete: true,
            blockingConditions: []
        };
    }

    if (input.explicitDisposition === "TEST") {
        return {
            classification: "DELETE_TEST",
            confidence: value.deletionConfidence,
            reasonCodes: ["EXPLICIT_TEST_CONVERSATION", "ZERO_UNIQUE_INFORMATION", "LOSSLESS_GATE_PASSED"],
            evidence: value,
            uniqueInformationRemaining,
            safeToDelete: true,
            blockingConditions: []
        };
    }
    if (input.explicitDisposition === "TEMPORARY") {
        return {
            classification: "DELETE_TEMPORARY",
            confidence: value.deletionConfidence,
            reasonCodes: ["EXPLICIT_TEMPORARY_CONVERSATION", "ZERO_UNIQUE_INFORMATION", "LOSSLESS_GATE_PASSED"],
            evidence: value,
            uniqueInformationRemaining,
            safeToDelete: true,
            blockingConditions: []
        };
    }
    if (input.explicitDisposition === "FAILED_EXPERIMENT") {
        return {
            classification: "DELETE_FAILED_EXPERIMENT",
            confidence: value.deletionConfidence,
            reasonCodes: ["EXPLICIT_FAILED_EXPERIMENT", "ZERO_UNIQUE_INFORMATION", "LOSSLESS_GATE_PASSED"],
            evidence: value,
            uniqueInformationRemaining,
            safeToDelete: true,
            blockingConditions: []
        };
    }

    if (value.historicalValue) {
        return {
            classification: "KEEP_HISTORICAL",
            confidence: 1,
            reasonCodes: ["HISTORICAL_VALUE"],
            evidence: value,
            uniqueInformationRemaining,
            safeToDelete: false,
            blockingConditions: []
        };
    }

    return {
        classification: "KEEP_CANONICAL",
        confidence: 1,
        reasonCodes: ["NO_PROVEN_DELETION_CLASS"],
        evidence: value,
        uniqueInformationRemaining,
        safeToDelete: false,
        blockingConditions: []
    };
}
