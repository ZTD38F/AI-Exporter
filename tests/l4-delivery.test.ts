import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBrowserDownload, writeToFolder } from '../src/l4/delivery/index.js';
import { FsWriter } from '../src/l4/delivery/writers/fsWriter.js';
const file = { fileName: 'chat.md', mimeType: 'text/markdown', content: 'hello' };
function directory(permission = 'granted', fail = false) {
    const written = new Map<string, unknown>(); let prompts = 0; let aborts = 0;
    const node = (prefix: string): unknown => ({
        queryPermission: async () => permission,
        requestPermission: async () => { prompts++; return 'granted'; },
        getDirectoryHandle: async (name: string) => node(prefix + name + '/'),
        getFileHandle: async (name: string) => ({ createWritable: async () => ({
            write: async (content: unknown) => { if (fail) throw new Error('disk full'); written.set(prefix + name, content); },
            close: async () => {}, abort: async () => { aborts++; },
        }) }),
    });
    return { handle: node('') as FileSystemDirectoryHandle, written, prompts: () => prompts, aborts: () => aborts };
}
test('Folder Delivery uses the chosen root and exact supplied paths', async () => {
    const d = directory(); const bytes = new Uint8Array([1, 2]);
    await writeToFolder([file, { fileName: 'assets/image.png', content: bytes, mimeType: 'image/png' }], d.handle);
    assert.deepEqual([...d.written.keys()], ['chat.md', 'assets/image.png']);
    assert.equal(d.written.get('assets/image.png'), bytes);
});
for (const permission of ['prompt', 'denied']) test(`Folder ${permission} rejects without requesting permission or writing`, async () => {
    const d = directory(permission);
    await assert.rejects(writeToFolder([file], d.handle), /permission not granted/);
    assert.equal(d.prompts(), 0); assert.equal(d.written.size, 0);
});
test('Folder write failures propagate and abort the failed writable', async () => {
    const d = directory('granted', true);
    await assert.rejects(writeToFolder([file], d.handle), /disk full/);
    assert.equal(d.aborts(), 1);
});
test('Folder rejects noncanonical paths without touching disk', async () => {
    const d = directory();
    await assert.rejects(writeToFolder([{ ...file, fileName: '../chat.md' }], d.handle), /Unsafe/);
    assert.equal(d.written.size, 0);
});
test('FsWriter serializes same-path writes through close', async () => {
    const events: string[] = []; let index = 0;
    const writer = new FsWriter({ getFileHandle: async () => { const i = ++index; return { createWritable: async () => ({
        write: async () => { events.push(`write${i}`); await new Promise(r => setTimeout(r, 3)); },
        close: async () => { events.push(`close${i}`); },
    }) }; } } as unknown as FileSystemDirectoryHandle);
    await Promise.all([writer.writeFile('a.md', '1'), writer.writeFile('a.md', '2')]);
    assert.deepEqual(events, ['write1', 'close1', 'write2', 'close2']);
});
test('Browser Delivery clicks once, preserves filename/MIME and revokes the URL', async () => {
    const originalDocument = globalThis.document;
    const originalMouseEvent = Object.getOwnPropertyDescriptor(globalThis, 'MouseEvent');
    const originalCreate = URL.createObjectURL; const originalRevoke = URL.revokeObjectURL;
    let clicks = 0; let removed = 0; let revoked = ''; let captured: Blob | undefined;
    const anchor = { href: '', download: '', dispatchEvent(event: Event) {
        assert.equal(event.type, 'click'); assert.equal(event.cancelable, true); assert.equal(event.bubbles, true);
        clicks++; return true;
    }, remove() { removed++; } };
    try {
        Object.defineProperty(globalThis, 'MouseEvent', { configurable: true, value: Event });
        globalThis.document = { createElement: () => anchor, body: { appendChild: () => {} } } as unknown as Document;
        URL.createObjectURL = blob => { captured = blob as Blob; return 'blob:probe'; };
        URL.revokeObjectURL = url => { revoked = url; };
        await startBrowserDownload(file);
        assert.equal(clicks, 1); assert.equal(anchor.download, file.fileName); assert.equal(captured!.type, file.mimeType);
        assert.equal(await captured!.text(), 'hello'); assert.equal(removed, 1);
        await new Promise(r => setTimeout(r, 5)); assert.equal(revoked, 'blob:probe');
        anchor.dispatchEvent = () => false;
        await assert.rejects(startBrowserDownload(file), error => error instanceof Error
            && 'code' in error && error.code === 'FILE_WRITE_FAILED' && /blocked/.test(error.message));
        anchor.dispatchEvent = () => { throw new Error('click failed'); };
        await assert.rejects(startBrowserDownload(file), /click failed/);
        await new Promise(r => setTimeout(r, 5));
        assert.equal(removed, 3);
    } finally {
        globalThis.document = originalDocument; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
        if (originalMouseEvent) Object.defineProperty(globalThis, 'MouseEvent', originalMouseEvent);
        else Reflect.deleteProperty(globalThis, 'MouseEvent');
    }
});

test('FsWriter.exists only reads exact paths and propagates errors other than NotFound', async () => {
    const calls: string[] = [];
    let failure: DOMException | undefined;
    const handle = {
        async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions) {
            assert.equal(options?.create, false);
            calls.push(name);
            if (failure) throw failure;
            return handle;
        },
        async getFileHandle(name: string, options?: FileSystemGetFileOptions) {
            assert.equal(options?.create, false);
            calls.push(name);
            if (failure) throw failure;
            return {};
        },
    } as FileSystemDirectoryHandle;
    const writer = new FsWriter(handle);
    assert.equal(await writer.exists('assets/account/chat/photo.png'), true);
    assert.deepEqual(calls, ['assets', 'account', 'chat', 'photo.png']);
    for (const path of ['photo.png', 'assets/photo.png']) {
        failure = new DOMException('Missing', 'NotFoundError');
        assert.equal(await writer.exists(path), false);
        for (const name of ['NotAllowedError', 'TypeMismatchError', 'InvalidStateError']) {
            failure = new DOMException('Lookup failed', name);
            await assert.rejects(writer.exists(path), error => error === failure);
        }
    }
    calls.length = 0;
    await assert.rejects(writer.exists('../photo.png'));
    assert.equal(calls.length, 0);
});
