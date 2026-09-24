export {};
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { buildProvenanceSnapshot } = require("../src/ops/chatgptArchive/provenanceIngest.js");

function message(id: string, role: string, text: string, time: number) {
    return {
        id,
        author: { role },
        create_time: time,
        content: { content_type: "text", parts: [text] },
        metadata: {}
    };
}

function conversation(id: string, title: string, update: number, malformed = false) {
    return {
        id,
        title,
        create_time: update - 10,
        update_time: update,
        current_node: "a1",
        mapping: {
            root: { id: "root", parent: null, children: ["u1"], message: null },
            u1: { id: "u1", parent: "root", children: ["a1"], message: message("m-u1", "user", "hello", update - 2) },
            a1: { id: "a1", parent: "u1", children: [], message: message("m-a1", "assistant", "world", update - 1) },
            ...(malformed ? { broken: "provider-drift" } : {})
        }
    };
}

function bundle(exportId: string, sourceFileId: string, sourceFile: string, raw: any, hashChar: string) {
    return {
        runId: "run-" + exportId,
        accountId: "account-a",
        accountLabel: "A",
        exportId,
        exportTimestamp: "2026-09-24T00:00:00Z",
        rawLocation: "/raw/" + exportId + ".zip",
        zipSha256: hashChar.repeat(64),
        ingestionVersion: "1",
        sourceFiles: [{
            sourceFileId,
            sourceFile,
            sha256: hashChar.repeat(64),
            sizeBytes: 123,
            originalJson: JSON.stringify([raw])
        }],
        conversations: [{
            sourceFileId,
            sourceFile,
            sourceIndex: 0,
            raw
        }]
    };
}

test("provenance ingest - same native conversation across exports keeps stable canonical id and distinct observations", () => {
    const first = buildProvenanceSnapshot(bundle(
        "export-1", "sf-1", "conversations.json",
        conversation("conv-1", "Old", 100), "a"
    ));
    const second = buildProvenanceSnapshot(bundle(
        "export-2", "sf-2", "conversations-1.json",
        conversation("conv-1", "Renamed", 200), "b"
    ));

    assert.strictEqual(first.conversations.length, 1);
    assert.strictEqual(second.conversations.length, 1);
    assert.strictEqual(
        first.conversations[0].canonical_conversation_id,
        second.conversations[0].canonical_conversation_id
    );
    assert.notStrictEqual(
        first.conversation_sources[0].source_conversation_key,
        second.conversation_sources[0].source_conversation_key
    );
    assert.notStrictEqual(first.messages[0].message_key, second.messages[0].message_key);
    assert.strictEqual(first.conversation_sources[0].raw_payload_hash.length, 64);
    assert.strictEqual(first.messages[0].raw_payload_hash.length, 64);
});

test("provenance ingest - malformed graph is PARTIAL and emits DATA_LOSS_RISK evidence", () => {
    const snapshot = buildProvenanceSnapshot(bundle(
        "export-malformed", "sf-malformed", "conversations.json",
        conversation("conv-bad", "Bad graph", 100, true), "c"
    ));

    assert.strictEqual(snapshot.exports[0].verification_state, "PARTIAL");
    assert.strictEqual(snapshot.conversations[0].verification_state, "PARTIAL");
    assert.strictEqual(snapshot.conversation_sources[0].verification_state, "PARTIAL");
    assert.ok(snapshot.errors.length >= 1);
    assert.strictEqual(snapshot.errors[0].severity, "DATA_LOSS_RISK");
    assert.ok(snapshot.errors.some((row: any) =>
        Array.isArray(row.evidence.malformedNodeIds)
        && row.evidence.malformedNodeIds.includes("broken")
    ));
    assert.ok(snapshot.messages.some((row: any) => row.node_id === "a1"));
});

test("provenance ingest - invalid or mismatched raw source evidence fails closed", () => {
    const good = bundle(
        "export-1", "sf-1", "conversations.json",
        conversation("conv-1", "Title", 100), "d"
    );
    assert.throws(
        () => buildProvenanceSnapshot({ ...good, zipSha256: "not-a-hash" }),
        /zipSha256 must be SHA-256/
    );

    const mismatch = {
        ...good,
        conversations: [{ ...good.conversations[0], sourceFile: "other.json" }]
    };
    assert.throws(() => buildProvenanceSnapshot(mismatch), /missing source evidence/);
});

test("sqlite provenance store - source observations are idempotent and immutable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-exporter-provenance-"));
    const db = path.join(tmp, "archive.sqlite3");
    const payloadPath = path.join(tmp, "snapshot.json");
    const script = path.join(process.cwd(), "scripts", "chatgpt_archive_store.py");
    const python = process.platform === "win32" ? "python" : "python3";

    const snapshot = buildProvenanceSnapshot(bundle(
        "export-db", "sf-db", "conversations.json",
        conversation("conv-db", "DB", 100), "e"
    ));
    fs.writeFileSync(payloadPath, JSON.stringify(snapshot));

    for (let i = 0; i < 2; i++) {
        const result = spawnSync(python, [script, "--db", db, "ingest", "--json", payloadPath], { encoding: "utf8" });
        assert.strictEqual(result.status, 0, result.stderr);
    }

    const query = [
        "import sqlite3,json,sys",
        "db=sqlite3.connect(sys.argv[1])",
        "tables=['exports','source_files','conversations','conversation_sources','messages','message_edges','errors']",
        "print(json.dumps({t:db.execute('select count(*) from '+t).fetchone()[0] for t in tables},sort_keys=True))"
    ].join(";");
    const countsRun = spawnSync(python, ["-c", query, db], { encoding: "utf8" });
    assert.strictEqual(countsRun.status, 0, countsRun.stderr);
    const counts = JSON.parse(countsRun.stdout);
    assert.strictEqual(counts.exports, 1);
    assert.strictEqual(counts.source_files, 1);
    assert.strictEqual(counts.conversations, 1);
    assert.strictEqual(counts.conversation_sources, 1);
    assert.strictEqual(counts.messages, 3);
    assert.strictEqual(counts.message_edges, 2);
    assert.strictEqual(counts.errors, 0);

    const tampered = JSON.parse(JSON.stringify(snapshot));
    tampered.messages[0].raw_payload_hash = "f".repeat(64);
    fs.writeFileSync(payloadPath, JSON.stringify(tampered));
    const conflict = spawnSync(python, [script, "--db", db, "ingest", "--json", payloadPath], { encoding: "utf8" });
    assert.notStrictEqual(conflict.status, 0);
    assert.match(conflict.stderr, /immutable messages conflict/);
});
