// Why this exists (P1-10 / P1-13): storage migrations used to be scattered
// across read paths ("migrate on touch"): getConversations fire-and-forget a
// legacy slim migration with a stale snapshot (lost-update hole across tabs),
// export-record alias collapse ran on every read, credential normalization
// ran inside loadCredMap, and IDB creation was implicit. There was no schema
// version key, so future format changes had no detection point.
//
// New contract:
// - `gemini_schema_version` in chrome.storage.local, current = 1.
// - `migrate()` runs once at startup, serially: slim / export-alias /
//   credentials / IDB, then stamps the version.
// - Unknown future version -> migrate() returns { ok:false, frozen:true } and
//   sets the SCHEMA_FROZEN flag: reads keep working, writes fail closed via
//   assertSchemaWritable() (i18n error + badge warning).
// - Read paths never migrate; they only read.

import {
    normSlot,
    getAccountSlots,
    transactConversations,
    migrateExportAliases
} from "./storageService.js";
import { migrateCredentials } from "../api/client/credentialManager.js";
import { openHandleDB } from "./idbHandleStore.js";
import { openDetailDB } from "./conversationDetailStore.js";
import { t } from "../utils/i18n.js";

export const SCHEMA_VERSION_KEY = "gemini_schema_version";
export const CURRENT_SCHEMA_VERSION = 1;

export interface SchemaMigrateResult {
    ok: boolean;
    frozen: boolean;
    error?: string;
}

export class SchemaFrozenError extends Error {
    constructor() {
        super(t("schemaFrozenWriteBlocked"));
        this.name = "SchemaFrozenError";
    }
}

let _frozen = false;

export function isSchemaFrozen(): boolean {
    return _frozen;
}

export function __setSchemaFrozenForTest(v: boolean): void {
    _frozen = v;
}

function warnSchemaFrozen(): void {
    try {
        const action = (typeof chrome !== "undefined" && (chrome as any).action) || null;
        if (action && typeof action.setBadgeText === "function") {
            action.setBadgeText({ text: "!" });
            if (typeof action.setBadgeBackgroundColor === "function") {
                action.setBadgeBackgroundColor({ color: "#C53929" });
            }
        }
    } catch {}
}

/**
 * Fail-closed write guard. Reads stay available when frozen; every write
 * funnel must call this before touching storage.
 */
export async function assertSchemaWritable(): Promise<void> {
    if (_frozen) {
        warnSchemaFrozen();
        throw new SchemaFrozenError();
    }
    // Lazy cross-context check: contexts that never ran migrate() (content
    // script, options page) still see a version stamped by a newer release.
    try {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            const data = await chrome.storage.local.get([SCHEMA_VERSION_KEY]);
            const v = data ? (data as any)[SCHEMA_VERSION_KEY] : undefined;
            if (typeof v === "number" && v > CURRENT_SCHEMA_VERSION) {
                _frozen = true;
                warnSchemaFrozen();
                throw new SchemaFrozenError();
            }
        }
    } catch (e) {
        if (e instanceof SchemaFrozenError) throw e;
        // Storage unreadable -> fail open; frozen only on positive evidence.
    }
}

async function listConversationSlots(): Promise<string[]> {
    const slots = new Set<string>(["u0"]);
    try {
        const all = (await chrome.storage.local.get(null)) as Record<string, any>;
        for (const k of Object.keys(all || {})) {
            if (k === "gemini_conversations") slots.add("u0");
            else if (k.startsWith("gemini_conversations_")) {
                const s = k.slice("gemini_conversations_".length);
                if (s) slots.add(s);
            }
        }
    } catch {}
    try {
        const acc = await getAccountSlots();
        for (const k of Object.keys(acc || {})) slots.add(normSlot(k));
    } catch {}
    return [...slots];
}

