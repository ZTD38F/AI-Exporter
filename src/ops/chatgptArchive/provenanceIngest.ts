import { normalizeChatGPTConversation } from "../../core/provider/chatgpt/graph.js";
import {
    canonicalConversationIdFor,
    sha256Hex,
    stableJson,
    type VerificationState
} from "./controlPlane.js";

export interface SourceFileEvidence {
    sourceFileId: string;
    sourceFile: string;
    sha256: string;
    sizeBytes?: number;
    originalJson?: string;
}

export interface ConversationEvidence {
    sourceFileId: string;
    sourceFile: string;
    sourceIndex: number;
    raw: any;
}

export interface ExportEvidenceBundle {
    runId: string;
    accountId: string;
    accountLabel?: string;
    exportId: string;
    exportTimestamp?: string | null;
    rawLocation: string;
    zipSha256: string;
    ingestionVersion: string;
    sourceFiles: SourceFileEvidence[];
    conversations: ConversationEvidence[];
}

export interface ProvenanceSnapshot {
    accounts: any[];
    exports: any[];
    source_files: any[];
    conversations: any[];
    conversation_sources: any[];
    messages: any[];
    message_edges: any[];
    errors: any[];
}

function assertSha256(value: string, label: string): void {
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(label + " must be SHA-256");
}

