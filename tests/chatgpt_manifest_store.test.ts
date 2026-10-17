export {};
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    buildDeletionManifestDraft,
    evaluateLosslessDeleteGate,
    verifyDeletionManifest
} = require("../src/ops/chatgptArchive/controlPlane.js");
const { persistAndSealDeletionManifest } = require("../src/ops/chatgptArchive/manifestStore.js");

const preBackupEvidence = {
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
    deletionManifestBackupVerified: false,
    liveConversationUniquelyMatched: true
};

function draft() {
    const gate = evaluateLosslessDeleteGate(preBackupEvidence);
    return buildDeletionManifestDraft({
        manifestId: "manifest-persist-test",
        generationTimestamp: "2026-09-24T20:00:00.000Z",
        softwareVersion: "test",
        sourceExportHashes: ["a".repeat(64)],
        liveInventorySnapshotHash: "b".repeat(64),
        items: [{
            accountId: "a1",
            canonicalConversationId: "cc1",
            nativeConversationId: "c1",
            url: "https://chatgpt.com/c/c1",
            title: "Duplicate",
            classification: "DELETE_EXACT_DUPLICATE",
            reasonCodes: ["EXACT_DUPLICATE"],
            identityConfidence: 1,
            deletionConfidence: 1,
            rawExportLocation: "/raw/export.zip",
            rawHash: "a".repeat(64),
            knowledgeExtractionState: "VERIFIED",
            knowledgeUnitsPreserved: 10,
            uniqueInformationRemaining: 0,
            attachmentsState: "NONE",
            dependencies: [],
            gateResults: gate.gateResults,
            safeToDelete: false,
            plannedAction: "DELETE"
        }]
    });
}

test("manifest store - durable draft backup is verified before sealed manifest exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-exporter-manifest-"));
    const first = await persistAndSealDeletionManifest(root, draft());

    assert.ok(fs.existsSync(first.draftPath));
    assert.ok(fs.existsSync(first.sealedPath));
    assert.match(first.draftFileSha256, /^[a-f0-9]{64}$/);
    assert.match(first.sealedFileSha256, /^[a-f0-9]{64}$/);
    assert.strictEqual(first.manifest.state, "SEALED");
    assert.strictEqual(first.manifest.items[0].safeToDelete, true);
    assert.strictEqual(
        first.manifest.items[0].gateResults.find((gate: any) => gate.code === "L_MANIFEST_BACKUP_VERIFIED").passed,
        true
    );
    assert.strictEqual(verifyDeletionManifest(first.manifest), true);

    const second = await persistAndSealDeletionManifest(root, draft());
    assert.strictEqual(second.draftPath, first.draftPath);
    assert.strictEqual(second.sealedPath, first.sealedPath);
    assert.strictEqual(second.manifest.manifestSha256, first.manifest.manifestSha256);
});

test("manifest store - existing artifact with different bytes is never overwritten", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-exporter-manifest-conflict-"));
    const candidate = draft();
    const first = await persistAndSealDeletionManifest(root, candidate);
    fs.writeFileSync(first.draftPath, "{\"tampered\":true}", "utf8");

    await assert.rejects(
        () => persistAndSealDeletionManifest(root, candidate),
        /already exists with different content/
    );
});
