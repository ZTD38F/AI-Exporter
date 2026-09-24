export {};
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
    buildDeletionManifest,
    buildDeletionManifestDraft,
    sealDeletionManifest,
    verifyDeletionManifestDraft,
    canonicalConversationIdFor,
    classifyConversationRetention,
    evaluateLosslessDeleteGate,
    nativeConversationIdFromUrl,
    reconcileConversations,
    resolveConversationIdentity,
    verifyDeletionManifest
} = require("../src/ops/chatgptArchive/controlPlane.js");
const {
    emptyResumeState,
    mergeSidebarObservation,
    sanitizeBrowserlessEndpointForLogs
} = require("../src/ops/chatgptArchive/browserlessAdapter.js");

const allGates = {
    rawExportExists: true,
    rawSourceHashVerified: true,
    conversationParsed: true,
    messageGraphComplete: true,
    attachmentsPreservedOrExplicitlyUnavailable: true,
    knowledgeExtractionComplete: true,
    uniqueKnowledgePreserved: true,
    provenanceRoundTripVerified: true,
    notSoleCriticalSource: true,
    noIdentityAmbiguity: true,
    noParsingFailure: true,
    deletionManifestBackupVerified: true,
    liveConversationUniquelyMatched: true
};

test("identity - exact native id wins even when titles changed", () => {
    const left = { accountId: "a1", nativeConversationId: "conv-1", title: "Old title" };
    const right = { accountId: "a1", nativeConversationId: "conv-1", title: "Renamed" };
    const result = resolveConversationIdentity(left, right);
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.confidence, 1);
    assert.strictEqual(result.deletionGrade, true);
    assert.strictEqual(result.identityEvidence[0].method, "NATIVE_ID");
    assert.strictEqual(result.canonicalConversationId, canonicalConversationIdFor(left));
});

test("identity - same title is never sufficient and accounts never cross", () => {
    const sameTitle = resolveConversationIdentity(
        { accountId: "a1", title: "Project" },
        { accountId: "a1", title: "Project" }
    );
    assert.strictEqual(sameTitle.matched, false);
    assert.strictEqual(sameTitle.deletionGrade, false);
    assert.strictEqual(sameTitle.identityEvidence[0].method, "TITLE_ONLY");

    const crossAccount = resolveConversationIdentity(
        { accountId: "a1", nativeConversationId: "same" },
        { accountId: "a2", nativeConversationId: "same" }
    );
    assert.strictEqual(crossAccount.matched, false);
    assert.strictEqual(crossAccount.identityEvidence[0].method, "ACCOUNT_MISMATCH");
});

test("lossless gate - any failed requirement fails closed", () => {
    const ok = evaluateLosslessDeleteGate(allGates);
    assert.strictEqual(ok.safeToDelete, true);
    const blocked = evaluateLosslessDeleteGate({ ...allGates, messageGraphComplete: false });
    assert.strictEqual(blocked.safeToDelete, false);
    assert.ok(blocked.blockingConditions.includes("D_MESSAGE_GRAPH_COMPLETE"));
});

test("classification - one unique fact prevents deletion of an otherwise duplicate chat", () => {
    const gate = evaluateLosslessDeleteGate(allGates);
    const base = {
        uniqueKnowledgeCount: 0,
        uniqueFactCount: 1,
        uniqueArtifactCount: 0,
        uniqueDecisionCount: 0,
        uniqueProcedureCount: 0,
        uniqueCodeCount: 0,
        uniqueAttachmentCount: 0,
        historicalValue: false,
        currentOperationalValue: false,
        reproducibilityValue: false,
        redundancyRatio: 0.99,
        supersededRatio: 0,
        noiseRatio: 0,
        recoverability: 1,
        exportIntegrity: "VERIFIED",
        knowledgeExtractionCoverage: 1,
        messageCount: 100,
        exactDuplicateOf: "cc_other"
    };
    const decision = classifyConversationRetention(base, gate);
    assert.strictEqual(decision.classification, "KEEP_UNIQUE");
    assert.strictEqual(decision.safeToDelete, false);
});

