import { sha256Hex, stableJson, type VerificationState } from "./controlPlane.js";

export type KnowledgeType =
    | "PERSON" | "PROJECT" | "SYSTEM" | "SERVICE" | "ACCOUNT" | "DEVICE"
    | "SERVER" | "DOMAIN" | "REPOSITORY" | "FILE" | "DOCUMENT" | "FOLDER"
    | "APPLICATION" | "PLUGIN" | "CONNECTOR" | "AUTOMATION" | "WORKFLOW"
    | "PROCEDURE" | "DECISION" | "PREFERENCE" | "CONSTRAINT" | "REQUIREMENT"
    | "TASK" | "TODO" | "BUG" | "FIX" | "REGRESSION" | "IDEA" | "PLAN"
    | "EVENT" | "DATE" | "PLACE" | "ORGANIZATION" | "ROLE" | "CONTACT"
    | "CONFIGURATION" | "COMMAND" | "CODE_COMPONENT" | "DEPENDENCY"
    | "CREDENTIAL_REFERENCE" | "RESOURCE" | "LESSON" | "NEGATIVE_KNOWLEDGE"
    | "HISTORICAL_STATE" | "CURRENT_STATE";

export type KnowledgeRelation =
    | "EXACT_DUPLICATE" | "NEAR_DUPLICATE" | "SEMANTIC_DUPLICATE"
    | "SUPERSET" | "SUBSET" | "CONTINUATION" | "SUPERSEDED_VERSION"
    | "CONTRADICTORY_VERSION" | "INDEPENDENT";

export interface KnowledgeSourceEvidence {
    accountId: string;
    canonicalConversationId: string;
    messageKey?: string | null;
    sourceTimestamp?: string | null;
    supportingEvidence: string[];
}

export interface KnowledgeCandidate {
    type: KnowledgeType;
    canonicalName: string;
    aliases?: string[];
    statement: string;
    status: string;
    validFrom?: string | null;
    validTo?: string | null;
    confidence: number;
    currentOrHistorical: "CURRENT" | "HISTORICAL";
    importance?: number;
    uniqueness?: number;
    verificationState: VerificationState;
    source: KnowledgeSourceEvidence;
    credentialRequired?: boolean;
    credentialSource?: string | null;
    relationHints?: Array<{
        relation: Exclude<KnowledgeRelation, "EXACT_DUPLICATE" | "SUBSET" | "SUPERSET" | "INDEPENDENT">;
        targetKnowledgeId: string;
        evidence: string[];
    }>;
}

export interface KnowledgeUnit {
    knowledgeId: string;
    type: KnowledgeType;
    canonicalName: string;
    aliases: string[];
    statement: string;
    status: string;
    validFrom: string | null;
    validTo: string | null;
    confidence: number;
    currentOrHistorical: "CURRENT" | "HISTORICAL";
    importance: number;
    uniqueness: number;
    verificationState: VerificationState;
    credentialRequired: boolean;
    credentialSource: string | null;
    sources: KnowledgeSourceEvidence[];
    supersedes: string[];
    supersededBy: string[];
    contradicts: string[];
    relatedTo: string[];
    duplicateOf: string[];
}

export interface KnowledgeEdge {
    fromKnowledgeId: string;
    relation: KnowledgeRelation;
    toKnowledgeId: string;
    evidence: string[];
}

export interface KnowledgeMapSnapshot {
    units: KnowledgeUnit[];
    edges: KnowledgeEdge[];
    exactDeduplicatedCount: number;
}

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
    { name: "OPENAI_KEY", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
    { name: "BEARER", pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi },
    { name: "PASSWORD_ASSIGNMENT", pattern: /\b(password|passwd|pwd)\s*[:=]\s*([^\s,;]+)/gi },
    { name: "PRIVATE_KEY", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g }
];

function normalizeWhitespace(value: string): string {
    return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function normalizedComparisonText(value: string): string {
    return normalizeWhitespace(value).toLocaleLowerCase("en-US");
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

export function redactSecrets(value: string): {
    redacted: string;
    credentialRequired: boolean;
    detectedKinds: string[];
} {
    let redacted = value;
    const detectedKinds: string[] = [];
    for (const item of SECRET_PATTERNS) {
        item.pattern.lastIndex = 0;
        if (!item.pattern.test(redacted)) continue;
        detectedKinds.push(item.name);
        item.pattern.lastIndex = 0;
        redacted = redacted.replace(item.pattern, (_match, key) =>
            item.name === "PASSWORD_ASSIGNMENT" && key ? String(key) + "=<redacted>" : "<redacted-secret>"
        );
    }
    return {
        redacted,
        credentialRequired: detectedKinds.length > 0,
        detectedKinds
    };
}

function stableSourceKey(source: KnowledgeSourceEvidence): string {
    return stableJson({
        accountId: source.accountId,
        canonicalConversationId: source.canonicalConversationId,
        messageKey: source.messageKey || null,
        sourceTimestamp: source.sourceTimestamp || null
    });
}

function deterministicKnowledgeId(candidate: {
    type: KnowledgeType;
    canonicalName: string;
    statement: string;
}): string {
    return "k_" + sha256Hex(stableJson({
        type: candidate.type,
        canonicalName: normalizedComparisonText(candidate.canonicalName),
        statement: normalizedComparisonText(candidate.statement)
    })).slice(0, 32);
}

function uniqueSorted(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))].sort();
}

