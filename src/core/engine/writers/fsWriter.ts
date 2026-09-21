// src/core/engine/writers/fsWriter.ts - FileSystem Access API Writer

import type { IExportWriter } from './writerInterface.js';
import { sanitizeFileName as utilsSanitizeFileName, sanitizeRelativePath as utilsSanitizeRelativePath } from '../../utils/utils.js';

export interface FsWriterModule {
    FsWriter: typeof FsWriter;
    ensureSubDir: typeof ensureSubDir;
    sanitizeFileName: typeof sanitizeFileName;
    sanitizeRelativePath: typeof sanitizeRelativePath;
}

declare global {
    var FsWriter: FsWriterModule;
}

function sanitizeFileName(name?: string | null, fallback: string = 'untitled'): string {
    return utilsSanitizeFileName(name, fallback);
}

function sanitizeRelativePath(p?: string | null, defaultName: string = 'file'): string {
    return utilsSanitizeRelativePath(p, defaultName);
}


async function ensureSubDir(root: any, subPath: string): Promise<any> {
    let cur = root;
    const cleanSubPath = sanitizeRelativePath(subPath, 'dir');
    const parts = cleanSubPath.split('/').filter(Boolean);
    for (let p of parts) {
        if (!p || p === '.' || p === '..') continue;
        cur = await cur.getDirectoryHandle(p, { create: true });
    }
    return cur;
}

class FsWriter implements IExportWriter {
    rootDirHandle: any;
    folderName: string;
    batchDirHandle: any;

    static FsWriter = FsWriter;
    static ensureSubDir = ensureSubDir;
    static sanitizeFileName = sanitizeFileName;
    static sanitizeRelativePath = sanitizeRelativePath;

    constructor(dirHandle: any, folderName: string = 'gemini_export') {
        if (!dirHandle) throw new Error('Directory handle is required for FsWriter');
        this.rootDirHandle = dirHandle;
        this.folderName = folderName;
        this.batchDirHandle = null;
    }

    async init(): Promise<any> {
        if (this.rootDirHandle.queryPermission) {
            const perm = await this.rootDirHandle.queryPermission({ mode: 'readwrite' });
            if (perm !== 'granted') {
                const req = this.rootDirHandle.requestPermission ? await this.rootDirHandle.requestPermission({ mode: 'readwrite' }) : perm;
                if (req !== 'granted') throw new Error('Directory permission not granted: ' + req);
            }
        }
        if (this.rootDirHandle.name === this.folderName) {
            this.batchDirHandle = this.rootDirHandle;
        } else {
            this.batchDirHandle = await this.rootDirHandle.getDirectoryHandle(this.folderName, { create: true });
        }
        return this.batchDirHandle;
    }

    async writeFile(subDirPath: string, fileName?: any, content?: any): Promise<string> {
        let actualSubDir = subDirPath;
        let actualFileName = fileName;
        let actualContent = content;
        if (arguments.length === 2) {
            actualContent = fileName;
            const clean = sanitizeRelativePath(subDirPath, 'file');
            const lastSlash = clean.lastIndexOf('/');
            if (lastSlash !== -1) {
                actualSubDir = clean.slice(0, lastSlash);
                actualFileName = clean.slice(lastSlash + 1);
            } else {
                actualSubDir = '';
                actualFileName = clean;
            }
        }
        if (!this.batchDirHandle) await this.init();
        const targetDir = actualSubDir ? await ensureSubDir(this.batchDirHandle, actualSubDir) : this.batchDirHandle;
        const cleanName = sanitizeFileName(actualFileName, 'file');

        if (actualContent === null || actualContent === undefined) {
            throw new Error(`[FsWriter] Cannot write null or undefined content to ${cleanName}`);
        }
        const isBlob = typeof Blob !== 'undefined' && actualContent instanceof Blob;
        const isBufferSource = (typeof ArrayBuffer !== 'undefined' && actualContent instanceof ArrayBuffer) ||
            (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(actualContent));
        if (typeof actualContent === 'object' && !isBlob && !isBufferSource) {
            throw new Error(`[FsWriter] Invalid content object passed to writeFile for ${cleanName}`);
        }

        const fileHandle = await targetDir.getFileHandle(cleanName, { create: true });
        const writable = await fileHandle.createWritable();
        try {
            await writable.write(actualContent);
        } finally {
            await writable.close();
        }
        return cleanName;
    }
}

export {
    FsWriter,
    ensureSubDir,
    sanitizeFileName,
    sanitizeRelativePath
};

export const FsWriterModule: FsWriterModule = {
    FsWriter,
    ensureSubDir,
    sanitizeFileName,
    sanitizeRelativePath
};

if (typeof globalThis !== 'undefined') (globalThis as any).FsWriter = FsWriterModule;
if (typeof module === 'object' && module.exports) module.exports = FsWriterModule;

export default FsWriterModule;

