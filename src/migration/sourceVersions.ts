import { listAccounts, listIndexes, listExportRecords, putExportRecord,
    updateConversationAtomically, clearStoredAccountCoverage } from '../l3a/storageService.js';

const MARKER = 'gemini_exporter_source_versions_v1';

/** Older Gemini builds mixed Takeout activity dates with online versions without provenance.
 * Invalidate version claims once, retaining all bodies, titles and export outcomes. Runtime
 * awaits Migration before source ingestion; the marker commits only after every write.
 */
export async function repairSourceVersions(): Promise<void> {
    const flags = await chrome.storage.local.get<Record<string, unknown>>([MARKER, 'gemini_exporter_v2_initialized']);
    if (flags[MARKER] === true) return;
    if (flags.gemini_exporter_v2_initialized === true) {
        for (const account of await listAccounts()) {
            if (account.providerId !== 'gemini') continue;
            for (const index of await listIndexes(account.id)) {
                await updateConversationAtomically(index.key, (oldIndex, oldDetail) => {
                    const { updatedAt: _version, ...retainedIndex } = oldIndex ?? index;
                    // Message timestamps remain source facts and may still supply a display date.
                    const dates = oldDetail?.messages.map(message => message.timestamp)
                        .filter((timestamp): timestamp is number => Number.isSafeInteger(timestamp)) ?? [];
                    if (retainedIndex.activityAt === undefined && dates.length) retainedIndex.activityAt = Math.max(...dates);
                    const retainedDetail = oldDetail ? (({ savedAt: _savedAt, ...body }) => body)(oldDetail) : undefined;
                    return { index: retainedIndex, ...(retainedDetail ? { detail: retainedDetail } : {}), result: undefined };
                });
            }
            for (const [conversationId, record] of Object.entries(await listExportRecords(account.id))) {
                const { chatTime: _version, ...retained } = record;
                await putExportRecord({ accountId: account.id, conversationId }, retained);
            }
            // Force the next sync to walk the full list and recover authoritative times.
            await clearStoredAccountCoverage(account.id);
        }
    }
    await chrome.storage.local.set({ [MARKER]: true });
}
