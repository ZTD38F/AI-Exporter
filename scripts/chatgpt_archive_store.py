#!/usr/bin/env python3
"""Versioned SQLite control-plane store for ChatGPT archive operations.

No credentials or browser-session material belongs in this database.
Raw exports remain immutable external evidence referenced by hash/location.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

MIGRATION_V1 = r"""
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS exports (
    export_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    export_timestamp TEXT,
    raw_location TEXT NOT NULL,
    zip_sha256 TEXT NOT NULL,
    ingestion_version TEXT NOT NULL,
    verification_state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, zip_sha256)
);

CREATE TABLE IF NOT EXISTS source_files (
    source_file_id TEXT PRIMARY KEY,
    export_id TEXT NOT NULL REFERENCES exports(export_id),
    source_file TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER,
    original_json TEXT,
    UNIQUE(export_id, source_file)
);

CREATE TABLE IF NOT EXISTS conversations (
    canonical_conversation_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    native_conversation_id TEXT,
    title TEXT,
    create_time TEXT,
    update_time TEXT,
    content_fingerprint TEXT,
    semantic_fingerprint TEXT,
    current_or_historical TEXT NOT NULL DEFAULT 'CURRENT',
    verification_state TEXT NOT NULL,
    UNIQUE(account_id, native_conversation_id)
);

