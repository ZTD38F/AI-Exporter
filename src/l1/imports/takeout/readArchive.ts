import { validateZipFile, validateZipEntries } from '../../parsers/shared/archive/zipBombGuard.js';
import { parseGeminiTakeoutArchiveAsync, type GeminiTakeoutRaw, type GeminiTakeoutParseContext, type GeminiTakeoutParseResult, type TakeoutSourceFile } from '../../parsers/gemini/takeout/parseConversation.js';

export type GeminiTakeoutZipRaw = Uint8Array | ArrayBuffer | Blob;
type TakeoutArchiveReader = (bytes: GeminiTakeoutZipRaw) => Promise<unknown>;
interface GeminiTakeoutZipContext extends GeminiTakeoutParseContext {
    readArchive?: TakeoutArchiveReader;
    activityPath?: string;
    onArchiveReady?: () => void;
    onProgress?: (completed: number, total: number) => void;
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function defaultArchiveReader(bytes: GeminiTakeoutZipRaw): Promise<unknown> {
    const loader: unknown = Reflect.get(globalThis, 'JSZip');
    if ((!isRecord(loader) && typeof loader !== 'function') || !('loadAsync' in loader) || typeof loader.loadAsync !== 'function') throw new TypeError('Takeout ZIP requires an archive reader');
    const archive: unknown = await Reflect.apply(loader.loadAsync, loader, [bytes]);
    return archive;
}
async function decodeArchive(bytes: GeminiTakeoutZipRaw, context: GeminiTakeoutZipContext): Promise<GeminiTakeoutRaw> {
    if (context.providerId !== 'gemini') throw new TypeError('Gemini Takeout parser requires providerId gemini');
    const suppliedArchive = 'files' in bytes;
    if (!suppliedArchive) validateZipFile(bytes);
    const archive = suppliedArchive ? bytes : await (context.readArchive ?? defaultArchiveReader)(bytes);
    if (!isRecord(archive) || !isRecord(archive.files)) throw new TypeError('Invalid Takeout archive inventory');
    validateZipEntries(archive);
    const files: Record<string, TakeoutSourceFile> = {};
    for (const [path, entry] of Object.entries(archive.files)) {
        if (!isRecord(entry) || (entry.dir !== undefined && typeof entry.dir !== 'boolean')) continue;
        const read = entry.async;
        const data = isRecord(entry._data) ? entry._data : null;
        files[path] = {
            ...(typeof entry.dir === 'boolean' ? { dir: entry.dir } : {}),
            ...(data && typeof data.uncompressedSize === 'number' ? { _data: { uncompressedSize: data.uncompressedSize } } : {}),
            ...(typeof read === 'function' ? { async: async (type: string): Promise<unknown> => {
                const value: unknown = await Reflect.apply(read, entry, [type]);
                return value;
            } } : {}),
        };
    }
    context.onArchiveReady?.();
    const candidates = Object.keys(files).filter(path => !files[path].dir && /(?:My\s?Activity|我的活动).*\.html$/i.test(path));
    const gemini = candidates.filter(path => /(?:^|\/)(?:Gemini(?: Apps)?|Bard)\//i.test(path));
    const supported = gemini.length ? gemini : candidates;
    const activityPath = context.activityPath ?? (supported.length === 1 ? supported[0] : undefined);
    if (!activityPath || !files[activityPath] || files[activityPath].dir) throw new TypeError('Takeout ZIP requires an unambiguous activityPath');
    const activity = files[activityPath];
    const size = activity._data?.uncompressedSize;
    if (size === undefined || !Number.isFinite(size) || size < 0 || size > 250 * 1024 * 1024) throw new TypeError('Takeout HTML uncompressed size is unknown or exceeds the supported limit');
    if (!activity.async) throw new TypeError('Takeout activity entry cannot be read');
    const htmlText = await activity.async('text');
    if (typeof htmlText !== 'string') throw new TypeError('Takeout activity entry must decode to HTML text');
    return { htmlText, activityPath, archiveFiles: files };
}

/** Import input IO: ZIP safety and reads precede the pure HTML source parser. */
export async function parseGeminiTakeoutZipArchive(bytes: GeminiTakeoutZipRaw, context: GeminiTakeoutZipContext): Promise<GeminiTakeoutParseResult[]> {
    return parseGeminiTakeoutArchiveAsync(await decodeArchive(bytes, context), context, context.onProgress);
}

/** Read only a source-bound entry; callers own the archive handle's task lifetime. */
export async function readTakeoutBytes(file: TakeoutSourceFile): Promise<Uint8Array | null> {
    if (!file.async) return null;
    const bytes = await file.async('uint8array');
    return bytes instanceof Uint8Array && bytes.byteLength > 0 ? bytes : null;
}