// Step 1 (P1-10): slim legacy fat conversations. The updater runs inside the
// cross-tab conversation lock on a freshly re-read list, so a concurrent
// transact can no longer be silently discarded by a stale snapshot.
// _setConversationsRaw offloads messages/turns to IndexedDB first and throws
// on IDB failure, so the slimmed write never truncates data.
async function migrateSlimConversations(): Promise<void> {
    const slots = await listConversationSlots();
    for (const slot of slots) {
        await transactConversations(slot, (list) => {
            if (!Array.isArray(list) || !list.some((c: any) => c && (Array.isArray(c.messages) || Array.isArray(c.turns)))) {
                return null;
            }
            return { list, changed: 0 };
        });
    }

    try {
        const u0Data = (await chrome.storage.local.get(['gemini_conversations_u0', 'gemini_conversations'])) as Record<string, any>;
        if (u0Data && Array.isArray(u0Data.gemini_conversations_u0)) {
            const legacy = u0Data.gemini_conversations_u0;
            if (legacy.length > 0) {
                // Decide under the conversation lock: an empty canonical array
                // is not evidence that the legacy records were already copied.
                await transactConversations('u0', (list) =>
                    list.length > 0 ? null : { list: legacy, changed: legacy.length });
            }
            await chrome.storage.local.remove('gemini_conversations_u0');
        }
    } catch (e) {
        // Keep the legacy key and withhold the schema version so startup can retry.
        throw e;
    }
}

async function migrateExportAliasesAll(): Promise<void> {
    const slots = await listConversationSlots();
    for (const slot of slots) {
        await migrateExportAliases(slot);
    }
}

async function migrateStepCredentials(): Promise<void> {
    await migrateCredentials();
}

async function migrateIdb(): Promise<void> {
    if (typeof indexedDB === "undefined") return;
    for (const open of [openHandleDB, openDetailDB] as const) {
        const db = await open();
        try { db.close(); } catch {}
    }
}

/**
 * Startup one-time migration. Serial: slim -> alias -> credentials -> IDB,
 * then stamps gemini_schema_version = 1. Idempotent; safe to call from
 * multiple contexts (cross-tab locks serialize the write steps).
 * If any step fails, the version stamp is withheld and ok: false is returned
 * so migration can be retried on next startup.
 */
export async function migrate(): Promise<SchemaMigrateResult> {
    let stored: unknown;
    try {
        const data = await chrome.storage.local.get([SCHEMA_VERSION_KEY]);
        stored = data ? (data as any)[SCHEMA_VERSION_KEY] : undefined;
    } catch {
        stored = undefined;
    }
    if (typeof stored === "number" && stored > CURRENT_SCHEMA_VERSION) {
        _frozen = true;
        warnSchemaFrozen();
        return { ok: false, frozen: true };
    }
    _frozen = false;
    const fromVersion = typeof stored === "number" && stored >= 0 ? Math.floor(stored) : 0;
    if (fromVersion < CURRENT_SCHEMA_VERSION) {
        try {
            await migrateSlimConversations();
            await migrateExportAliasesAll();
            await migrateStepCredentials();
            await migrateIdb();
            await chrome.storage.local.set({ [SCHEMA_VERSION_KEY]: CURRENT_SCHEMA_VERSION });
        } catch (e: any) {
            console.error("[SchemaMigration] Migration step failed, version stamp withheld for retry:", e);
            return { ok: false, frozen: false, error: e?.message || String(e) };
        }
    }
    return { ok: true, frozen: false };
}

let _storageReadyPromise: Promise<void> | null = null;

async function initializeStorage(): Promise<void> {
    const res = await migrate();
    if (res.frozen) {
        throw new SchemaFrozenError();
    }
    if (!res.ok) {
        throw new Error(res.error || "Storage schema migration failed");
    }
}

/**
 * Storage readiness boundary contract.
 *
 * Ensures storage schema migration has completed before any consumer operates
 * on canonical storage data.
 * - Concurrency: Concurrent callers share the same in-flight initialization.
 * - Idempotency: Later callers reuse the settled readiness state without remigrating.
 * - Failure semantics: Fails closed on migration error or schema freeze (rejects).
 */
export function ensureStorageReady(): Promise<void> {
    if (!_storageReadyPromise) {
        _storageReadyPromise = initializeStorage();
    }
    return _storageReadyPromise;
}

export function __resetStorageReadyForTest(): void {
    _storageReadyPromise = null;
    __setSchemaFrozenForTest(false);
}
