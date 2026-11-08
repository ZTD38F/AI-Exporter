import { notifyDomainChanged } from '../api/domainChanges.js';
import { isDirectoryHandle } from '../capabilities/directoryHandle.js';
import { getSettings, isLiveSaveEffective } from '../../application/settings/index.js';
import { refreshConversation } from '../../application/conversations/refreshConversation.js';
import { runExport } from '../../application/export/runExport.js';
import { getDirectoryHandle } from '../../l3a/storageService.js';
import type { ConversationKey } from '../../l2/conversationKey.js';
import type { ExportResult } from '../../application/export/types.js';
import { startKeepAlive } from './keepAlive.js';

async function exportLiveSave(key: ConversationKey, refreshDetail: boolean): Promise<ExportResult | null> {
    const settings = await getSettings();
    if (!isLiveSaveEffective(settings, true)) {
        if (refreshDetail) await refreshConversation(key);
        return null;
    }
    const handle = await getDirectoryHandle();
    if (!handle) throw new Error('Choose a Live Save directory in Options');
    if (!isDirectoryHandle(handle) || await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Reauthorize the Live Save directory in Options');
    // The Worker has no durable task resume. Best-effort Chrome API activity
    // during this one execution cannot be confused with a delivery receipt.
    const stopKeepAlive = startKeepAlive();
    try {
        return await runExport({ keys: [key], format: 'markdown', delivery: 'folderWriter',
            includeAssets: settings.includeAssets, skipUnchanged: false }, { refreshDetail });
    } finally {
        stopKeepAlive();
    }
}

interface PendingSave {
    refresh: boolean | null;
    result: Promise<ExportResult | null>;
}
// Serialize writes for one Key. Events arriving during an export request a
// trailing run, so a newer completed reply cannot be lost behind an older save.
const pendingSaves = new Map<string, PendingSave>();
export function runLiveSave(key: ConversationKey, refreshDetail = false): Promise<ExportResult | null> {
    const id = JSON.stringify([key.accountId, key.conversationId]);
    const existing = pendingSaves.get(id);
    if (existing) {
        existing.refresh = existing.refresh === true || refreshDetail;
        return existing.result;
    }
    const pending: PendingSave = { refresh: refreshDetail, result: Promise.resolve(null) };
    pendingSaves.set(id, pending);
    pending.result = (async () => {
        let result: ExportResult | null = null;
        try {
            while (pending.refresh !== null) {
                const refresh = pending.refresh;
                pending.refresh = null;
                try { result = await exportLiveSave(key, refresh); }
                finally { notifyDomainChanged(key.accountId); }
            }
            return result;
        } finally {
            pendingSaves.delete(id);
        }
    })();
    return pending.result;
}
