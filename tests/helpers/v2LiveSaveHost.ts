import type { TestContext } from 'node:test';
import { IDBObjectStore } from 'fake-indexeddb';
import { indexStorage } from './indexStorage.js';
import { fixtureAccount } from './domainFixture.js';
import { ingestDetail } from '../../src/l2/ingestion.js';
import type { DomainAsset, DomainMessage } from '../../src/l2/conversationDetail.js';
import { updateSettings } from '../../src/application/settings/index.js';

const account = fixtureAccount('gemini');
export const liveKey = (conversationId: string) => ({ accountId: account.id, conversationId });
const paragraph = (text: string) => ({ type: 'paragraph' as const, children: [{ type: 'text' as const, text }] });

/**
 * Fake only browser host capabilities: fake-indexeddb, a structured-cloneable
 * FileSystemDirectoryHandle, and external Provider transport. All v2 Domain,
 * Storage, Application, Composer, Folder Writer and ExportRecord code stays real.
 */
export function v2LiveSaveHost(t: TestContext) {
    const environment = indexStorage();
    const originalGet = IDBObjectStore.prototype.get;
    const originalPut = IDBObjectStore.prototype.put;
    const previousTabs = Object.getOwnPropertyDescriptor(globalThis.chrome, 'tabs');
    const previousFetch = globalThis.fetch;
    const files = new Map<string, string | Uint8Array>();
    const events: string[] = [];
    const remote = new Map<string, { bytes: Uint8Array; mime: string } | null>();
    const requests: string[] = [];
    let permission: PermissionState = 'granted', requested = 0, queried = 0;
    let failedPath: string | null = null, savedHandle: FileSystemDirectoryHandle | null = null;

    const directory = (prefix: string): FileSystemDirectoryHandle => ({
        kind: 'directory', name: prefix || 'V2Vault',
        async queryPermission() { queried++; return permission; },
        async requestPermission() { requested++; permission = 'granted'; return permission; },
        async getDirectoryHandle(name: string) { return directory(prefix + name + '/'); },
        async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
            const fullPath = prefix + name;
            if (!options?.create && !files.has(fullPath)) throw new DOMException('Missing file', 'NotFoundError');
            return {
                kind: 'file', name,
                async createWritable() {
                    let data: string | Uint8Array | null = null;
                    return {
                        async write(input: string | Blob | BufferSource) {
                            events.push('write:' + fullPath);
                            if (failedPath && fullPath.includes(failedPath)) throw new Error('Disk write failed: ' + fullPath);
                            data = typeof input === 'string' ? input
                                : input instanceof Blob ? new Uint8Array(await input.arrayBuffer())
                                : input instanceof ArrayBuffer ? new Uint8Array(input.slice(0))
                                : new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
                        },
                        async close() {
                            if (data === null) throw new Error('Cannot close empty write');
                            files.set(fullPath, data);
                            events.push('close:' + fullPath);
                        },
                        async abort() { events.push('abort:' + fullPath); },
                    };
                },
            } as unknown as FileSystemFileHandle;
        },
    } as unknown as FileSystemDirectoryHandle);
    const root = directory('');
    savedHandle = root;

    // Node fake-indexeddb cannot structured-clone native FileSystemDirectoryHandles.
    // The real L3a storage functions still open transactions. Emulate only that
    // structured-clone/restore host boundary instead of mocking L3a itself.
    IDBObjectStore.prototype.get = function(query: IDBValidKey | IDBKeyRange) {
        if (this.name !== 'directoryHandles' || query !== 'default') return originalGet.call(this, query);
        const request = { result: savedHandle, onsuccess: null as ((event: Event) => void) | null };
        queueMicrotask(() => request.onsuccess?.({ target: request } as unknown as Event));
        return request as unknown as IDBRequest;
    };
    IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
        if (this.name === 'directoryHandles' && key === 'default') {
            savedHandle = value as FileSystemDirectoryHandle;
            return {} as IDBRequest;
        }
        return arguments.length === 1 ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    Object.defineProperty(globalThis.chrome, 'tabs', { configurable: true, value: {
        query: async () => [{ id: 29, url: 'https://gemini.google.com/app/' }],
        sendMessage: async () => ({ ok: true, accountContext: {
            accountId: account.id, providerId: 'gemini', slot: 'u0',
        } }),
    } });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        requests.push(url);
        const found = remote.get(url);
        if (!found) throw new Error('Unavailable source bytes: ' + url);
        return new Response(new Uint8Array(found.bytes) as BodyInit, { status: 200,
            headers: { 'content-type': found.mime } });
    }) as typeof fetch;
    t.after(() => {
        globalThis.fetch = previousFetch;
        if (previousTabs) Object.defineProperty(globalThis.chrome, 'tabs', previousTabs);
        else Reflect.deleteProperty(globalThis.chrome, 'tabs');
        IDBObjectStore.prototype.get = originalGet;
        IDBObjectStore.prototype.put = originalPut;
        environment.restore();
    });
    return {
        root, files, events, requests,
        permission: (next: PermissionState) => { permission = next; },
        queryCount: () => queried,
        requestCount: () => requested,
        directory: (handle: FileSystemDirectoryHandle | null) => { savedHandle = handle; },
        failWrite: (path: string | null) => { failedPath = path; },
        source: (url: string, bytes: Uint8Array | null, mime = 'image/png') => {
            remote.set(url, bytes ? { bytes, mime } : null);
        },
    };
}
export async function seedLiveDetail(id: string, assets: DomainAsset[] = [], options: {
    savedAt?: number; title?: string; messages?: DomainMessage[];
} = {}): Promise<void> {
    const savedAt = options.savedAt ?? 1700000000000;
    const messages: DomainMessage[] = options.messages ?? [
        { role: 'user', content: [paragraph('Prompt for ' + id)] },
        { role: 'assistant', content: [
            paragraph('Answer for ' + id),
            ...assets.filter(asset => asset.kind === 'image').map(asset => ({ type: 'image' as const, assetId: asset.id })),
        ], ...(assets.some(asset => asset.kind !== 'image')
            ? { attachmentIds: assets.filter(asset => asset.kind !== 'image').map(asset => asset.id) } : {}) },
    ];
    await ingestDetail(account.id, id, {
        savedAt, quality: { status: 'complete' }, assets, messages,
    }, { title: options.title ?? 'V2 Live ' + id, titleSource: 'provider', updatedAt: savedAt });
    await updateSettings({ enabledDisk: true, includeAssets: true, defaultFormat: 'markdown', language: 'en' });
}
