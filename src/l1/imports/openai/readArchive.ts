import { validateZipFile, validateZipEntries } from '../../parsers/shared/archive/zipBombGuard.js';

export interface OpenAIArchiveEntry {
    path: string;
    size: number;
    text(): Promise<string>;
    bytes(): Promise<Uint8Array>;
}
export interface OpenAIArchive {
    entries: ReadonlyMap<string, OpenAIArchiveEntry>;
    json(path: string): Promise<unknown>;
    logicalPaths(name: string): string[];
}
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function array(value: unknown): value is unknown[] { return Array.isArray(value); }

/** JSZip is a bundled global. Validate its inventory before inflating any entry. */
export async function readOpenAIArchive(file: Blob | Uint8Array): Promise<OpenAIArchive> {
    validateZipFile(file);
    const loader: unknown = Reflect.get(globalThis, 'JSZip');
    if ((!record(loader) && typeof loader !== 'function') || !('loadAsync' in loader) || typeof loader.loadAsync !== 'function')
        throw new Error('ZIP reader unavailable; cannot parse the archive.');
    const raw: unknown = await Reflect.apply(loader.loadAsync, loader, [file]);
    if (!record(raw) || !record(raw.files)) throw new TypeError('Invalid OpenAI ZIP inventory');
    validateZipEntries(raw);
    const entries = new Map<string, OpenAIArchiveEntry>();
    for (const [path, value] of Object.entries(raw.files)) {
        if (!record(value) || value.dir) continue;
        const data = value._data;
        if (!record(data) || typeof data.uncompressedSize !== 'number' || data.uncompressedSize < 0 || typeof value.async !== 'function')
            throw new TypeError('Invalid OpenAI ZIP entry');
        const originalPath = typeof value.unsafeOriginalName === 'string' ? value.unsafeOriginalName : path;
        if (originalPath !== path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) throw new TypeError('Invalid OpenAI ZIP path');
        const read = value.async;
        entries.set(path, { path, size: data.uncompressedSize,
            text: async () => {
                const text: unknown = await Reflect.apply(read, value, ['string']);
                if (typeof text !== 'string') throw new TypeError('Invalid OpenAI ZIP text');
                return text;
            },
            bytes: async () => {
                const bytes: unknown = await Reflect.apply(read, value, ['uint8array']);
                if (!(bytes instanceof Uint8Array)) throw new TypeError('Invalid OpenAI ZIP bytes');
                return bytes;
            },
        });
    }
    const json = async (path: string): Promise<unknown> => {
        const entry = entries.get(path);
        if (!entry) throw new Error('OpenAI ZIP is missing a required file');
        if (entry.size > 250 * 1024 * 1024) throw new Error('OpenAI JSON exceeds the supported size limit');
        return JSON.parse(await entry.text());
    };
    const logical = new Map<string, string[]>();
    if (entries.has('export_manifest.json')) {
        const manifest = await json('export_manifest.json');
        if (!record(manifest) || manifest.version !== 1 || !record(manifest.logical_files))
            throw new Error('Unsupported OpenAI export manifest');
        for (const [name, value] of Object.entries(manifest.logical_files)) {
            if (!record(value) || !array(value.files) || !value.files.length
                || !value.files.every((path): path is string => typeof path === 'string' && entries.has(path)))
                throw new Error('OpenAI export manifest references missing files');
            logical.set(name, value.files);
        }
    }
    return { entries, json, logicalPaths: name => logical.get(name) ?? (entries.has(name) ? [name] : []) };
}