function mergeSources(left: KnowledgeSourceEvidence[], right: KnowledgeSourceEvidence[]): KnowledgeSourceEvidence[] {
    const byKey = new Map<string, KnowledgeSourceEvidence>();
    for (const source of [...left, ...right]) {
        const key = stableSourceKey(source);
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, {
                ...source,
                supportingEvidence: uniqueSorted(source.supportingEvidence || [])
            });
        } else {
            existing.supportingEvidence = uniqueSorted([
                ...existing.supportingEvidence,
                ...(source.supportingEvidence || [])
            ]);
        }
    }
    return [...byKey.values()].sort((a, b) => stableSourceKey(a).localeCompare(stableSourceKey(b)));
}

function evidenceKey(edge: KnowledgeEdge): string {
    return [edge.fromKnowledgeId, edge.relation, edge.toKnowledgeId].join("\0");
}

export class KnowledgeMapBuilder {
    private readonly units = new Map<string, KnowledgeUnit>();
    private readonly edges = new Map<string, KnowledgeEdge>();
    private exactDeduplicatedCount = 0;

    add(candidate: KnowledgeCandidate): KnowledgeUnit {
        if (!candidate.canonicalName.trim() || !candidate.statement.trim()) {
            throw new Error("Knowledge candidate requires canonicalName and statement");
        }
        if (!candidate.source.accountId || !candidate.source.canonicalConversationId) {
            throw new Error("Knowledge candidate provenance is incomplete");
        }

        const nameSecret = redactSecrets(candidate.canonicalName);
        const statementSecret = redactSecrets(candidate.statement);
        const aliasResults = (candidate.aliases || []).map(alias => redactSecrets(alias));
        const sanitized = {
            ...candidate,
            canonicalName: normalizeWhitespace(nameSecret.redacted),
            statement: normalizeWhitespace(statementSecret.redacted),
            aliases: uniqueSorted(aliasResults.map(result => normalizeWhitespace(result.redacted))),
            credentialRequired: Boolean(
                candidate.credentialRequired
                || nameSecret.credentialRequired
                || statementSecret.credentialRequired
                || aliasResults.some(result => result.credentialRequired)
            )
        };

        const id = deterministicKnowledgeId(sanitized);
        const existing = this.units.get(id);
        if (existing) {
            existing.aliases = uniqueSorted([...existing.aliases, ...(sanitized.aliases || [])]);
            existing.sources = mergeSources(existing.sources, [sanitized.source]);
            existing.confidence = Math.max(existing.confidence, clamp01(sanitized.confidence));
            existing.importance = Math.max(existing.importance, clamp01(sanitized.importance ?? 0));
            existing.uniqueness = Math.max(existing.uniqueness, clamp01(sanitized.uniqueness ?? 0));
            existing.credentialRequired = existing.credentialRequired || sanitized.credentialRequired;
            if (!existing.credentialSource && sanitized.credentialSource) existing.credentialSource = sanitized.credentialSource;
            this.exactDeduplicatedCount++;
            this.addHints(id, sanitized.relationHints || []);
            return existing;
        }

        const unit: KnowledgeUnit = {
            knowledgeId: id,
            type: sanitized.type,
            canonicalName: sanitized.canonicalName,
            aliases: sanitized.aliases || [],
            statement: sanitized.statement,
            status: sanitized.status,
            validFrom: sanitized.validFrom || null,
            validTo: sanitized.validTo || null,
            confidence: clamp01(sanitized.confidence),
            currentOrHistorical: sanitized.currentOrHistorical,
            importance: clamp01(sanitized.importance ?? 0),
            uniqueness: clamp01(sanitized.uniqueness ?? 0),
            verificationState: sanitized.verificationState,
            credentialRequired: sanitized.credentialRequired,
            credentialSource: sanitized.credentialSource || null,
            sources: mergeSources([], [sanitized.source]),
            supersedes: [],
            supersededBy: [],
            contradicts: [],
            relatedTo: [],
            duplicateOf: []
        };
        this.units.set(id, unit);

        this.addDeterministicRelations(unit);
        this.addHints(id, sanitized.relationHints || []);
        return unit;
    }

    private addDeterministicRelations(unit: KnowledgeUnit): void {
        const text = normalizedComparisonText(unit.statement);
        if (!text) return;
        for (const other of this.units.values()) {
            if (other.knowledgeId === unit.knowledgeId || other.type !== unit.type) continue;
            if (normalizedComparisonText(other.canonicalName) !== normalizedComparisonText(unit.canonicalName)) continue;
            const otherText = normalizedComparisonText(other.statement);
            if (text === otherText) continue;
            if (text.includes(otherText) && otherText.length >= 20) {
                this.addEdge(unit.knowledgeId, "SUPERSET", other.knowledgeId, ["deterministic_text_containment"]);
                this.addEdge(other.knowledgeId, "SUBSET", unit.knowledgeId, ["deterministic_text_containment"]);
            } else if (otherText.includes(text) && text.length >= 20) {
                this.addEdge(unit.knowledgeId, "SUBSET", other.knowledgeId, ["deterministic_text_containment"]);
                this.addEdge(other.knowledgeId, "SUPERSET", unit.knowledgeId, ["deterministic_text_containment"]);
            }
        }
    }

