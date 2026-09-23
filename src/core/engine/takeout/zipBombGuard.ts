// zipBombGuard.ts - ZipBomb protection guards and entry size estimators for Takeout ZIP extraction

export interface ZipBombGuardModule {
    MAX_ZIP_SIZE: number;
    MAX_ENTRY_COUNT: number;
    MAX_TOTAL_UNCOMPRESSED: number;
    validateZipFile: (file?: { size?: number } | null) => void;
    validateZipEntries: (zip?: any) => void;
}

declare global {
    var ZipBombGuard: ZipBombGuardModule;
}

export const MAX_ZIP_SIZE = 500 * 1024 * 1024; // 500MB compressed size
export const MAX_ENTRY_COUNT = 10000; // 10,000 files
export const MAX_TOTAL_UNCOMPRESSED = 1024 * 1024 * 1024; // 1GB uncompressed estimate

export function validateZipFile(file?: { size?: number } | null): void {
    if (file && typeof file.size === 'number' && file.size > MAX_ZIP_SIZE) {
        throw new Error(`Takeout ZIP 体积过大 (${(file.size / 1024 / 1024).toFixed(1)}MB)，超过 ${MAX_ZIP_SIZE / 1024 / 1024}MB 上限，请确认是否为完整 Takeout 归档`);
    }
}

function normalizedOriginalEntryPath(rawPath: string, entry: any): string {
    const originalPath = typeof entry?.unsafeOriginalName === 'string'
        ? entry.unsafeOriginalName
        : rawPath;
    return String(originalPath || '').replace(/\\/g, '/');
}

function portableCollisionKey(path: string): string {
    // Direct Write/export folders can live on case-insensitive Windows/macOS
    // filesystems. Reject names that those filesystems can alias instead of
    // allowing a later write to overwrite a distinct archive entry.
    return path
        .normalize('NFC')
        .split('/')
        .map(part => part.replace(/[ .]+$/g, '').toLocaleLowerCase('en-US'))
        .join('/');
}

export function validateZipEntries(zip?: any): void {
    if (!zip || !zip.files) return;
    const entryCount = Object.keys(zip.files).length;
    if (entryCount > MAX_ENTRY_COUNT) {
        throw new Error(`ZIP 条目数过多 (${entryCount})，超过 ${MAX_ENTRY_COUNT} 上限，疑似 ZipBomb，已中止`);
    }

    let approxUncompressed = 0;
    const normalizedPaths = new Set<string>();
    const portablePaths = new Map<string, string>();
    const files: Array<[string, any]> = Object.entries(zip.files);
    for (const [rawPath, f] of files) {
        const normalizedPath = normalizedOriginalEntryPath(rawPath, f);
        if (normalizedPaths.has(normalizedPath)) {
            throw new Error(`Duplicate normalized ZIP entry path: ${normalizedPath}`);
        }
        normalizedPaths.add(normalizedPath);

        const collisionKey = portableCollisionKey(normalizedPath);
        const existingPortablePath = portablePaths.get(collisionKey);
        if (existingPortablePath !== undefined && existingPortablePath !== normalizedPath) {
            throw new Error(`Portable ZIP entry path collision: ${existingPortablePath} <> ${normalizedPath}`);
        }
        portablePaths.set(collisionKey, normalizedPath);

        if (!f.dir && f._data && typeof f._data.uncompressedSize === 'number') {
            approxUncompressed += f._data.uncompressedSize;
            if (approxUncompressed > MAX_TOTAL_UNCOMPRESSED) {
                throw new Error(`ZIP 未压缩体积估算超过 1GB，已中止以防 OOM`);
            }
        }
    }
}

export const ZipBombGuard: ZipBombGuardModule = {
    MAX_ZIP_SIZE,
    MAX_ENTRY_COUNT,
    MAX_TOTAL_UNCOMPRESSED,
    validateZipFile,
    validateZipEntries
};

(ZipBombGuard as any).ZipBombGuard = ZipBombGuard;
(ZipBombGuard as any).default = ZipBombGuard;

if (typeof globalThis !== 'undefined' && !(globalThis as any).ZipBombGuard) {
    (globalThis as any).ZipBombGuard = ZipBombGuard;
}
if (typeof module === 'object' && module.exports) {
    module.exports = ZipBombGuard;
}
export default ZipBombGuard;
