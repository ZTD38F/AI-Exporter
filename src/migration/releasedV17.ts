import { getOrCreateAccount } from '../l2/accountAdmission.js';
import { conversationKey } from '../l2/conversationKey.js';
import { restoreConversationIndex } from '../l2/conversationIndex.js';
import type { DomainConversationIndex } from '../l2/conversationIndex.js';
import type { ExportRecord } from '../application/export/types.js';
import { listAccounts, getIndex, putIndexes, getExportRecord, putExportRecord } from '../l3a/storageService.js';

const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
function time(value: unknown): number | undefined {
    const n = typeof value === 'number' ? value : typeof value === 'string'
        ? (/^-?\d+$/.test(value) ? Number(value)
            : /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN) : NaN;
    return Number.isSafeInteger(n) && Math.abs(n) <= 8.64e15 ? n : undefined;
}
function exportRecord(value: unknown): ExportRecord | undefined {
    if (!object(value) || (value.status !== 'ok' && value.status !== 'partial')) return;
    const format = value.format === 'md' ? 'markdown' : value.format === 'json_native' ? 'json' : value.format;
    if (format !== 'markdown' && format !== 'html' && format !== 'pdf' && format !== 'json') return;
    const exportedAt = time(value.exportedAt);
    if (exportedAt === undefined) return;
    return { exportedAt, format,
        status: value.status === 'partial' || value.hasFailedAssets === true || value.truncated === true
            || value.isTruncated === true || !!value.truncateReason ? 'partial' : 'ok' };
}

/** Released 1.7 used slot lists, not the later UUID schema. Bodies and coverage are refetched.
 * A separate one-time marker repairs profiles incorrectly marked initialized by earlier v2 builds.
 * Existing v2 facts win; retaining old sources must not resurrect records after local cleanup.
 */
export async function upgradeReleasedV17(initial: Record<string, unknown>): Promise<void> {
    const slots = object(initial.gemini_account_slots) ? initial.gemini_account_slots : {};
    const names = new Set(Object.keys(slots).filter(slot => /^u\d+$/.test(slot)));
    if (Array.isArray(initial.gemini_conversations)) names.add('u0');
    for (const slot of names) {
        const profile = object(slots[slot]) ? slots[slot] : {};
        const suffix = slot === 'u0' ? '' : '_' + slot;
        const listKey = 'gemini_conversations' + suffix;
        const recordKey = slot === 'u0' ? 'exportedIds' : 'gemini_exported_' + slot;
        const raw = await chrome.storage.local.get<Record<string, unknown>>([listKey, recordKey]);
        const rows = raw[listKey] ?? [];
        if (!Array.isArray(rows)) throw new TypeError('Invalid released 1.7 index container: ' + slot);
        const records = object(raw[recordKey]) ? raw[recordKey] : {};
        if (!rows.length && !Object.keys(records).length) continue;
        const subject = string(profile.accountId);
        const email = string(profile.email)?.toLowerCase() ?? (subject?.includes('@') ? subject.toLowerCase() : undefined);
        // Keep unverified slot identities separate. Never interpret u0/u1 as Google identities.
        const providerAccountId = subject && /^\d+$/.test(subject) ? subject
            : email ? 'legacy-email:' + email : 'legacy-slot:' + slot;
        const current = (await listAccounts()).filter(account => account.providerId === 'gemini');
        const emailMatches = providerAccountId.startsWith('legacy-email:')
            ? current.filter(account => /^\d+$/.test(account.providerAccountId) && account.email?.toLowerCase() === email) : [];
        const existing = current.find(account => account.providerAccountId === providerAccountId)
            ?? (emailMatches.length === 1 ? emailMatches[0] : undefined);
        const account = existing ?? await getOrCreateAccount('gemini', providerAccountId, email,
            string(profile.name) ?? `Gemini (${slot})`);
        const indexes: DomainConversationIndex[] = [];
        const seen = new Set<string>();
        for (const row of rows) {
            if (!object(row)) continue;
            const id = string(row.id)?.replace(/^c_/, '');
            if (!id || seen.has(id) || row.accountSlot !== undefined && row.accountSlot !== slot) continue;
            seen.add(id);
            const key = conversationKey(account.id, id);
            if (await getIndex(key)) continue;
            const title = string(row.title);
            const titleSource = row.titleSource === 'user' ? 'user'
                : row.titleSource === 'rpc' || row.titleSource === 'dom' || row.titleSource === 'provider'
                ? 'provider' : 'derived';
            const createdAt = time(row.createdAt);
            indexes.push(restoreConversationIndex({ key, ...(title ? { title, titleSource } : {}),
                ...(createdAt === undefined ? {} : { createdAt }) }));
        }
        await putIndexes(indexes);
        // Prefer canonical entries over c_ aliases, regardless of object insertion order.
        for (const [id, value] of Object.entries(records).sort(([a], [b]) => Number(a.startsWith('c_')) - Number(b.startsWith('c_')))) {
            const canonical = id.replace(/^c_/, '');
            const record = exportRecord(value);
            if (!canonical || canonical !== canonical.trim() || !record) continue;
            const key = conversationKey(account.id, canonical);
            if (!await getExportRecord(key)) await putExportRecord(key, record);
        }
    }
    await chrome.storage.local.set({ gemini_exporter_v17_migrated: true });
}
