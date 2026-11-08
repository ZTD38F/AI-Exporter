import { repairSourceVersions } from './sourceVersions.js';
import { upgradeReleasedV17 } from './releasedV17.js';
import { readAccountRegistry } from '../l2/accountRegistry.js';
import { restoreConversationIndex } from '../l2/conversationIndex.js';
import { conversationKey } from '../l2/conversationKey.js';
import type { ExportRecord, ExportFormat } from '../application/export/types.js';
import type { GlobalSettings } from '../application/settings/index.js';
import { putAccount, putIndexes, putExportRecord, patchStoredSettings, setDirectoryHandle } from '../l3a/storageService.js';

const INITIALIZED = 'gemini_exporter_v2_initialized';
const DOMAIN_DB = 'gemini_exporter_domain';
const HANDLE_DB = 'gemini_exporter_idb';
const preferenceKeys = ['gemini_export_format', 'gemini_dev_mode',
    'gemini_exporter_lang', 'gemini_export_badge_pos', 'live_save_config',
    'last_seen_feature_version', 'has_completed_takeout_prompt', 'has_imported_takeout'];
let pending: Promise<void> | undefined;

/** Background/Service Worker only. Runtime must await this before opening v2 business access.
 * Lifecycle initialization (including previousVersion) remains Runtime's responsibility.
 */
export function ensureUpgraded(): Promise<void> {
    if (!pending) pending = upgrade().finally(() => { pending = undefined; });
    return pending;
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function format(value: unknown): value is ExportFormat {
    return value === 'markdown' || value === 'html' || value === 'json' || value === 'pdf';
}
function time(value: unknown): number | undefined {
    // v1 numeric fields (including numeric strings) declare milliseconds. Never guess seconds.
    const millis = typeof value === 'number' ? value
        : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value)
        : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
    return Number.isSafeInteger(millis) && Math.abs(millis) <= 8.64e15 ? millis : undefined;
}
function exportRecord(value: unknown): ExportRecord | undefined {
    if (!object(value) || (value.status !== 'ok' && value.status !== 'partial') || !format(value.format)) return;
    const exportedAt = time(value.exportedAt);
    if (exportedAt === undefined) return;
    return { exportedAt, format: value.format,
        status: value.status === 'partial' || value.hasFailedAssets === true || value.truncated === true
            || value.isTruncated === true || (typeof value.truncateReason === 'string' && !!value.truncateReason)
            ? 'partial' : 'ok' };
}

// Only retained v2 preferences are migrated; Tour is a one-time URL intent.
function settings(raw: Record<string, unknown>): Partial<GlobalSettings> {
    const result: Partial<GlobalSettings> = {};
    if (format(raw.gemini_export_format)) result.defaultFormat = raw.gemini_export_format;
    if (typeof raw.gemini_dev_mode === 'boolean') result.developerMode = raw.gemini_dev_mode;
    if (raw.gemini_exporter_lang === 'zh' || raw.gemini_exporter_lang === 'en') result.language = raw.gemini_exporter_lang;
    const pos = raw.gemini_export_badge_pos;
    if (object(pos) && typeof pos.left === 'number' && Number.isFinite(pos.left)
        && typeof pos.top === 'number' && Number.isFinite(pos.top)) result.badgePosition = { left: pos.left, top: pos.top };
    if (object(raw.live_save_config) && typeof raw.live_save_config.enabledDisk === 'boolean') result.enabledDisk = raw.live_save_config.enabledDisk;
    if (typeof raw.last_seen_feature_version === 'string' && /^\d+(?:\.\d+){0,3}$/.test(raw.last_seen_feature_version)) {
        result.lastSeenFeatureVersion = raw.last_seen_feature_version;
    }
    if (raw.has_completed_takeout_prompt === true || raw.has_imported_takeout === true) result.takeoutPromptCompleted = true;
    return result;
}

