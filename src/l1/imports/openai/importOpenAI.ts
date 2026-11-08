import { getAccount } from '../../../runtime/api/accountRegistry.js';
import { notifyDomainChanged } from '../../../runtime/api/domainChanges.js';
import { ingestDetail } from '../../../l2/ingestion.js';
import { decodeChatGPTDetail } from '../../parsers/chatgpt/decodeDetail.js';
import { parseOpenAIConversation } from '../../parsers/chatgpt/parseExportConversation.js';
import type { SourceResourceContext } from '../../resources/sourceResources.js';
import { readOpenAIArchive, type OpenAIArchive, type OpenAIArchiveEntry } from './readArchive.js';

export interface OpenAIImportResult {
    imported: number;
    skipped: number;
    missingAssets: number;
    status: 'ok' | 'partial' | 'empty';
}
interface LibraryFile { id: string; name?: string; mediaType?: string; conversationId?: string }
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function array(value: unknown): value is unknown[] { return Array.isArray(value); }
async function libraryFiles(archive: OpenAIArchive): Promise<LibraryFile[]> {
    const rows: unknown[] = [];
    for (const path of archive.logicalPaths('library_files.json')) {
        const raw = await archive.json(path);
        if (!array(raw)) throw new TypeError('Invalid OpenAI file library');
        for (const row of raw) rows.push(row);
    }
    return rows.flatMap(value => record(value) && typeof value.file_id === 'string' ? [{
        id: value.file_id,
        ...(typeof value.origination_thread_id === 'string' ? { conversationId: value.origination_thread_id } : {}),
        ...(typeof value.file_name === 'string' ? { name: value.file_name } : {}),
        ...(typeof value.mime_type === 'string' ? { mediaType: value.mime_type } : {}),
    }] : []);
}
function bindResource(archive: OpenAIArchive, uri: string, library: readonly LibraryFile[], conversationId: string): { entry: OpenAIArchiveEntry; file?: LibraryFile } | undefined {
    let locator: string;
    try { locator = decodeURIComponent(uri); } catch { return undefined; }
    let id = locator.replace(/^(?:sediment:\/\/|file-service:\/\/|file-download:)/, '');
    if (locator.startsWith('sandbox:/mnt/data/')) {
        const name = locator.slice('sandbox:/mnt/data/'.length);
        const direct = archive.entries.get(name);
        if (direct) return { entry: direct };
        const matches = library.filter(file => file.name === name && file.conversationId === conversationId);
        if (matches.length !== 1) return undefined;
        id = matches[0].id;
    }
    const metadata = library.find(file => file.id === id);
    // IDs and paths must match whole names; never select the first prefix match.
    const direct = archive.entries.get(id) ?? archive.entries.get(`${id}.dat`);
    if (direct) return { entry: direct, file: metadata };
    const candidates = [...archive.entries.values()].filter(entry => {
        const base = entry.path.split('/').at(-1) ?? '';
        return base === id || base === `${id}.dat` || base.startsWith(`${id}-`);
    });
    return candidates.length === 1 ? { entry: candidates[0], file: metadata } : undefined;
}

/** Offline export acquisition uses the same ChatGPT decoder/parser and L2 admission as live Detail. */
export async function importOpenAI(file: Blob | Uint8Array, accountId: string,
    onProgress?: (percent: number) => void, resources?: SourceResourceContext): Promise<OpenAIImportResult> {
    const account = await getAccount(accountId);
    if (!account || account.providerId !== 'chatgpt') throw new Error('Select a ChatGPT account before importing OpenAI ZIP');
    onProgress?.(5);
    const archive = await readOpenAIArchive(file);
    const paths = archive.logicalPaths('conversations.json');
    if (!paths.length) throw new Error('OpenAI ZIP does not contain conversations.json');
    if (archive.entries.has('user.json')) {
        const user = await archive.json('user.json');
        let identity: unknown;
        try { identity = JSON.parse(account.providerAccountId); }
        catch { throw new Error('OpenAI ZIP belongs to a different ChatGPT user'); }
        if (!record(user) || typeof user.id !== 'string' || !array(identity) || identity[0] !== user.id)
            throw new Error('OpenAI ZIP belongs to a different ChatGPT user');
    }
    const library = await libraryFiles(archive);
    // Decode all source rows before committing any of them: malformed shards cannot cause a half-import.
    const conversations = [];
    for (const path of paths) {
        const rows = await archive.json(path);
        if (!array(rows)) throw new TypeError('Invalid OpenAI conversations.json');
        for (const row of rows) {
            if (!record(row)) throw new TypeError('Invalid OpenAI conversation');
            const id = row.id ?? row.conversation_id;
            if (typeof id !== 'string' || !id.trim() || id !== id.trim()) throw new TypeError('Invalid OpenAI conversation identity');
            conversations.push(decodeChatGPTDetail(row, id));
        }
    }
    onProgress?.(35);
    const result: OpenAIImportResult = { imported: 0, skipped: 0, missingAssets: 0, status: 'ok' };
    const imported = new Set<string>();
    for (const [position, conversation] of conversations.entries()) {
        const parsed = parseOpenAIConversation(conversation);
        if (!parsed.conversation.detail.messages.length) { result.skipped++; continue; }
        const bound = new Map<string, OpenAIArchiveEntry>();
        for (const asset of parsed.conversation.detail.assets) {
            const resource = bindResource(archive, asset.sourceUri ?? asset.id, library, conversation.id);
            if (!resource || resource.entry.size === 0) { result.missingAssets++; continue; }
            bound.set(asset.id, resource.entry);
            asset.name ??= resource.file?.name ?? resource.entry.path.split('/').at(-1);
            asset.mediaType ??= resource.file?.mediaType;
            asset.byteLength = resource.entry.size;
        }
        const admission = await ingestDetail(accountId, conversation.id, parsed.conversation.detail, parsed.conversation.index);
        if (admission.accepted) {
            imported.add(conversation.id);
            if (resources) {
                resources.retainParsed({ accountId, conversationId: conversation.id }, parsed);
                for (const [assetId, entry] of bound) resources.retain({ accountId, conversationId: conversation.id }, assetId,
                    async () => ({ bytes: await entry.bytes() }));
            }
        } else result.skipped++;
        if (parsed.conversation.detail.quality.status !== 'complete') result.status = 'partial';
        onProgress?.(35 + Math.floor((position + 1) / conversations.length * 65));
        if ((position + 1) % 25 === 0) { notifyDomainChanged(accountId); await new Promise<void>(resolve => setTimeout(resolve, 0)); }
    }
    result.imported = imported.size;
    if (!conversations.length) result.status = 'empty';
    else if (result.skipped || result.missingAssets) result.status = 'partial';
    notifyDomainChanged(accountId);
    onProgress?.(100);
    return result;
}
