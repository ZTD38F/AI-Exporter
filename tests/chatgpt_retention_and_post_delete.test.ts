export {};
const test = require("node:test");
const assert = require("node:assert");

const { evaluateLosslessDeleteGate } = require("../src/ops/chatgptArchive/controlPlane.js");
const { KnowledgeMapBuilder } = require("../src/ops/chatgptArchive/knowledgeMap.js");
const {
    computeConversationValue,
    classifyWithTransparentValue
} = require("../src/ops/chatgptArchive/retentionModel.js");
const { verifyPostDeleteInventory } = require("../src/ops/chatgptArchive/postDeleteVerifier.js");

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

function source(conversation: string) {
    return {
        accountId: "a1",
        canonicalConversationId: conversation,
        messageKey: "m1",
        supportingEvidence: [conversation + ":m1"]
    };
}

function input(overrides: any = {}) {
    return {
        canonicalConversationId: "cc1",
        messageCount: 10,
        attachmentCount: 0,
        historicalValue: false,
        currentOperationalValue: false,
        reproducibilityValue: false,
        noiseItems: 0,
        recoverabilityChecks: [true, true, true],
        exportIntegrity: "VERIFIED",
        knowledgeExtractionCoverage: 1,
        identityConfidence: 1,
        exactDuplicateOf: null,
        explicitDisposition: null,
        ...overrides
    };
}

function manifestItem(nativeConversationId: string) {
    const gate = evaluateLosslessDeleteGate(allGates);
    return {
        accountId: "a1",
        canonicalConversationId: "cc-" + nativeConversationId,
        nativeConversationId,
        url: "https://chatgpt.com/c/" + nativeConversationId,
        title: nativeConversationId,
        classification: "DELETE_EXACT_DUPLICATE",
        reasonCodes: ["EXACT_DUPLICATE"],
        identityConfidence: 1,
        deletionConfidence: 1,
        rawExportLocation: "/raw/e.zip",
        rawHash: "a".repeat(64),
        knowledgeExtractionState: "VERIFIED",
        knowledgeUnitsPreserved: 1,
        uniqueInformationRemaining: 0,
        attachmentsState: "NONE",
        dependencies: [],
        gateResults: gate.gateResults,
        safeToDelete: true,
        plannedAction: "DELETE"
    };
}

test("retention model - unique Knowledge Unit makes deletion confidence zero", () => {
    const map = new KnowledgeMapBuilder();
    map.add({
        type: "DECISION",
        canonicalName: "Unique decision",
        statement: "Keep this exact operational decision.",
        status: "ACTIVE",
        confidence: 1,
        currentOrHistorical: "CURRENT",
        verificationState: "VERIFIED",
        source: source("cc1")
    });
    const gate = evaluateLosslessDeleteGate(allGates);
    const value = computeConversationValue(map.snapshot(), input(), gate);
    assert.strictEqual(value.uniqueDecisionCount, 1);
    assert.strictEqual(value.deletionConfidence, 0);

    const decision = classifyWithTransparentValue(map.snapshot(), input(), gate);
    assert.strictEqual(decision.classification, "KEEP_UNIQUE");
    assert.strictEqual(decision.safeToDelete, false);
    assert.ok(decision.reasonCodes.includes("UNIQUE_INFORMATION_REMAINS"));
});

test("retention model - exact duplicate can delete only with zero unique information and green gates", () => {
    const map = new KnowledgeMapBuilder();
    const gate = evaluateLosslessDeleteGate(allGates);
    const decision = classifyWithTransparentValue(
        map.snapshot(),
        input({ exactDuplicateOf: "cc-original" }),
        gate
    );
    assert.strictEqual(decision.classification, "DELETE_EXACT_DUPLICATE");
    assert.strictEqual(decision.safeToDelete, true);
    assert.strictEqual(decision.confidence, 1);

    const blockedGate = evaluateLosslessDeleteGate({ ...allGates, noIdentityAmbiguity: false });
    const blocked = classifyWithTransparentValue(
        map.snapshot(),
        input({ exactDuplicateOf: "cc-original" }),
        blockedGate
    );
    assert.strictEqual(blocked.safeToDelete, false);
    assert.strictEqual(blocked.classification, "REVIEW_REQUIRED");
});

test("retention model - incomplete knowledge coverage fails closed before deletion classes", () => {
    const map = new KnowledgeMapBuilder();
    const gate = evaluateLosslessDeleteGate(allGates);
    const decision = classifyWithTransparentValue(
        map.snapshot(),
        input({ exactDuplicateOf: "cc-original", knowledgeExtractionCoverage: 0.99 }),
        gate
    );
    assert.strictEqual(decision.classification, "KEEP_UNCERTAIN");
    assert.strictEqual(decision.safeToDelete, false);
    assert.ok(decision.reasonCodes.includes("KNOWLEDGE_EXTRACTION_INCOMPLETE"));
});

test("post-delete verifier - complete inventory proves deletes absent and KEEP present", () => {
    const result = verifyPostDeleteInventory({
        accountId: "a1",
        accountInventoryComplete: true,
        deleteItems: [manifestItem("delete-me")],
        keepNativeConversationIds: ["keep-me"],
        liveAfter: [{
            accountId: "a1",
            nativeConversationId: "keep-me",
            url: "https://chatgpt.com/c/keep-me",
            title: "Keep"
        }]
    });

    assert.strictEqual(result.deleteItems[0].status, "EXPECTED_ABSENT");
    assert.strictEqual(result.keepItems[0].status, "EXPECTED_PRESENT");
    assert.strictEqual(result.deletionsVerified, 1);
    assert.strictEqual(result.keepIntegrityFailures, 0);
});

test("post-delete verifier - missing KEEP is CRITICAL only when account inventory is complete", () => {
    const complete = verifyPostDeleteInventory({
        accountId: "a1",
        accountInventoryComplete: true,
        deleteItems: [],
        keepNativeConversationIds: ["keep-me"],
        liveAfter: []
    });
    assert.strictEqual(complete.keepItems[0].status, "MISSING");
    assert.strictEqual(complete.criticalIncidents[0].type, "KEEP_MISSING");

    const incomplete = verifyPostDeleteInventory({
        accountId: "a1",
        accountInventoryComplete: false,
        deleteItems: [],
        keepNativeConversationIds: ["keep-me"],
        liveAfter: []
    });
    assert.strictEqual(incomplete.keepItems[0].status, "UNKNOWN");
    assert.strictEqual(incomplete.criticalIncidents.length, 0);
});

test("post-delete verifier - incomplete inventory never proves deletion absence", () => {
    const result = verifyPostDeleteInventory({
        accountId: "a1",
        accountInventoryComplete: false,
        deleteItems: [manifestItem("delete-me")],
        keepNativeConversationIds: [],
        liveAfter: []
    });
    assert.strictEqual(result.deleteItems[0].status, "UNKNOWN");
    assert.strictEqual(result.deletionsVerified, 0);
});

test("post-delete verifier - cross-account evidence is rejected", () => {
    assert.throws(() => verifyPostDeleteInventory({
        accountId: "a1",
        accountInventoryComplete: true,
        deleteItems: [manifestItem("delete-me")],
        keepNativeConversationIds: [],
        liveAfter: [{
            accountId: "a2",
            nativeConversationId: "other",
            url: "https://chatgpt.com/c/other"
        }]
    }), /different account/);
});
