
import type { IExportWriter } from './writerInterface.js';
import { sanitizeRelativePath } from '../../utils/utils.js';
import { __resolveModule } from '../../utils/moduleOverrides.js';

export interface ZipWriterClass {
    new (folderName?: string): ZipWriter;
    ZipWriter: typeof ZipWriter;
}

/**
 * Identify already-compressed binary media assets where DEFLATE provides 0% gain
 * but wastes massive CPU and memory.
 */
export function isPrecompressedAsset(path: string): boolean {
    if (!path) return false;
    return /\.(png|jpe?g|webp|gif|bmp|mp3|mp4|m4a|wav|ogg|zip|gz|tar|pdf)$/i.test(path);
}

import { DEFAULT_EXPORT_FOLDER_NAME } from '../../utils/constants.js';

class ZipWriter implements IExportWriter {
    zip: any;
    folder: any;
    totalBytes: number;
    MAX_SAFE_ZIP_BYTES: number;

    static ZipWriter = ZipWriter;

    constructor(folderName: string = DEFAULT_EXPORT_FOLDER_NAME) {
        const JSZipLib = __resolveModule('JSZip', null)
            || (typeof self !== 'undefined' ? (self as any).JSZip : null)
            || (typeof require !== 'undefined' ? (function() { try { return require('jszip'); } catch { return null; } })() : null);
        if (!JSZipLib) {
            throw new Error('JSZip library is not available');
        }
        this.zip = new JSZipLib();
        this.folder = this.zip.folder(folderName);
        this.totalBytes = 0;
        this.MAX_SAFE_ZIP_BYTES = 200 * 1024 * 1024; // 200MB safe memory warning threshold to prevent V8 tab OOM
    }

    sanitizePath(p?: string | null): string {
        if (!p) return '';
        return sanitizeRelativePath(p, 'file');
    }

    writeFile(relativePath: string, content?: any, options?: any): string {
        // Single supported form: (relativePath, content, options?).
        // The legacy (subDirPath, fileName, content) overload was retired:
        // it had zero production callers.
        const cleanPath = this.sanitizePath(relativePath);
        const opts: any = options || {};

        if (content) {
            if (typeof content === 'string') {
                this.totalBytes += content.length * (opts && opts.base64 ? 0.75 : 1);
            } else if (typeof Blob !== 'undefined' && content instanceof Blob) {
                this.totalBytes += content.size;
            } else if (content.byteLength) {
                this.totalBytes += content.byteLength;
            } else if (content.length) {
                this.totalBytes += content.length;
            }
        }
        if (this.totalBytes > this.MAX_SAFE_ZIP_BYTES) {
            throw new Error(`[ZipWriter] 未压缩内容超过 ${(this.MAX_SAFE_ZIP_BYTES / 1024 / 1024).toFixed(0)}MB 上限，已中止导出以防内存溢出。请减少所选会话数量后重试，或在设置中选择保存到本地目录。`);
        }

        // Selective compression: bypass DEFLATE on already-compressed media (png, jpg, webp, etc.)
        // to avoid duplicating memory in V8 during zip generation.
        // Phase B (B1): 压缩决策收敛在文件级 —— writeFile 时按文件决定 STORE/DEFLATE，
        // generateBlob 不再传全局 compression，文件级设置直接透传。
        const fileOpts: any = { ...opts };
        if (!fileOpts.compression) {
            fileOpts.compression = isPrecompressedAsset(cleanPath) ? 'STORE' : 'DEFLATE';
        }
        if (fileOpts.compression === 'DEFLATE' && !fileOpts.compressionOptions) {
            fileOpts.compressionOptions = { level: 6 };
        }

        this.folder.file(cleanPath, content, fileOpts);
        return cleanPath;
    }

    getTotalBytes(): number {
        return this.totalBytes;
    }

    async generateBlob(onUpdate?: (pct: number) => void): Promise<Blob> {
        // Stream generation: use generateInternalStream if available to stream chunks
        // with significantly lower peak buffer overhead than full in-memory generation.
        // Phase B (B1): 不再传全局 compression / compressionOptions 硬压——
        // 各文件的 STORE/DEFLATE（含 level 6）已在 writeFile 时按文件级设定，
        // 这里透传文件级设置即可。
        if (typeof this.zip.generateInternalStream === 'function') {
            try {
                return await this.zip.generateInternalStream({
                    type: 'blob'
                }).accumulate((meta: any) => {
                    if (onUpdate && typeof onUpdate === 'function') {
                        onUpdate(meta.percent);
                    }
                });
            } catch (streamErr) {
                console.warn('[ZipWriter] generateInternalStream failed, falling back to generateAsync:', streamErr);
            }
        }

        return await this.zip.generateAsync({
            type: 'blob'
        }, (meta: any) => {
            if (onUpdate && typeof onUpdate === 'function') {
                onUpdate(meta.percent);
            }
        });
    }
}

export { ZipWriter };
export default ZipWriter;
