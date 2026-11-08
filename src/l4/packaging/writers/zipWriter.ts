import { OperationError } from '../../../shared/errors/operationError.js';

import type { IExportWriter, WriteFileContent, WriteFileOptions } from '../../delivery/writers/writerInterface.js';
import { assertExportPath } from '../exportPath.js';

/**
 * Identify already-compressed binary media assets where DEFLATE provides 0% gain
 * but wastes massive CPU and memory.
 */
export function isPrecompressedAsset(path: string): boolean {
    if (!path) return false;
    return /\.(png|jpe?g|webp|gif|bmp|mp3|mp4|m4a|wav|ogg|zip|docx|gz|tar|pdf)$/i.test(path);
}

/** Only the JSZip operations used by this writer. */
interface ZipInstance {
    file(path: string, content: WriteFileContent | null | undefined, options?: WriteFileOptions): void;
    generateInternalStream?(options: { type: 'blob' }): {
        accumulate(onUpdate: (meta: { percent: number }) => void): Promise<Blob>;
    };
    generateAsync(options: { type: 'blob' }, onUpdate?: (meta: { percent: number }) => void): Promise<Blob>;
}
export type ZipConstructor = new () => ZipInstance;

let testConstructor: ZipConstructor | undefined;
const isProduction = () => typeof process !== 'undefined' && process.env?.NODE_ENV === 'production';
/** The only injected dependency is JSZip, with the same contract as the writer. */
export function __setZipConstructor(value: ZipConstructor | undefined): void {
    if (!isProduction()) testConstructor = value;
}
export function __getZipConstructor(): ZipConstructor | undefined {
    return isProduction() ? undefined : testConstructor;
}

declare global {
    interface WindowOrWorkerGlobalScope { JSZip?: ZipConstructor }
}

class ZipWriter implements IExportWriter {
    zip: ZipInstance;
    folder: ZipInstance;
    totalBytes: number;
    MAX_SAFE_ZIP_BYTES: number;

    constructor() {
        const JSZipLib = __getZipConstructor() ?? (typeof self !== 'undefined' ? self.JSZip : undefined);
        if (!JSZipLib) {
            throw new OperationError('PACKAGING_UNAVAILABLE', 'JSZip library is not available');
        }
        this.zip = new JSZipLib();
        this.folder = this.zip;
        this.totalBytes = 0;
        this.MAX_SAFE_ZIP_BYTES = 200 * 1024 * 1024; // 200MB safe memory warning threshold to prevent V8 tab OOM
    }

    sanitizePath(p?: string | null): string {
        const path = p ?? '';
        assertExportPath(path);
        return path;
    }

    writeFile(relativePath: string, content?: WriteFileContent | null, options?: WriteFileOptions): string {
        // Single supported form: (relativePath, content, options?).
        // The legacy (subDirPath, fileName, content) overload was retired:
        // it had zero production callers.
        const cleanPath = this.sanitizePath(relativePath);
        const opts = options || {};
        // Encode once before JSZip streams strings in chunks. A chunk boundary
        // can otherwise split a UTF-16 surrogate pair and corrupt its UTF-8 bytes.
        const bytes = typeof content === 'string' && !opts.base64 ? new TextEncoder().encode(content) : content;

        if (content) {
            if (typeof content === 'string') {
                this.totalBytes += content.length * (opts.base64 ? 0.75 : 1);
            } else if (content instanceof Blob) {
                this.totalBytes += content.size;
            } else {
                this.totalBytes += content.byteLength;
            }
        }
        if (this.totalBytes > this.MAX_SAFE_ZIP_BYTES) {
            throw new OperationError('PACKAGING_SIZE_LIMIT', `[ZipWriter] 未压缩内容超过 ${(this.MAX_SAFE_ZIP_BYTES / 1024 / 1024).toFixed(0)}MB 上限，已中止导出以防内存溢出。请减少所选会话数量后重试，或在设置中选择保存到本地目录。`);
        }

        // Selective compression: bypass DEFLATE on already-compressed media (png, jpg, webp, etc.)
        // to avoid duplicating memory in V8 during zip generation.
        // Phase B (B1): 压缩决策收敛在文件级 —— writeFile 时按文件决定 STORE/DEFLATE，
        // generateBlob 不再传全局 compression，文件级设置直接透传。
        const fileOpts: WriteFileOptions = { ...opts };
        if (!fileOpts.compression) {
            fileOpts.compression = isPrecompressedAsset(cleanPath) ? 'STORE' : 'DEFLATE';
        }
        if (fileOpts.compression === 'DEFLATE' && !fileOpts.compressionOptions) {
            fileOpts.compressionOptions = { level: 6 };
        }

        this.folder.file(cleanPath, bytes, fileOpts);
        return cleanPath;
    }

    async generateBlob(onUpdate?: (pct: number) => void): Promise<Blob> {
        // Stream generation: use generateInternalStream if available to stream chunks
        // with significantly lower peak buffer overhead than full in-memory generation.
        // Phase B (B1): 不再传全局 compression / compressionOptions 硬压——
        // 各文件的 STORE/DEFLATE（含 level 6）已在 writeFile 时按文件级设定，
        // 这里透传文件级设置即可。
        if (this.zip.generateInternalStream) {
            try {
                return await this.zip.generateInternalStream({
                    type: 'blob'
                }).accumulate((meta: { percent: number }) => {
                    onUpdate?.(meta.percent);
                });
            } catch (streamErr) {
                console.warn('[ZipWriter] generateInternalStream failed, falling back to generateAsync:', streamErr);
            }
        }

        return await this.zip.generateAsync({
            type: 'blob'
        }, (meta: { percent: number }) => {
            onUpdate?.(meta.percent);
        });
    }
}

export { ZipWriter };