test("classification - exact duplicate is deletable only after all gates pass", () => {
    const value = {
        uniqueKnowledgeCount: 0,
        uniqueFactCount: 0,
        uniqueArtifactCount: 0,
        uniqueDecisionCount: 0,
        uniqueProcedureCount: 0,
        uniqueCodeCount: 0,
        uniqueAttachmentCount: 0,
        historicalValue: false,
        currentOperationalValue: false,
        reproducibilityValue: false,
        redundancyRatio: 1,
        supersededRatio: 0,
        noiseRatio: 0,
        recoverability: 1,
        exportIntegrity: "VERIFIED",
        knowledgeExtractionCoverage: 1,
        messageCount: 10,
        exactDuplicateOf: "cc_original"
    };
    const allowed = classifyConversationRetention(value, evaluateLosslessDeleteGate(allGates));
    assert.strictEqual(allowed.classification, "DELETE_EXACT_DUPLICATE");
    assert.strictEqual(allowed.safeToDelete, true);

    const denied = classifyConversationRetention(
        value,
        evaluateLosslessDeleteGate({ ...allGates, rawSourceHashVerified: false })
    );
    assert.strictEqual(denied.classification, "REVIEW_REQUIRED");
    assert.strictEqual(denied.safeToDelete, false);
});

test("reconciliation - exact ids match, rename is preserved, live/export-only remain explicit", () => {
    const rows = reconcileConversations(
        [
            { accountId: "a1", sourceExportId: "e1", nativeConversationId: "c1", title: "Old" },
            { accountId: "a1", sourceExportId: "e1", nativeConversationId: "c2", title: "Export only" }
        ],
        [
            { accountId: "a1", nativeConversationId: "c1", url: "https://chatgpt.com/c/c1", title: "New" },
            { accountId: "a1", nativeConversationId: "c3", url: "https://chatgpt.com/c/c3", title: "Live only" }
        ]
    );
    assert.strictEqual(rows.find((row: any) => row.liveNativeId === "c1").status, "MOVED_RENAMED");
    assert.strictEqual(rows.find((row: any) => row.exportNativeId === "c2").status, "EXPORT_ONLY");
    assert.strictEqual(rows.find((row: any) => row.liveNativeId === "c3").status, "LIVE_ONLY");
});

test("manifest - unsafe candidates are rejected and hash detects tampering", () => {
    const gates = evaluateLosslessDeleteGate(allGates);
    const item = {
        accountId: "a1",
        canonicalConversationId: "cc1",
        nativeConversationId: "c1",
        url: "https://chatgpt.com/c/c1",
        title: "Duplicate",
        classification: "DELETE_EXACT_DUPLICATE",
        reasonCodes: ["EXACT_DUPLICATE"],
        identityConfidence: 1,
        deletionConfidence: 1,
        rawExportLocation: "/evidence/export.zip",
        rawHash: "a".repeat(64),
        knowledgeExtractionState: "VERIFIED",
        knowledgeUnitsPreserved: 4,
        uniqueInformationRemaining: 0,
        attachmentsState: "NONE",
        dependencies: [],
        gateResults: gates.gateResults,
        safeToDelete: true,
        plannedAction: "DELETE"
    };
    const manifest = buildDeletionManifest({
        manifestId: "m1",
        generationTimestamp: "2026-09-24T20:00:00.000Z",
        softwareVersion: "test",
        sourceExportHashes: ["b".repeat(64)],
        liveInventorySnapshotHash: "c".repeat(64),
        items: [item]
    });
    assert.strictEqual(verifyDeletionManifest(manifest), true);
    const tampered = JSON.parse(JSON.stringify(manifest));
    tampered.items[0].nativeConversationId = "other";
    assert.strictEqual(verifyDeletionManifest(tampered), false);

    assert.throws(() => buildDeletionManifest({
        manifestId: "m2",
        generationTimestamp: "2026-09-24T20:00:00.000Z",
        softwareVersion: "test",
        sourceExportHashes: ["b".repeat(64)],
        liveInventorySnapshotHash: "c".repeat(64),
        items: [{ ...item, safeToDelete: false }]
    }), /safe_to_delete is inconsistent with gates/);
});


test("manifest - two-phase draft permits only backup gate pending, then seals exact draft hash", () => {
    const preBackup = evaluateLosslessDeleteGate({ ...allGates, deletionManifestBackupVerified: false });
    const item = {
        accountId: "a1",
        canonicalConversationId: "cc1",
        nativeConversationId: "c1",
        url: "https://chatgpt.com/c/c1",
        title: "Duplicate",
        classification: "DELETE_EXACT_DUPLICATE",
        reasonCodes: ["EXACT_DUPLICATE"],
        identityConfidence: 1,
        deletionConfidence: 1,
        rawExportLocation: "/evidence/export.zip",
        rawHash: "a".repeat(64),
        knowledgeExtractionState: "VERIFIED",
        knowledgeUnitsPreserved: 4,
        uniqueInformationRemaining: 0,
        attachmentsState: "NONE",
        dependencies: [],
        gateResults: preBackup.gateResults,
        safeToDelete: false,
        plannedAction: "DELETE"
    };
    const draft = buildDeletionManifestDraft({
        manifestId: "m-draft",
        generationTimestamp: "2026-09-24T20:00:00.000Z",
        softwareVersion: "test",
        sourceExportHashes: ["b".repeat(64)],
        liveInventorySnapshotHash: "c".repeat(64),
        items: [item]
    });
    assert.strictEqual(verifyDeletionManifestDraft(draft), true);
    assert.strictEqual(draft.state, "AWAITING_BACKUP_VERIFICATION");
    assert.throws(
        () => sealDeletionManifest(draft, { draftSha256: "0".repeat(64), verified: true }),
        /backup verification failed/
    );
    const sealed = sealDeletionManifest(draft, { draftSha256: draft.draftSha256, verified: true });
    assert.strictEqual(sealed.state, "SEALED");
    assert.strictEqual(sealed.items[0].safeToDelete, true);
    assert.strictEqual(verifyDeletionManifest(sealed), true);
});