/** Only called for a name reported by databases(); never probe by creating an old DB. */
async function readOld<T>(name: string, store: string, read: (table: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onupgradeneeded = () => { request.transaction!.abort(); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    try {
        return await new Promise<T>((resolve, reject) => {
            const tx = db.transaction(store, 'readonly');
            let value: T;
            tx.oncomplete = () => resolve(value);
            tx.onabort = () => reject(tx.error ?? new Error('Legacy read aborted'));
            const request = read(tx.objectStore(store));
            request.onsuccess = () => { value = request.result; };
        });
    } finally { db.close(); }
}

async function upgrade(): Promise<void> {
    await repairSourceVersions();
    await upgradeUuidSchema();
    // A released 1.7 profile may already carry the incomplete v2 marker.
    const raw = await chrome.storage.local.get<Record<string, unknown>>([
        'gemini_exporter_v17_migrated', 'gemini_account_slots', 'gemini_conversations'
    ]);
    if (raw.gemini_exporter_v17_migrated !== true
        && (object(raw.gemini_account_slots) || Array.isArray(raw.gemini_conversations))) {
        await upgradeReleasedV17(raw);
    }
}

async function upgradeUuidSchema(): Promise<void> {
    const marker = await chrome.storage.local.get<Record<string, unknown>>(INITIALIZED);
    if (marker[INITIALIZED] === true) return;
    const databases = new Set((await indexedDB.databases()).map(db => db.name));
    const accounts = readAccountRegistry(databases.has(DOMAIN_DB)
        ? await readOld<unknown[]>(DOMAIN_DB, 'accounts', table => table.getAll()) : []);
    const keys = [...preferenceKeys, ...accounts.flatMap(account => [`conversations_${account.id}`, `exported_${account.id}`])];
    const raw = await chrome.storage.local.get<Record<string, unknown>>(keys);
    const handle = databases.has(HANDLE_DB)
        ? await readOld<FileSystemDirectoryHandle | undefined>(HANDLE_DB, 'handles', table => table.get('export_dir_handle')) : undefined;
    const isUpgrade = databases.has(DOMAIN_DB) || databases.has(HANDLE_DB) || preferenceKeys.some(key => raw[key] !== undefined);
    const batches = accounts.map(account => {
        const savedList = raw[`conversations_${account.id}`];
        const list = savedList === undefined ? [] : savedList;
        if (!Array.isArray(list)) throw new TypeError('Invalid legacy index container');
        const indexes: ReturnType<typeof restoreConversationIndex>[] = [];
        const seen = new Set<string>();
        for (const [rowNumber, value] of list.entries()) {
            try {
                if (!object(value)) throw new TypeError('Invalid legacy index schema');
                const { updatedAt: _untrustedVersion, ...normalized } = value;
                for (const field of ['createdAt']) if (value[field] !== undefined) {
                    const millis = time(value[field]);
                    if (millis === undefined) throw new TypeError('Invalid legacy index schema: source time');
                    normalized[field] = millis;
                }
                const index = restoreConversationIndex(normalized);
                if (index.key.accountId !== account.id) throw new TypeError('Legacy index account mismatch');
                if (seen.has(index.key.conversationId)) throw new TypeError('Duplicate legacy index identity');
                seen.add(index.key.conversationId);
                indexes.push(index);
            } catch (error) {
                // One corrupt source row must not block valid conversations or other categories.
                if (!(error instanceof TypeError)) throw error;
                console.warn('[Migration] Ignoring unconvertible legacy index', account.id, rowNumber, error.message);
            }
        }
        const oldRecords = raw[`exported_${account.id}`];
        const records = new Map<string, ExportRecord>();
        if (oldRecords !== undefined && !object(oldRecords)) console.warn('[Migration] Invalid legacy export record container', account.id);
        if (object(oldRecords)) for (const [id, value] of Object.entries(oldRecords)) {
            // Only Gemini used the c_ alias. Prefer a valid canonical entry over its alias.
            const canonical = account.providerId === 'gemini' ? id.replace(/^c_/, '') : id;
            const record = exportRecord(value);
            if (!canonical || canonical !== canonical.trim() || !record) {
                console.warn('[Migration] Ignoring unconvertible export record', account.id, id);
                continue;
            }
            if (!records.has(canonical) || canonical === id) records.set(canonical, record);
        }
        return { account, indexes, records };
    });
    // Validate everything before the first v2 write. Stable keys make interrupted writes retryable.
    for (const { account } of batches) await putAccount(account);
    for (const { indexes } of batches) await putIndexes(indexes);
    for (const { account, records } of batches) for (const [id, record] of records) {
        await putExportRecord(conversationKey(account.id, id), record);
    }
    if (isUpgrade) await patchStoredSettings(settings(raw));
    if (handle !== undefined && handle !== null) await setDirectoryHandle(handle);
    await chrome.storage.local.set({ [INITIALIZED]: true });
}
