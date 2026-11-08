import { composeDomainDocument } from '../../src/l3b/compose/composeDomainDocument.js';
import { collectDocumentResources } from '../../src/l3b/ast/resourceReferences.js';
import { openStorageDB } from '../../src/l3a/idb.js';
import { readConversationKey, type ConversationKey } from '../../src/l2/conversationKey.js';
import { clearLocalScanRecords } from '../../src/application/localCleanup.js';
/** Test-only access to public v2 owners. Bundled by the Python harness, never shipped. */
import { getSettings, updateSettings } from '../../src/application/settings/index.js';
import * as storage from '../../src/l3a/storageService.js';
import { ensureV2Ready } from '../../src/runtime/api/runtimeReady.js';
import { parseGeminiTakeoutZipArchive, readTakeoutBytes } from '../../src/l1/imports/takeout/readArchive.js';
import { shouldSkipExport } from '../../src/application/export/runExport.js';
import { refreshConversation } from '../../src/application/conversations/refreshConversation.js';
import { readConversation } from '../../src/l2/readConversation.js';

export function accountId(): string {
    const id = (document.getElementById('accountIdSelect') as HTMLSelectElement | null)?.value;
    if (!id) throw new Error('No Registry account selected');
    return id;
}
export async function snapshot(providerId = 'gemini') {
    await ensureV2Ready();
    const id = accountId();
    const [account, rows, coverage, records] = await Promise.all([
        storage.getAccount(id), storage.listIndexes(id), storage.getCoverage(id, 'recent'), storage.listExportRecords(id),
    ]);
    if (!account || account.providerId !== providerId) throw new Error('Selected account is not ' + providerId);
    return { accountId: id, account, rows, coverage, exportIds: Object.keys(records).sort(), records };
}
export async function storedConversation(input: ConversationKey) {
    await ensureV2Ready();
    const key = readConversationKey(input);
    const [index, detail, exportRecord] = await Promise.all([
        storage.getIndex(key), storage.getDetail(key), storage.getExportRecord(key),
    ]);
    return { index, detail, exportRecord };
}
/** The harness must use the same Skip predicate as the Application export. */
export async function skipEligibleIds(providerId = 'gemini') {
    const state = await snapshot(providerId);
    const settings = await getSettings();
    return state.rows.filter(row => shouldSkipExport(state.records[row.key.conversationId] ?? null,
        row.updatedAt, { keys: [row.key], format: settings.defaultFormat, delivery: 'browserDownload',
            includeAssets: settings.includeAssets, skipUnchanged: true })).map(row => row.key.conversationId);
}
/** Acquire current source facts in this Options context before auditing the cached export. */
export async function refreshForNativeAudit(ids: string[], providerId = 'gemini') {
    const state = await snapshot(providerId);
    for (const conversationId of ids) await refreshConversation({ accountId: state.accountId, conversationId });
}
export async function conversations(ids: string[], providerId = 'gemini') {
    const state = await snapshot(providerId);
    return Promise.all(ids.map(async id => {
        const domain = await readConversation({ accountId: state.accountId, conversationId: id });
        return { id, ok: domain !== null, account: state.account, domain,
            summary: state.rows.find(row => row.key.conversationId === id) };
    }));
}
/** Inspect physical L3a schema and the actual L2 -> L3b boundary after export acquisition. */
export async function l3Contracts(ids: string[], providerId = 'gemini') {
    const state = await snapshot(providerId);
    const db = await openStorageDB();
    let layout;
    try {
        const stores = Array.from(db.objectStoreNames);
        const tx = db.transaction(stores, 'readonly');
        layout = { name: db.name, version: db.version, stores: stores.map(name => {
            const store = tx.objectStore(name);
            return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
                indexes: Array.from(store.indexNames).map(name => {
                    const index = store.index(name);
                    return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
                }) };
        }) };
    } finally { db.close(); }
    const documents = await Promise.all(ids.map(async id => {
        const key = { accountId: state.accountId, conversationId: id };
        const domain = await readConversation(key);
        if (!domain) throw new Error('Exported conversation has no current Detail: ' + id);
        const document = composeDomainDocument(domain, state.account);
        const references = collectDocumentResources(document);
        return { key, account: state.account, domain, document,
            referencedIds: [...references.referencedIds].sort(), imageIds: [...references.imageIds].sort() };
    }));
    return { layout, documents };
}

/** Exercise the user-facing account-local reset. */
export async function clearScanRecords() {
    await ensureV2Ready();
    await clearLocalScanRecords(accountId());
}
/** Test setup for a fresh scan without destroying imported title-upgrade fixtures. */
export async function resetScanCoverage() {
    await ensureV2Ready();
    await storage.clearStoredAccountCoverage(accountId());
    await storage.clearStoredAccountExportRecords(accountId());
}
export async function inspectTakeout(encoded: string, mediaPaths: string[]) {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const account = await storage.getAccount(accountId());
    if (!account) throw new Error('Takeout account missing');
    const archive = await (globalThis as unknown as {JSZip:{loadAsync(bytes:Uint8Array):Promise<{files:Record<string,{async(kind:string):Promise<Uint8Array>}>}>}}).JSZip.loadAsync(bytes);
    const parsed = await parseGeminiTakeoutZipArchive(bytes, {account, providerId:'gemini', readArchive:async () => archive});
    const resources: Record<string, {assetId:string;sourcePath:string;bytes:string}[]> = {};
    for (const result of parsed) {
        resources[result.conversationId] = [];
        for (const [assetId, bound] of Object.entries(result.archiveResources)) {
            const data = await readTakeoutBytes(bound.entry);
            if (!data?.byteLength) throw new Error('Takeout source entry empty');
            let binary = ''; for (const byte of data) binary += String.fromCharCode(byte);
            resources[result.conversationId].push({assetId,sourcePath:bound.path,bytes:btoa(binary)});
        }
    }
    const mediaDigests: Record<string,string> = {};
    for (const path of mediaPaths) {
        const entry = archive.files[path];
        if (!entry) throw new Error('Missing archive media: ' + path);
        const data = await entry.async('uint8array');
        if (!data.byteLength) throw new Error('Empty archive media: ' + path);
        mediaDigests[path] = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))]
            .map(byte => byte.toString(16).padStart(2,'0')).join('');
    }
    return {ids:parsed.map(result => result.conversationId), sourceFacts:Object.fromEntries(parsed.map(result => [result.conversationId, result.conversation])), resources, mediaDigests};
}
Object.assign(globalThis, { __tier2V2: { accountId, snapshot, skipEligibleIds, refreshForNativeAudit, conversations, storedConversation, l3Contracts, clearScanRecords, resetScanCoverage, inspectTakeout,
    getAccount: storage.getAccount, listAccounts: storage.listAccounts,
    getSettings, updateSettings,
    getDirectoryHandle: storage.getDirectoryHandle, setDirectoryHandle: storage.setDirectoryHandle } });