    private addHints(sourceId: string, hints: NonNullable<KnowledgeCandidate["relationHints"]>): void {
        for (const hint of hints) {
            if (!hint.targetKnowledgeId || hint.targetKnowledgeId === sourceId) continue;
            if (!hint.evidence?.length) throw new Error("Non-deterministic knowledge relation requires evidence");
            this.addEdge(sourceId, hint.relation, hint.targetKnowledgeId, hint.evidence);
        }
    }

    addEdge(from: string, relation: KnowledgeRelation, to: string, evidence: string[]): void {
        if (!evidence.length) throw new Error("Knowledge edge requires evidence");
        const edge: KnowledgeEdge = {
            fromKnowledgeId: from,
            relation,
            toKnowledgeId: to,
            evidence: uniqueSorted(evidence)
        };
        const key = evidenceKey(edge);
        const existing = this.edges.get(key);
        if (existing) {
            existing.evidence = uniqueSorted([...existing.evidence, ...edge.evidence]);
        } else {
            this.edges.set(key, edge);
        }

        const source = this.units.get(from);
        const target = this.units.get(to);
        if (!source) return;
        if (relation === "SUPERSEDED_VERSION") {
            source.supersedes = uniqueSorted([...source.supersedes, to]);
            if (target) target.supersededBy = uniqueSorted([...target.supersededBy, from]);
        } else if (relation === "CONTRADICTORY_VERSION") {
            source.contradicts = uniqueSorted([...source.contradicts, to]);
            if (target) target.contradicts = uniqueSorted([...target.contradicts, from]);
        } else if (relation === "SEMANTIC_DUPLICATE" || relation === "NEAR_DUPLICATE" || relation === "EXACT_DUPLICATE") {
            source.duplicateOf = uniqueSorted([...source.duplicateOf, to]);
        } else if (!["SUBSET", "SUPERSET"].includes(relation)) {
            source.relatedTo = uniqueSorted([...source.relatedTo, to]);
        }
    }

    resolveCurrent(knowledgeId: string): KnowledgeUnit[] {
        const start = this.units.get(knowledgeId);
        if (!start) return [];
        const visited = new Set<string>();
        const frontier = [knowledgeId];
        const terminal: KnowledgeUnit[] = [];

        while (frontier.length) {
            const id = frontier.shift()!;
            if (visited.has(id)) continue;
            visited.add(id);
            const unit = this.units.get(id);
            if (!unit) continue;
            if (!unit.supersededBy.length) terminal.push(unit);
            else frontier.push(...unit.supersededBy);
        }
        return terminal.sort((a, b) => a.knowledgeId.localeCompare(b.knowledgeId));
    }

    snapshot(): KnowledgeMapSnapshot {
        return {
            units: [...this.units.values()].sort((a, b) => a.knowledgeId.localeCompare(b.knowledgeId)),
            edges: [...this.edges.values()].sort((a, b) => evidenceKey(a).localeCompare(evidenceKey(b))),
            exactDeduplicatedCount: this.exactDeduplicatedCount
        };
    }
}

export function knowledgeSnapshotToSqliteRows(snapshot: KnowledgeMapSnapshot): {
    knowledge_units: any[];
    knowledge_sources: any[];
    knowledge_edges: any[];
} {
    const knowledge_units = snapshot.units.map(unit => ({
        knowledge_id: unit.knowledgeId,
        type: unit.type,
        canonical_name: unit.canonicalName,
        aliases: unit.aliases,
        statement: unit.statement,
        status: unit.status,
        valid_from: unit.validFrom,
        valid_to: unit.validTo,
        confidence: unit.confidence,
        current_or_historical: unit.currentOrHistorical,
        importance: unit.importance,
        uniqueness: unit.uniqueness,
        verification_state: unit.verificationState,
        credential_required: unit.credentialRequired,
        credential_source: unit.credentialSource
    }));
    const knowledge_sources = snapshot.units.flatMap(unit =>
        unit.sources.map(source => ({
            knowledge_id: unit.knowledgeId,
            account_id: source.accountId,
            canonical_conversation_id: source.canonicalConversationId,
            message_key: source.messageKey || null,
            source_timestamp: source.sourceTimestamp || null,
            supporting_evidence: source.supportingEvidence
        }))
    );
    const knowledge_edges = snapshot.edges.map(edge => ({
        from_knowledge_id: edge.fromKnowledgeId,
        relation: edge.relation,
        to_knowledge_id: edge.toKnowledgeId,
        evidence: edge.evidence
    }));
    return { knowledge_units, knowledge_sources, knowledge_edges };
}