CREATE TABLE IF NOT EXISTS messages (
    message_key TEXT PRIMARY KEY,
    canonical_conversation_id TEXT NOT NULL REFERENCES conversations(canonical_conversation_id),
    source_file_id TEXT REFERENCES source_files(source_file_id),
    native_message_id TEXT,
    parent_id TEXT,
    create_time TEXT,
    update_time TEXT,
    raw_payload_hash TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    ingestion_version TEXT NOT NULL,
    verification_state TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_edges (
    canonical_conversation_id TEXT NOT NULL REFERENCES conversations(canonical_conversation_id),
    parent_message_key TEXT,
    child_message_key TEXT NOT NULL,
    PRIMARY KEY(canonical_conversation_id, parent_message_key, child_message_key)
);

CREATE TABLE IF NOT EXISTS assets (
    asset_id TEXT PRIMARY KEY,
    canonical_conversation_id TEXT NOT NULL REFERENCES conversations(canonical_conversation_id),
    source_file_id TEXT REFERENCES source_files(source_file_id),
    native_ref TEXT,
    path TEXT,
    sha256 TEXT,
    availability_state TEXT NOT NULL,
    verification_state TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    project_key TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    native_project_id TEXT,
    name TEXT,
    verification_state TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_units (
    knowledge_id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    statement TEXT NOT NULL,
    status TEXT NOT NULL,
    valid_from TEXT,
    valid_to TEXT,
    confidence REAL NOT NULL,
    current_or_historical TEXT NOT NULL,
    importance REAL NOT NULL DEFAULT 0,
    uniqueness REAL NOT NULL DEFAULT 0,
    verification_state TEXT NOT NULL,
    credential_required INTEGER NOT NULL DEFAULT 0,
    credential_source TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
    knowledge_id TEXT NOT NULL REFERENCES knowledge_units(knowledge_id),
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    canonical_conversation_id TEXT NOT NULL REFERENCES conversations(canonical_conversation_id),
    message_key TEXT REFERENCES messages(message_key),
    source_timestamp TEXT,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY(knowledge_id, account_id, canonical_conversation_id, message_key)
);

CREATE TABLE IF NOT EXISTS knowledge_edges (
    from_knowledge_id TEXT NOT NULL REFERENCES knowledge_units(knowledge_id),
    relation TEXT NOT NULL,
    to_knowledge_id TEXT NOT NULL REFERENCES knowledge_units(knowledge_id),
    evidence_json TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY(from_knowledge_id, relation, to_knowledge_id)
);

CREATE TABLE IF NOT EXISTS conversation_identity (
    observation_key TEXT PRIMARY KEY,
    canonical_conversation_id TEXT NOT NULL REFERENCES conversations(canonical_conversation_id),
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    native_conversation_id TEXT,
    stable_url TEXT,
    content_fingerprint TEXT,
    semantic_fingerprint TEXT,
    identity_confidence REAL NOT NULL,
    identity_evidence_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_inventory (
    inventory_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    workspace TEXT,
    native_conversation_id TEXT,
    url TEXT,
    title TEXT,
    archive_state TEXT,
    observed_at TEXT NOT NULL,
    raw_metadata_json TEXT NOT NULL,
    verification_state TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliation (
    reconciliation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(account_id),
    canonical_conversation_id TEXT,
    export_presence INTEGER NOT NULL,
    live_presence INTEGER NOT NULL,
    export_native_id TEXT,
    live_native_id TEXT,
    identity_method TEXT,
    identity_confidence REAL NOT NULL,
    status TEXT NOT NULL,
    evidence_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retention_decisions (
    decision_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    canonical_conversation_id TEXT NOT NULL REFERENCES conversations(canonical_conversation_id),
    classification TEXT NOT NULL,
    confidence REAL NOT NULL,
    reason_codes_json TEXT NOT NULL,
    unique_information_remaining INTEGER NOT NULL,
    dependencies_json TEXT NOT NULL,
    blocking_conditions_json TEXT NOT NULL,
    safe_to_delete INTEGER NOT NULL,
    evidence_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delete_manifests (
    manifest_id TEXT PRIMARY KEY,
    manifest_sha256 TEXT NOT NULL UNIQUE,
    generation_timestamp TEXT NOT NULL,
    software_version TEXT NOT NULL,
    source_export_hashes_json TEXT NOT NULL,
    live_inventory_snapshot_hash TEXT NOT NULL,
    immutable_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delete_manifest_items (
    manifest_id TEXT NOT NULL REFERENCES delete_manifests(manifest_id),
    canonical_conversation_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    native_conversation_id TEXT NOT NULL,
    planned_action TEXT NOT NULL,
    item_json TEXT NOT NULL,
    PRIMARY KEY(manifest_id, canonical_conversation_id)
);

CREATE TABLE IF NOT EXISTS mutation_receipts (
    mutation_id TEXT PRIMARY KEY,
    manifest_id TEXT NOT NULL REFERENCES delete_manifests(manifest_id),
    canonical_conversation_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    native_conversation_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    receipt_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verification_runs (
    verification_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    account_id TEXT REFERENCES accounts(account_id),
    manifest_id TEXT REFERENCES delete_manifests(manifest_id),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    result_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS errors (
    error_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    account_id TEXT,
    canonical_conversation_id TEXT,
    type TEXT NOT NULL,
    scope TEXT NOT NULL,
    severity TEXT NOT NULL,
    retryable INTEGER NOT NULL,
    evidence_json TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    resolution_state TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversations_account_native
    ON conversations(account_id, native_conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(canonical_conversation_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_conversation
    ON knowledge_sources(canonical_conversation_id);
CREATE INDEX IF NOT EXISTS idx_live_inventory_run_account
    ON live_inventory(run_id, account_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_run
    ON reconciliation(run_id);
"""

EXPECTED_TABLES = {
    "accounts", "exports", "source_files", "conversations", "messages", "message_edges",
    "assets", "projects", "knowledge_units", "knowledge_sources", "knowledge_edges",
    "conversation_identity", "live_inventory", "reconciliation", "retention_decisions",
    "delete_manifests", "delete_manifest_items", "mutation_receipts", "verification_runs",
    "errors", "schema_migrations",
}

def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA journal_mode = WAL")
    return db

def migrate(db: sqlite3.Connection) -> None:
    with db:
        db.executescript(MIGRATION_V1)
        db.execute(
            "INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)",
            (SCHEMA_VERSION,),
        )

def schema_state(db: sqlite3.Connection) -> dict[str, Any]:
    tables = {
        row[0]
        for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    }
    versions = [row[0] for row in db.execute("SELECT version FROM schema_migrations ORDER BY version")]
    return {
        "schema_version": versions[-1] if versions else 0,
        "tables": sorted(tables),
        "expected_tables_present": EXPECTED_TABLES.issubset(tables),
    }

def _immutable_export_upsert(db: sqlite3.Connection, row: dict[str, Any]) -> None:
    existing = db.execute(
        "SELECT account_id, raw_location, zip_sha256, ingestion_version, verification_state FROM exports WHERE export_id = ?",
        (row["export_id"],),
    ).fetchone()
    signature = (
        row["account_id"],
        row["raw_location"],
        row["zip_sha256"],
        row["ingestion_version"],
        row["verification_state"],
    )
    if existing is not None and tuple(existing) != signature:
        raise ValueError(f"immutable export conflict for {row['export_id']}")
    db.execute(
        """INSERT OR IGNORE INTO exports(
            export_id, account_id, export_timestamp, raw_location, zip_sha256,
            ingestion_version, verification_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            row["export_id"], row["account_id"], row.get("export_timestamp"),
            row["raw_location"], row["zip_sha256"], row["ingestion_version"],
            row["verification_state"],
        ),
    )

def ingest_snapshot(db: sqlite3.Connection, snapshot: dict[str, Any]) -> None:
    allowed = {"accounts", "exports", "conversations", "knowledge_units", "knowledge_sources"}
    unknown = set(snapshot) - allowed
    if unknown:
        raise ValueError("unsupported snapshot keys: " + ", ".join(sorted(unknown)))

    with db:
        for row in snapshot.get("accounts", []):
            db.execute(
                "INSERT INTO accounts(account_id, label) VALUES (?, ?) "
                "ON CONFLICT(account_id) DO UPDATE SET label=excluded.label",
                (row["account_id"], row.get("label")),
            )

        for row in snapshot.get("exports", []):
            _immutable_export_upsert(db, row)

        for row in snapshot.get("conversations", []):
            db.execute(
                """INSERT INTO conversations(
                    canonical_conversation_id, account_id, native_conversation_id, title,
                    create_time, update_time, content_fingerprint, semantic_fingerprint,
                    current_or_historical, verification_state
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(canonical_conversation_id) DO UPDATE SET
                    title=excluded.title,
                    update_time=excluded.update_time,
                    content_fingerprint=COALESCE(excluded.content_fingerprint, conversations.content_fingerprint),
                    semantic_fingerprint=COALESCE(excluded.semantic_fingerprint, conversations.semantic_fingerprint),
                    current_or_historical=excluded.current_or_historical,
                    verification_state=excluded.verification_state""",
                (
                    row["canonical_conversation_id"], row["account_id"],
                    row.get("native_conversation_id"), row.get("title"),
                    row.get("create_time"), row.get("update_time"),
                    row.get("content_fingerprint"), row.get("semantic_fingerprint"),
                    row.get("current_or_historical", "CURRENT"),
                    row["verification_state"],
                ),
            )

        for row in snapshot.get("knowledge_units", []):
            db.execute(
                """INSERT INTO knowledge_units(
                    knowledge_id, type, canonical_name, aliases_json, statement, status,
                    valid_from, valid_to, confidence, current_or_historical,
                    importance, uniqueness, verification_state, credential_required, credential_source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(knowledge_id) DO UPDATE SET
                    canonical_name=excluded.canonical_name,
                    aliases_json=excluded.aliases_json,
                    statement=excluded.statement,
                    status=excluded.status,
                    valid_from=excluded.valid_from,
                    valid_to=excluded.valid_to,
                    confidence=excluded.confidence,
                    current_or_historical=excluded.current_or_historical,
                    importance=excluded.importance,
                    uniqueness=excluded.uniqueness,
                    verification_state=excluded.verification_state,
                    credential_required=excluded.credential_required,
                    credential_source=excluded.credential_source""",
                (
                    row["knowledge_id"], row["type"], row["canonical_name"],
                    json.dumps(row.get("aliases", []), ensure_ascii=False),
                    row["statement"], row["status"], row.get("valid_from"), row.get("valid_to"),
                    float(row["confidence"]), row["current_or_historical"],
                    float(row.get("importance", 0)), float(row.get("uniqueness", 0)),
                    row["verification_state"], 1 if row.get("credential_required") else 0,
                    row.get("credential_source"),
                ),
            )

        for row in snapshot.get("knowledge_sources", []):
            db.execute(
                """INSERT OR IGNORE INTO knowledge_sources(
                    knowledge_id, account_id, canonical_conversation_id, message_key,
                    source_timestamp, evidence_json
                ) VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    row["knowledge_id"], row["account_id"], row["canonical_conversation_id"],
                    row.get("message_key"), row.get("source_timestamp"),
                    json.dumps(row.get("supporting_evidence", []), ensure_ascii=False),
                ),
            )

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init")
    sub.add_parser("schema")
    ingest = sub.add_parser("ingest")
    ingest.add_argument("--json", required=True)
    args = parser.parse_args()

    db = connect(Path(args.db))
    try:
        migrate(db)
        if args.command == "init":
            print(json.dumps(schema_state(db), sort_keys=True))
            return 0
        if args.command == "schema":
            print(json.dumps(schema_state(db), sort_keys=True))
            return 0
        if args.command == "ingest":
            payload = json.loads(Path(args.json).read_text(encoding="utf-8"))
            ingest_snapshot(db, payload)
            print(json.dumps({"ok": True, **schema_state(db)}, sort_keys=True))
            return 0
    finally:
        db.close()
    return 2

if __name__ == "__main__":
    raise SystemExit(main())