function nativeId(raw: any): string | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    for (const key of ["id", "conversation_id", "conversationId"]) {
        const value = raw[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
}

function marker(raw: any, kind: "create" | "update"): string | null {
    const keys = kind === "create" ? ["create_time", "created_at"] : ["update_time", "updated_at"];
    for (const key of keys) {
        const value = raw?.[key];
        if (value !== null && value !== undefined && String(value).trim()) return String(value);
    }
    return null;
}

function comparableTimestamp(value: string | null): number {
    if (!value) return Number.NEGATIVE_INFINITY;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function sourceConversationKey(bundle: ExportEvidenceBundle, item: ConversationEvidence, conversationId: string): string {
    return "sc_" + sha256Hex(stableJson({
        accountId: bundle.accountId,
        exportId: bundle.exportId,
        sourceFile: item.sourceFile,
        sourceIndex: item.sourceIndex,
        conversationId
    })).slice(0, 32);
}

function messageKey(sourceKey: string, nodeId: string): string {
    return "msg_" + sha256Hex(sourceKey + ":" + nodeId).slice(0, 32);
}

function asRecord(value: any): Record<string, any> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function ingestError(bundle: ExportEvidenceBundle, conversationId: string | null, evidence: any): any {
    const signature = stableJson({
        runId: bundle.runId,
        accountId: bundle.accountId,
        conversationId,
        evidence
    });
    return {
        error_id: "err_" + sha256Hex(signature).slice(0, 32),
        run_id: bundle.runId,
        account_id: bundle.accountId,
        canonical_conversation_id: conversationId,
        type: "PARSER",
        scope: "INGEST",
        severity: "DATA_LOSS_RISK",
        retryable: false,
        evidence,
        attempt_count: 1,
        resolution_state: "OPEN"
    };
}

export function buildProvenanceSnapshot(bundle: ExportEvidenceBundle): ProvenanceSnapshot {
    if (!bundle.runId || !bundle.accountId || !bundle.exportId || !bundle.rawLocation || !bundle.ingestionVersion) {
        throw new Error("export evidence identity is incomplete");
    }
    assertSha256(bundle.zipSha256, "zipSha256");

    const sources = new Map<string, SourceFileEvidence>();
    for (const source of bundle.sourceFiles) {
        if (!source.sourceFileId || !source.sourceFile) throw new Error("source file identity is incomplete");
        assertSha256(source.sha256, "source hash for " + source.sourceFile);
        if (sources.has(source.sourceFileId)) throw new Error("duplicate sourceFileId: " + source.sourceFileId);
        sources.set(source.sourceFileId, source);
    }

    const canonicalRows = new Map<string, any>();
    const conversationSources: any[] = [];
    const messages: any[] = [];
    const edges: any[] = [];
    const errors: any[] = [];

    for (const item of bundle.conversations) {
        const source = sources.get(item.sourceFileId);
        if (!source || source.sourceFile !== item.sourceFile) {
            throw new Error("missing source evidence for " + item.sourceFile);
        }

        const conversationId = nativeId(item.raw);
        if (!conversationId) {
            errors.push(ingestError(bundle, null, {
                sourceFile: item.sourceFile,
                sourceIndex: item.sourceIndex,
                reason: "NATIVE_CONVERSATION_ID_MISSING"
            }));
            continue;
        }

        const canonicalId = canonicalConversationIdFor({
            accountId: bundle.accountId,
            nativeConversationId: conversationId
        });
        if (!canonicalId) throw new Error("strong native identity failed for " + conversationId);

        const normalized = normalizeChatGPTConversation(item.raw, conversationId, bundle.accountId);
        const integrityComplete = normalized.integrity?.complete === true;
        const integrityReasons = normalized.integrity?.reasons ?? ["integrity_missing"];
        const verification: VerificationState = integrityComplete ? "VERIFIED" : "PARTIAL";
        const rawPayloadHash = sha256Hex(stableJson(item.raw));
        const sourceKey = sourceConversationKey(bundle, item, conversationId);

        conversationSources.push({
            source_conversation_key: sourceKey,
            canonical_conversation_id: canonicalId,
            source_account_id: bundle.accountId,
            source_export_id: bundle.exportId,
            source_file_id: item.sourceFileId,
            source_file: item.sourceFile,
            source_index: item.sourceIndex,
            native_conversation_id: conversationId,
            raw_payload_hash: rawPayloadHash,
            ingestion_version: bundle.ingestionVersion,
            verification_state: verification
        });

        const candidate = {
            canonical_conversation_id: canonicalId,
            account_id: bundle.accountId,
            native_conversation_id: conversationId,
            title: typeof item.raw?.title === "string" ? item.raw.title : null,
            create_time: marker(item.raw, "create"),
            update_time: marker(item.raw, "update"),
            content_fingerprint: rawPayloadHash,
            semantic_fingerprint: null,
            current_or_historical: "CURRENT",
            verification_state: verification,
            __sourceKey: sourceKey
        };
        const existing = canonicalRows.get(canonicalId);
        if (!existing
            || comparableTimestamp(candidate.update_time) > comparableTimestamp(existing.update_time)
            || (comparableTimestamp(candidate.update_time) === comparableTimestamp(existing.update_time)
                && sourceKey.localeCompare(existing.__sourceKey) < 0)) {
            canonicalRows.set(canonicalId, candidate);
        }

        if (!integrityComplete) {
            errors.push(ingestError(bundle, canonicalId, {
                sourceConversationKey: sourceKey,
                reasons: integrityReasons,
                malformedNodeIds: normalized.graph.malformedNodeIds
            }));
        }

        const mapping = asRecord(item.raw?.mapping);
        if (!mapping) {
            errors.push(ingestError(bundle, canonicalId, {
                sourceConversationKey: sourceKey,
                reason: "MAPPING_MISSING_OR_INVALID"
            }));
            continue;
        }

        for (const [nodeId, rawNode] of Object.entries(mapping)) {
            const node = asRecord(rawNode);
            if (!node) continue;
            const rawNodeJson = stableJson(rawNode);
            const rawMessage = asRecord(node.message);
            messages.push({
                message_key: messageKey(sourceKey, nodeId),
                source_conversation_key: sourceKey,
                canonical_conversation_id: canonicalId,
                source_file_id: item.sourceFileId,
                source_account_id: bundle.accountId,
                source_export_id: bundle.exportId,
                source_file: item.sourceFile,
                node_id: nodeId,
                native_message_id: typeof rawMessage?.id === "string" ? rawMessage.id : null,
                parent_id: typeof node.parent === "string" ? node.parent : null,
                create_time: rawMessage?.create_time !== undefined ? String(rawMessage.create_time) : null,
                update_time: rawMessage?.update_time !== undefined ? String(rawMessage.update_time) : null,
                raw_payload_hash: sha256Hex(rawNodeJson),
                raw_json: rawNodeJson,
                ingestion_version: bundle.ingestionVersion,
                verification_state: verification
            });
            const children = Array.isArray(node.children)
                ? node.children.filter((value: any): value is string => typeof value === "string")
                : [];
            for (const childNodeId of children) {
                edges.push({
                    source_conversation_key: sourceKey,
                    canonical_conversation_id: canonicalId,
                    parent_node_id: nodeId,
                    child_node_id: childNodeId
                });
            }
        }
    }

    const conversations = [...canonicalRows.values()]
        .map(({ __sourceKey: _sourceKey, ...row }) => row)
        .sort((a, b) => a.canonical_conversation_id.localeCompare(b.canonical_conversation_id));

    return {
        accounts: [{ account_id: bundle.accountId, label: bundle.accountLabel || null }],
        exports: [{
            export_id: bundle.exportId,
            account_id: bundle.accountId,
            export_timestamp: bundle.exportTimestamp || null,
            raw_location: bundle.rawLocation,
            zip_sha256: bundle.zipSha256.toLowerCase(),
            ingestion_version: bundle.ingestionVersion,
            verification_state: errors.length ? "PARTIAL" : "VERIFIED"
        }],
        source_files: bundle.sourceFiles.map(source => ({
            source_file_id: source.sourceFileId,
            export_id: bundle.exportId,
            source_file: source.sourceFile,
            sha256: source.sha256.toLowerCase(),
            size_bytes: source.sizeBytes ?? null,
            original_json: source.originalJson ?? null
        })),
        conversations,
        conversation_sources: conversationSources.sort((a, b) =>
            a.source_conversation_key.localeCompare(b.source_conversation_key)
        ),
        messages: messages.sort((a, b) => a.message_key.localeCompare(b.message_key)),
        message_edges: edges.sort((a, b) =>
            a.source_conversation_key.localeCompare(b.source_conversation_key)
            || a.parent_node_id.localeCompare(b.parent_node_id)
            || a.child_node_id.localeCompare(b.child_node_id)
        ),
        errors: errors.sort((a, b) => a.error_id.localeCompare(b.error_id))
    };
}
