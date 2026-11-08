/** Archive handles are acquisition context and never enter Domain. */
export interface TakeoutSourceFile {
    dir?: boolean;
    _data?: { uncompressedSize?: number };
    async?: (type: string) => Promise<unknown>;
}
interface TakeoutArchiveResource { path: string; entry: TakeoutSourceFile }
type TakeoutResourceResolution =
    | { status: 'resolved'; resource: TakeoutArchiveResource; method: 'relative-path' | 'archive-path' | 'basename' | 'stem' | 'normalized-name' | 'normalized-stem' }
    | { status: 'ambiguous'; candidates: readonly TakeoutArchiveResource[] }
    | { status: 'missing' };

function normalizePath(path: string): string {
    const parts: string[] = [];
    for (const part of path.replace(/\\/g, '/').split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (!parts.length) return ''; // References cannot escape the archive root.
            parts.pop();
        } else parts.push(part);
    }
    return parts.join('/');
}
export function decodeTakeoutReference(uri: string): string {
    try { return decodeURIComponent(uri); } catch { return uri; }
}
export function takeoutBaseName(path: string): string { return path.replace(/\\/g, '/').split('/').pop() ?? ''; }
function stem(name: string): string {
    // Keep the complete hash/name; .synced is a Takeout wrapper, handled separately.
    return /\.synced$/i.test(name) ? name : name.replace(/\.[a-z][a-z0-9]{0,15}$/i, '');
}
function normalizedName(name: string): string { return name.replace(/\|/g, '_').replace(/\.synced$/i, ''); }
type Index = Map<string, TakeoutArchiveResource[]>;
function add(index: Index, key: string, resource: TakeoutArchiveResource): void {
    const values = index.get(key) ?? [];
    values.push(resource);
    index.set(key, values);
}
function unique(values: TakeoutArchiveResource[]): TakeoutArchiveResource[] { return [...new Set(values)]; }

/** Ordered, unique-only lookup. We preserve ZIP names and source references verbatim. */
export function createTakeoutResourceResolver(files: Readonly<Record<string, TakeoutSourceFile>>, activityPath?: string): (uri: string) => TakeoutResourceResolution {
    const paths: Index = new Map(), names: Index = new Map(), stems: Index = new Map(), normalizedNames: Index = new Map(), normalizedStems: Index = new Map();
    for (const [path, entry] of Object.entries(files)) {
        if (entry.dir) continue;
        const resource = { path, entry };
        const name = takeoutBaseName(path);
        // Archive inventory paths are literal, not URI-encoded HTML references.
        add(paths, normalizePath(path), resource);
        add(names, name, resource);
        add(stems, stem(name), resource);
        add(normalizedNames, normalizedName(name), resource);
        add(normalizedStems, stem(normalizedName(name)), resource);
    }
    const activityDirectory = activityPath ? normalizePath(activityPath).split('/').slice(0, -1).join('/') : undefined;
    return uri => {
        const decoded = decodeTakeoutReference(uri);
        const name = takeoutBaseName(decoded);
        const variants = (nameIndex: Index, stemIndex: Index, key: string): TakeoutArchiveResource[] =>
            unique([...(nameIndex.get(stem(key)) ?? []), ...(stemIndex.get(stem(key)) ?? []), ...(stemIndex.get(key) ?? [])]);
        const tiers: Array<[Extract<TakeoutResourceResolution, { status: 'resolved' }>['method'], TakeoutArchiveResource[]]> = [
            ['relative-path', activityDirectory === undefined ? [] : paths.get(normalizePath(`${activityDirectory}/${decoded}`)) ?? []],
            ['archive-path', paths.get(normalizePath(decoded)) ?? []],
            ['basename', names.get(name) ?? []],
            ['stem', variants(names, stems, name)],
            ['normalized-name', normalizedNames.get(normalizedName(name)) ?? []],
            ['normalized-stem', variants(normalizedNames, normalizedStems, normalizedName(name))]
        ];
        for (const [method, candidates] of tiers) {
            if (candidates.length > 1) return { status: 'ambiguous', candidates };
            if (candidates.length === 1) return { status: 'resolved', resource: candidates[0], method };
        }
        return { status: 'missing' };
    };
}
