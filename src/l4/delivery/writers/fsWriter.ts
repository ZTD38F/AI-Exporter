import { OperationError, operationError } from '../../../shared/errors/operationError.js';
import type { DirectoryHandle } from '../../../runtime/capabilities/directoryHandle.js';

import type { IExportWriter, WriteFileContent, WriteFileOptions } from './writerInterface.js';
import { assertExportPath } from '../../packaging/exportPath.js';

/** File System Access accepts ArrayBuffer-backed views; copy shared memory only. */
function isWritableBytes(value: Uint8Array): value is Uint8Array<ArrayBuffer> {
    return value.buffer instanceof ArrayBuffer;
}

async function ensureSubDir(root: FileSystemDirectoryHandle, subPath: string): Promise<FileSystemDirectoryHandle> {
    let cur = root;
    assertExportPath(subPath);
    const cleanSubPath = subPath;
    const parts = cleanSubPath.split('/').filter(Boolean);
    for (let p of parts) {
        if (!p || p === '.' || p === '..') continue;
        cur = await cur.getDirectoryHandle(p, { create: true });
    }
    return cur;
}

class FsWriter implements IExportWriter {
    rootDirHandle: FileSystemDirectoryHandle & Partial<Pick<DirectoryHandle, 'queryPermission' | 'requestPermission'>>;
    batchDirHandle: FileSystemDirectoryHandle | null;
    // Serialize concurrent writes targeting the same target path
    __writeChains: Map<string, Promise<void>>;

    constructor(dirHandle: (FileSystemDirectoryHandle & Partial<Pick<DirectoryHandle, 'queryPermission' | 'requestPermission'>>) | null | undefined) {
        if (!dirHandle) throw new OperationError('DIRECTORY_UNAVAILABLE', 'Directory handle is required for FsWriter');
        this.rootDirHandle = dirHandle;
        this.batchDirHandle = null;
        this.__writeChains = new Map();
    }

    async init(): Promise<FileSystemDirectoryHandle> {
        if (this.rootDirHandle.queryPermission) {
            const perm = await this.rootDirHandle.queryPermission({ mode: 'readwrite' });
            if (perm !== 'granted') {
                throw new OperationError('DIRECTORY_PERMISSION_REQUIRED', 'Directory permission not granted: ' + perm);
            }
        }
        this.batchDirHandle = this.rootDirHandle;
        return this.batchDirHandle;
    }

    /** Only NotFound means absent; permission and filesystem errors must propagate. */
    async exists(relativePath: string): Promise<boolean> {
        assertExportPath(relativePath);
        let directory = this.batchDirHandle ?? await this.init();
        const parts = relativePath.split('/');
        const name = parts.pop();
        if (!name) throw new Error('Missing file name');
        try {
            for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: false });
            await directory.getFileHandle(name, { create: false });
            return true;
        } catch (error) {
            if (error instanceof DOMException && error.name === 'NotFoundError') return false;
            throw error;
        }
    }

    async writeFile(relativePath: string, content?: WriteFileContent | null, options?: WriteFileOptions): Promise<string> {
        // The legacy (subDirPath, fileName, content) overload was retired:
        // it had zero production callers (live-save uses the separate
        // LiveSaveWriter facade, not this interface).
        assertExportPath(relativePath);
        const clean = relativePath;
        const lastSlash = clean.lastIndexOf('/');
        const actualSubDir = lastSlash !== -1 ? clean.slice(0, lastSlash) : '';
        const actualFileName = lastSlash !== -1 ? clean.slice(lastSlash + 1) : clean;
        let actualContent: WriteFileContent | null | undefined = content;
        const opts = options || {};

        if (opts && opts.base64 && typeof actualContent === 'string') {
            const binStr = atob(actualContent);
            const len = binStr.length;
            const b = new Uint8Array(len);
            for (let k = 0; k < len; k++) b[k] = binStr.charCodeAt(k);
            actualContent = b;
        }

        const batchDir = this.batchDirHandle ?? await this.init();
        const cleanName = actualFileName;

        if (actualContent === null || actualContent === undefined) {
            throw new Error(`[FsWriter] Cannot write null or undefined content to ${cleanName}`);
        }
        const isBlob = actualContent instanceof Blob;
        const isBufferSource = actualContent instanceof ArrayBuffer || ArrayBuffer.isView(actualContent);
        if (typeof actualContent === 'object' && !isBlob && !isBufferSource) {
            throw new Error(`[FsWriter] Invalid content object passed to writeFile for ${cleanName}`);
        }

        // Serialize concurrent writes targeting the same path
        const chainKey = (actualSubDir ? actualSubDir + '/' : '') + cleanName;
        const prev = this.__writeChains.get(chainKey) || Promise.resolve();
        let releaseGate!: () => void;
        const gate = new Promise<void>((res) => { releaseGate = res; });
        this.__writeChains.set(chainKey, gate);
        await prev;
        let stage = 'directory';
        let attempts = 0;
        const attemptErrors: string[] = [];
        try {
            for (let attempt = 0; ; attempt++) {
                attempts++;
                try {
                    stage = 'directory';
                    const targetDir = actualSubDir ? await ensureSubDir(batchDir, actualSubDir) : batchDir;
                    stage = 'file handle';
                    const fileHandle = await targetDir.getFileHandle(cleanName, { create: true });
                    stage = 'open';
                    const writable = await fileHandle.createWritable();
                    try {
                        stage = 'write';
                        await writable.write(actualContent instanceof Uint8Array
                            ? isWritableBytes(actualContent) ? actualContent : new Uint8Array(actualContent)
                            : actualContent);
                        stage = 'close';
                        await writable.close();
                    } catch (writeErr) {
                        if (typeof writable.abort === 'function') {
                            try { await writable.abort(); } catch (_) {}
                        }
                        throw writeErr;
                    }
                    break;
                } catch (error) {
                    attemptErrors.push(`${stage}:${error instanceof Error ? error.name : 'NonError'}`);
                    // A stale File System Access snapshot needs fresh handles and a new stream.
                    if (!(error instanceof DOMException) || error.name !== 'InvalidStateError' || attempt >= 2) throw error;
                }
            }
        } catch (error) {
            const failure = operationError(error, error instanceof DOMException && error.name === 'NotAllowedError'
                ? 'DIRECTORY_PERMISSION_REQUIRED' : 'FILE_WRITE_FAILED');
            const name = error instanceof Error || error instanceof DOMException ? error.name : 'Error';
            let permission = 'unsupported';
            try { if (this.rootDirHandle.queryPermission) permission = await this.rootDirHandle.queryPermission({ mode: 'readwrite' }); }
            catch (permissionError) { permission = permissionError instanceof Error ? permissionError.name : 'query_failed'; }
            const evidence = { permission, attemptErrors,
                fileNameUtf8Bytes: new TextEncoder().encode(cleanName).byteLength,
                fileNameNfcChanged: cleanName !== cleanName.normalize('NFC'),
                fileNameCodePoints: [...cleanName].slice(0, 255).map(char => `U+${char.codePointAt(0)?.toString(16).toUpperCase()}`) };
            throw new OperationError(failure.code, `File ${stage} failed for ${relativePath} [${name}]: ${failure.message} (attempts: ${attempts}; evidence: ${JSON.stringify(evidence)})`,
                failure.httpStatus, { cause: error });
        } finally {
            releaseGate();
            if (this.__writeChains.get(chainKey) === gate) {
                this.__writeChains.delete(chainKey);
            }
        }
        return actualSubDir ? `${actualSubDir}/${cleanName}` : cleanName;
    }
}

export { FsWriter, ensureSubDir };