test("browserless helpers - secrets are redacted and resume state deduplicates by native id", () => {
    assert.strictEqual(nativeConversationIdFromUrl("https://chatgpt.com/c/abc-123?x=1"), "abc-123");
    const safe = sanitizeBrowserlessEndpointForLogs("wss://chrome.example?token=secret&session=private&foo=bar");
    assert.ok(!safe.includes("secret"));
    assert.ok(!safe.includes("private"));
    assert.ok(safe.includes("foo=bar"));

    let state = emptyResumeState();
    state = mergeSidebarObservation(state, {
        accountId: "a1",
        url: "https://chatgpt.com/c/c1",
        nativeConversationId: "c1",
        title: "One"
    });
    state = mergeSidebarObservation(state, {
        accountId: "a1",
        url: "https://chatgpt.com/c/c1",
        nativeConversationId: "c1",
        title: "Renamed"
    });
    assert.strictEqual(Object.keys(state.seen).length, 1);
    assert.strictEqual(state.seen.c1.title, "Renamed");
});

test("sqlite control plane - schema is complete, ingest is idempotent, raw exports are immutable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-exporter-archive-"));
    const db = path.join(tmp, "archive.sqlite3");
    const payloadPath = path.join(tmp, "snapshot.json");
    const script = path.join(process.cwd(), "scripts", "chatgpt_archive_store.py");
    const python = process.platform === "win32" ? "python" : "python3";

    const init = spawnSync(python, [script, "--db", db, "init"], { encoding: "utf8" });
    assert.strictEqual(init.status, 0, init.stderr);
    const schema = JSON.parse(init.stdout);
    assert.strictEqual(schema.schema_version, 1);
    assert.strictEqual(schema.expected_tables_present, true);
    for (const table of ["accounts", "exports", "conversations", "knowledge_units", "delete_manifests", "mutation_receipts", "errors"]) {
        assert.ok(schema.tables.includes(table), table);
    }

    const snapshot = {
        accounts: [{ account_id: "a1", label: "Account 1" }],
        exports: [{
            export_id: "e1",
            account_id: "a1",
            export_timestamp: "2026-09-24T00:00:00Z",
            raw_location: "/raw/export.zip",
            zip_sha256: "a".repeat(64),
            ingestion_version: "1",
            verification_state: "VERIFIED"
        }],
        conversations: [{
            canonical_conversation_id: "cc1",
            account_id: "a1",
            native_conversation_id: "c1",
            title: "Conversation",
            verification_state: "VERIFIED"
        }],
        knowledge_units: [{
            knowledge_id: "k1",
            type: "DECISION",
            canonical_name: "Keep raw exports",
            statement: "Raw export evidence remains immutable.",
            status: "ACTIVE",
            confidence: 1,
            current_or_historical: "CURRENT",
            verification_state: "VERIFIED"
        }],
        knowledge_sources: [{
            knowledge_id: "k1",
            account_id: "a1",
            canonical_conversation_id: "cc1",
            supporting_evidence: ["c1"]
        }]
    };
    fs.writeFileSync(payloadPath, JSON.stringify(snapshot));

    for (let i = 0; i < 2; i++) {
        const ingest = spawnSync(python, [script, "--db", db, "ingest", "--json", payloadPath], { encoding: "utf8" });
        assert.strictEqual(ingest.status, 0, ingest.stderr);
    }

    const conflicting = {
        ...snapshot,
        exports: [{ ...snapshot.exports[0], zip_sha256: "b".repeat(64) }]
    };
    fs.writeFileSync(payloadPath, JSON.stringify(conflicting));
    const conflict = spawnSync(python, [script, "--db", db, "ingest", "--json", payloadPath], { encoding: "utf8" });
    assert.notStrictEqual(conflict.status, 0);
    assert.match(conflict.stderr, /immutable export conflict/);
});
