import type { TestContext } from 'node:test';
import { indexStorage } from './indexStorage.js';
import { fixtureAccount } from './domainFixture.js';
import { ingestDetail, ingestIndexes } from '../../src/l2/ingestion.js';
import { updateSettings } from '../../src/application/settings/index.js';
import type { ExportRequest } from '../../src/application/export/types.js';

const account = fixtureAccount('gemini');

/** Merge physical deliveries in the documented extraction order: documents,
 * then attachments and corrections, regardless of browser download order. */
export async function readDeliveredFiles(host: {blobs: readonly Blob[]; filenames: readonly string[]}) {
    const library: {loadAsync(bytes:ArrayBuffer):Promise<{files:Record<string,{
        dir:boolean; async(type:'uint8array'):Promise<Uint8Array>;
    }>} >} = require('../../lib/jszip.min.js');
    const files = new Map<string,Uint8Array>();
    const deliveries = [...host.blobs.entries()].sort(([a],[b])=>
        Number(/^attachments_.*\.zip$/.test(host.filenames[a]))-Number(/^attachments_.*\.zip$/.test(host.filenames[b])));
    for (const [index,blob] of deliveries) {
        const name = host.filenames[index];
        if (name.endsWith('.zip')) {
            const zip = await library.loadAsync(await blob.arrayBuffer());
            for (const [path,entry] of Object.entries(zip.files))
                if (!entry.dir) files.set(path,await entry.async('uint8array'));
        } else files.set(name,new Uint8Array(await blob.arrayBuffer()));
    }
    return [...files].map(([name,bytes])=>({name,
        async:async(type:'string'|'uint8array')=>type==='string'?new TextDecoder().decode(bytes):bytes}));
}

/** Only the extension host is faked: L2, L3a, Application, L3b and L4 remain real. */
export function v2ExportHost(t: TestContext, onClick: () => void = () => {}) {
    const storage = indexStorage();
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const previousMouseEvent = Object.getOwnPropertyDescriptor(globalThis, 'MouseEvent');
    const originalObjectUrl = URL.createObjectURL;
    const blobs: Blob[] = [];
    const filenames: string[] = [];
    let clicks = 0;
    Object.defineProperty(globalThis, 'MouseEvent', { configurable: true, value: Event });

    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        createElement: (tag: string) => {
            if (tag !== 'a') throw new Error('Unexpected document element: ' + tag);
            const anchor = { href: '', download: '', remove() {}, dispatchEvent(event: Event) {
                if (event.type !== 'click') throw new Error('Unexpected delivery event');
                clicks++;
                filenames.push(anchor.download);
                onClick();
                return !event.defaultPrevented;
            } };
            return anchor;
        },
        body: { appendChild() {} },
    } });
    Object.defineProperty(globalThis, 'location', {
        configurable: true, value: { hostname: 'example.test', protocol: 'https:' },
    });
    URL.createObjectURL = ((blob: Blob) => {
        blobs.push(blob);
        return originalObjectUrl.call(URL, blob);
    }) as typeof URL.createObjectURL;
    t.after(() => {
        URL.createObjectURL = originalObjectUrl;
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else Reflect.deleteProperty(globalThis, 'document');
        if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
        else Reflect.deleteProperty(globalThis, 'location');
        if (previousMouseEvent) Object.defineProperty(globalThis, 'MouseEvent', previousMouseEvent);
        else Reflect.deleteProperty(globalThis, 'MouseEvent');
        storage.restore();
    });
    return { blobs, filenames, clicks: () => clicks, failStorage: storage.fail };
}

export function exportKey(conversationId: string) {
    return { accountId: account.id, conversationId };
}
export function exportRequest(ids: readonly string[], options: Partial<ExportRequest> = {}): ExportRequest {
    return { keys: ids.map(exportKey), format: 'markdown',
        delivery: 'browserDownload', includeAssets: false, skipUnchanged: false, ...options };
}
export async function seedExportConversation(conversationId: string, savedAt = 100): Promise<void> {
    await ingestDetail(account.id, conversationId, {
        savedAt, quality: { status: 'complete' }, assets: [],
        messages: [
            { role: 'user', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Prompt for ' + conversationId }] }] },
            { role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Answer for ' + conversationId }] }] },
        ],
    }, { title: 'Conversation ' + conversationId, titleSource: 'provider', updatedAt: savedAt });
    await updateSettings({ language: 'en' });
}
export async function seedExportIndexOnly(conversationId: string): Promise<void> {
    await ingestIndexes(account.id, [{ conversationId, fields: {
        title: 'Unavailable ' + conversationId, titleSource: 'provider', updatedAt: 100,
    } }]);
}
