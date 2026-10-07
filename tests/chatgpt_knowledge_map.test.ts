export {};
const test = require("node:test");
const assert = require("node:assert");

const {
    KnowledgeMapBuilder,
    knowledgeSnapshotToSqliteRows,
    redactSecrets
} = require("../src/ops/chatgptArchive/knowledgeMap.js");

function source(conversation: string, messageKey = "m1") {
    return {
        accountId: "account-a",
        canonicalConversationId: conversation,
        messageKey,
        sourceTimestamp: "2026-09-24T00:00:00Z",
        supportingEvidence: [conversation + ":" + messageKey]
    };
}

function candidate(overrides: any = {}) {
    return {
        type: "DECISION",
        canonicalName: "ServerBridge architecture",
        aliases: ["ServerBridge"],
        statement: "Use a persistent service with explicit recovery state.",
        status: "ACTIVE",
        validFrom: "2026-09-24",
        validTo: null,
        confidence: 1,
        currentOrHistorical: "CURRENT",
        importance: 0.9,
        uniqueness: 0.8,
        verificationState: "VERIFIED",
        source: source("cc-a"),
        ...overrides
    };
}

test("Knowledge Map - exact duplicate merges provenance instead of duplicating knowledge", () => {
    const map = new KnowledgeMapBuilder();
    const first = map.add(candidate());
    const second = map.add(candidate({ source: source("cc-b", "m2") }));

    assert.strictEqual(first.knowledgeId, second.knowledgeId);
    const snapshot = map.snapshot();
    assert.strictEqual(snapshot.units.length, 1);
    assert.strictEqual(snapshot.units[0].sources.length, 2);
    assert.strictEqual(snapshot.exactDeduplicatedCount, 1);
});

test("Knowledge Map - deterministic subset/superset links keep both source statements", () => {
    const map = new KnowledgeMapBuilder();
    const short = map.add(candidate({
        statement: "Use a persistent service with explicit recovery state."
    }));
    const long = map.add(candidate({
        statement: "Use a persistent service with explicit recovery state. Store a durable checkpoint before restart.",
        source: source("cc-b")
    }));

    const snapshot = map.snapshot();
    assert.strictEqual(snapshot.units.length, 2);
    assert.ok(snapshot.edges.some((edge: any) =>
        edge.fromKnowledgeId === long.knowledgeId
        && edge.toKnowledgeId === short.knowledgeId
        && edge.relation === "SUPERSET"
    ));
    assert.ok(snapshot.edges.some((edge: any) =>
        edge.fromKnowledgeId === short.knowledgeId
        && edge.toKnowledgeId === long.knowledgeId
        && edge.relation === "SUBSET"
    ));
});

test("Knowledge Map - supersession is evidence-driven and current resolution follows graph", () => {
    const map = new KnowledgeMapBuilder();
    const old = map.add(candidate({
        statement: "Use the old bridge transport.",
        currentOrHistorical: "HISTORICAL",
        status: "SUPERSEDED"
    }));
    const newer = map.add(candidate({
        statement: "Use the new bridge transport with durable recovery.",
        source: source("cc-new")
    }));

    map.addEdge(
        newer.knowledgeId,
        "SUPERSEDED_VERSION",
        old.knowledgeId,
        ["explicit user decision in cc-new:m1"]
    );

    assert.deepStrictEqual(
        map.resolveCurrent(old.knowledgeId).map((unit: any) => unit.knowledgeId),
        [newer.knowledgeId]
    );
    assert.deepStrictEqual(old.supersededBy, [newer.knowledgeId]);
    assert.deepStrictEqual(newer.supersedes, [old.knowledgeId]);
});

test("Knowledge Map - non-deterministic relations require evidence", () => {
    const map = new KnowledgeMapBuilder();
    const a = map.add(candidate({ statement: "Version A" }));
    const b = map.add(candidate({ statement: "Version B", source: source("cc-b") }));
    assert.throws(
        () => map.addEdge(a.knowledgeId, "CONTRADICTORY_VERSION", b.knowledgeId, []),
        /requires evidence/
    );
});

test("Knowledge Map - secrets are redacted before canonical persistence", () => {
    const map = new KnowledgeMapBuilder();
    const unit = map.add(candidate({
        canonicalName: "API configuration",
        statement: "password=TopSecret123 and key sk-proj-ABCDEFGHIJKLMNOPQRSTUV"
    }));

    assert.strictEqual(unit.credentialRequired, true);
    assert.ok(!unit.statement.includes("TopSecret123"));
    assert.ok(!unit.statement.includes("sk-proj-"));
    assert.ok(unit.statement.includes("<redacted"));
    const rows = knowledgeSnapshotToSqliteRows(map.snapshot());
    assert.strictEqual(rows.knowledge_units[0].credential_required, true);
});

test("Knowledge Map - redaction helper reports detected secret classes without preserving values", () => {
    const result = redactSecrets("Authorization: Bearer abc.def.ghi password=hunter2");
    assert.strictEqual(result.credentialRequired, true);
    assert.ok(result.detectedKinds.includes("BEARER"));
    assert.ok(result.detectedKinds.includes("PASSWORD_ASSIGNMENT"));
    assert.ok(!result.redacted.includes("hunter2"));
    assert.ok(!result.redacted.includes("abc.def.ghi"));
});
