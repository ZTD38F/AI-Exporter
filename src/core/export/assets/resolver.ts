import { classifyAssetAvailability } from '../canonical/assetResolution.js';
import type { Asset, AssetStatus } from '../canonical/assets.js';
import type { RenderDiagnostic } from '../canonical/rendering.js';
import { sha256Hex } from './sha256.js';

export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

export interface InlineByteSource {
    has(storageRef: string): boolean;
    get(storageRef: string): Uint8Array | undefined;
}

export interface AssetResolverOptions {
    readLocalFile?: (storageRef: string) => Promise<Uint8Array | undefined | null>;
    hashBytes?: (bytes: Uint8Array) => Promise<string>;
    maxBytes?: number;
}

export interface ResolvedAssetEntry {
    asset: Asset;
    path: string;
    sizeBytes: number;
    mimeType: string;
}

export interface ResolveAssetsResult {
    pathMap: Map<string, string>;
    resolved: Map<string, ResolvedAssetEntry>;
    effectiveStatus: Map<string, AssetStatus>;
    diagnostics: RenderDiagnostic[];
}

export function buildVirtualAssetPath(hashHex: string, ext: string): string {
    const h = hashHex.toLowerCase();
    return `assets/sha256/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}.${ext}`;
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function isUrlRef(ref: string): boolean {
    return /^(https?|data|blob|ftp):/i.test(ref);
}

interface ImageTypeInfo {
    mime: string;
    ext: string;
    magic: (b: Uint8Array) => boolean;
}

function startsWithBytes(b: Uint8Array, prefix: number[]): boolean {
    if (b.length < prefix.length) return false;
    return prefix.every((v, i) => b[i] === v);
}

function startsWithAscii(b: Uint8Array, s: string): boolean {
    if (b.length < s.length) return false;
    for (let i = 0; i < s.length; i++) {
        if (b[i] !== s.charCodeAt(i)) return false;
    }
    return true;
}

const SUPPORTED_IMAGE_TYPES: ImageTypeInfo[] = [
    { mime: 'image/png', ext: 'png', magic: (b) => startsWithBytes(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { mime: 'image/jpeg', ext: 'jpg', magic: (b) => startsWithBytes(b, [0xff, 0xd8, 0xff]) },
    {
        mime: 'image/gif', ext: 'gif',
        magic: (b) => startsWithAscii(b, 'GIF87a') || startsWithAscii(b, 'GIF89a'),
    },
    {
        mime: 'image/svg+xml', ext: 'svg',
        magic: (b) => isSvgDocument(b),
    },
    {
        mime: 'image/webp', ext: 'webp',
        magic: (b) => b.length >= 12 && startsWithAscii(b, 'RIFF') && startsWithAscii(b.slice(8, 12), 'WEBP'),
    },
];

function sniffImage(bytes: Uint8Array): ImageTypeInfo | undefined {
    return SUPPORTED_IMAGE_TYPES.find((t) => t.magic(bytes));
}

function isXmlWs(c: number): boolean {
    return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function skipXmlWs(b: Uint8Array, i: number): number {
    while (i < b.length && isXmlWs(b[i])) i++;
    return i;
}

function matchAscii(b: Uint8Array, i: number, s: string): boolean {
    if (i + s.length > b.length) return false;
    for (let k = 0; k < s.length; k++) {
        if (b[i + k] !== s.charCodeAt(k)) return false;
    }
    return true;
}

function skipXmlComment(b: Uint8Array, i: number): number {
    let j = i + 4;
    while (j + 2 < b.length) {
        if (b[j] === 0x2d && b[j + 1] === 0x2d && b[j + 2] === 0x3e) return j + 3;
        j++;
    }
    return -1;
}

function skipProcessingInstruction(b: Uint8Array, i: number): number {
    let j = i + 2;
    while (j + 1 < b.length) {
        if (b[j] === 0x3f && b[j + 1] === 0x3e) return j + 2;
        j++;
    }
    return -1;
}

// Handles nested [...] internal DTD subsets and quoted '>' so DOCTYPE does not terminate early.
function skipDoctype(b: Uint8Array, i: number): number {
    let j = i + 9;
    let subsetDepth = 0;
    let quote = 0;
    while (j < b.length) {
        const c = b[j];
        if (quote !== 0) {
            if (c === quote) quote = 0;
        } else if (c === 0x22 || c === 0x27) {
            quote = c;
        } else if (c === 0x5b) {
            subsetDepth++;
        } else if (c === 0x5d) {
            if (subsetDepth > 0) subsetDepth--;
        } else if (c === 0x3e && subsetDepth === 0) {
            return j + 1;
        }
        j++;
    }
    return -1;
}

function isSvgDocument(b: Uint8Array): boolean {
    let i = 0;
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
    let sawXmlDecl = false;
    for (let guard = 0; guard < 32; guard++) {
        i = skipXmlWs(b, i);
        if (matchAscii(b, i, '<?xml') || matchAscii(b, i, '<?XML')) {
            if (sawXmlDecl) return false;
            const after = i + 5;
            if (after >= b.length || (!isXmlWs(b[after]) && b[after] !== 0x3f)) return false;
            const end = skipProcessingInstruction(b, i);
            if (end < 0) return false;
            sawXmlDecl = true;
            i = end;
            continue;
        }
        if (matchAscii(b, i, '<!--')) {
            const end = skipXmlComment(b, i);
            if (end < 0) return false;
            i = end;
            continue;
        }
        if (matchAscii(b, i, '<!DOCTYPE') || matchAscii(b, i, '<!doctype') || matchAscii(b, i, '<!Doctype')) {
            const after = i + 9;
            if (after >= b.length || (!isXmlWs(b[after]) && b[after] !== 0x3e)) return false;
            const end = skipDoctype(b, i);
            if (end < 0) return false;
            i = end;
            continue;
        }
        break;
    }
    i = skipXmlWs(b, i);
    if (!matchAscii(b, i, '<svg')) return false;
    const t = i + 4;
    if (t >= b.length) return false;
    const c = b[t];
    return isXmlWs(c) || c === 0x3e || c === 0x2f || c === 0x3a;
}

function normalizeMime(mimeType?: string): string | undefined {
    if (!mimeType) return undefined;
    const base = mimeType.split(';')[0].trim().toLowerCase();
    if (!base) return undefined;
    if (base === 'image/jpg' || base === 'image/pjpeg') return 'image/jpeg';
    if (base === 'image/x-png') return 'image/png';
    return base;
}

function extFromName(name?: string): string | undefined {
    if (!name) return undefined;
    const dot = name.lastIndexOf('.');
    if (dot < 0 || dot === name.length - 1) return undefined;
    const ext = name.slice(dot + 1).toLowerCase();
    return /^[a-z0-9]{1,10}$/.test(ext) ? ext : undefined;
}

function extForGenericAsset(asset: Asset): string {
    const fromName = extFromName(asset.name);
    if (fromName) return fromName;
    const mime = normalizeMime(asset.mimeType);
    if (mime) {
        const subtype = mime.split('/')[1]?.replace(/[^a-z0-9]/g, '');
        if (subtype) return subtype.slice(0, 10);
    }
    return 'bin';
}

export async function resolveAssets(
    assets: readonly Asset[],
    byteStore: InlineByteSource | undefined,
    options: AssetResolverOptions = {},
): Promise<ResolveAssetsResult> {
    const maxBytes = options.maxBytes ?? MAX_ASSET_BYTES;
    const hashBytes = options.hashBytes ?? sha256Hex;
    const pathMap = new Map<string, string>();
    const resolved = new Map<string, ResolvedAssetEntry>();
    const effectiveStatus = new Map<string, AssetStatus>();
    const diagnostics: RenderDiagnostic[] = [];

    const diag = (
        assetId: string,
        severity: RenderDiagnostic['severity'],
        code: string,
        message: string,
    ): void => {
        diagnostics.push({ severity, code, message, path: `asset:${assetId}` });
    };

    for (const asset of assets) {
        if (asset.status === 'remote') {
            effectiveStatus.set(asset.id, 'remote');
            diag(asset.id, 'info', 'ASSET_REMOTE_ONLY',
                `asset ${asset.id} is remote-only (sourceUrl: ${asset.sourceUrl ?? 'unknown'}); ` +
                `resolver performs no network fetch (offline rule) — handle at export time or skip`);
            continue;
        }
        if (asset.status === 'missing' || asset.status === 'failed' || asset.status === 'notFetched') {
            effectiveStatus.set(asset.id, asset.status);
            const reason = asset.failureReason ? ` reason: ${asset.failureReason}` : '';
            diag(asset.id, asset.status === 'notFetched' ? 'info' : 'warning', 'ASSET_UNAVAILABLE',
                `asset ${asset.id} has status '${asset.status}' — no bytes resolved, no path assigned.${reason}`);
            continue;
        }

        let bytes: Uint8Array | undefined;
        let fetchNote: string | undefined;
        const ref = asset.storageRef;
        if (!ref) {
            fetchNote = 'marked available but has no storageRef';
        } else if (byteStore?.has(ref)) {
            const b = byteStore.get(ref);
            if (b !== undefined) bytes = b;
            else fetchNote = `inline byte source has no bytes for storageRef '${ref}'`;
        } else if (isUrlRef(ref)) {
            fetchNote = `storageRef '${ref}' is a remote URL, not a resolvable local ref`;
        } else if (options.readLocalFile) {
            try {
                const b = await options.readLocalFile(ref);
                if (b !== undefined && b !== null) bytes = b;
                else fetchNote = `local file not found for storageRef '${ref}'`;
            } catch (err) {
                diag(asset.id, 'warning', 'ASSET_LOCAL_READ_ERROR',
                    `failed reading local file for asset ${asset.id} (storageRef: '${ref}'): ${errMsg(err)}`);
                fetchNote = `local file read failed for storageRef '${ref}'`;
            }
        } else {
            fetchNote = `no bytes for storageRef '${ref}' (no inline bytes; no local file reader wired)`;
        }

        const classified = classifyAssetAvailability(asset, bytes !== undefined);
        if (classified.pseudoAvailable) {
            effectiveStatus.set(asset.id, 'missing');
            diag(asset.id, 'warning', 'PSEUDO_AVAILABLE',
                `asset ${asset.id} was marked 'available' but no bytes could be resolved` +
                (fetchNote ? ` (${fetchNote})` : '') + '; treating as missing');
            continue;
        }

        const b = bytes as Uint8Array;

        if (b.length === 0) {
            effectiveStatus.set(asset.id, 'failed');
            diag(asset.id, 'warning', 'ASSET_ZERO_BYTES',
                `asset ${asset.id} resolved to zero bytes; no path assigned`);
            continue;
        }
        if (b.length > maxBytes) {
            effectiveStatus.set(asset.id, 'failed');
            diag(asset.id, 'warning', 'ASSET_TOO_LARGE',
                `asset ${asset.id} is ${b.length} bytes, exceeding the ${maxBytes}-byte limit; refused, no path assigned`);
            continue;
        }

        let ext: string;
        let mime: string;
        if (asset.kind === 'image') {
            const verdict = checkImageContent(asset, b, diag);
            if (!verdict.ok) {
                effectiveStatus.set(asset.id, 'failed');
                continue;
            }
            ext = verdict.ext;
            mime = verdict.mime;
        } else {
            ext = extForGenericAsset(asset);
            mime = normalizeMime(asset.mimeType) ?? 'application/octet-stream';
        }

        let hash: string;
        try {
            hash = await hashBytes(b);
        } catch (err) {
            effectiveStatus.set(asset.id, 'failed');
            diag(asset.id, 'error', 'ASSET_HASH_FAILED',
                `failed hashing bytes for asset ${asset.id}: ${errMsg(err)}; no path assigned`);
            continue;
        }
        const path = buildVirtualAssetPath(hash, ext);
        pathMap.set(asset.id, path);
        resolved.set(asset.id, { asset, path, sizeBytes: b.length, mimeType: mime });
        effectiveStatus.set(asset.id, 'available');
    }

    return { pathMap, resolved, effectiveStatus, diagnostics };
}

function checkImageContent(
    asset: Asset,
    bytes: Uint8Array,
    diag: (assetId: string, severity: RenderDiagnostic['severity'], code: string, message: string) => void,
): { ok: true; ext: string; mime: string } | { ok: false } {
    const declared = normalizeMime(asset.mimeType);
    const sniffed = sniffImage(bytes);
    if (sniffed) {
        if (declared && declared !== sniffed.mime) {
            diag(asset.id, 'warning', 'ASSET_MIME_MISMATCH',
                `asset ${asset.id} declares '${declared}' but bytes sniff as '${sniffed.mime}'; using the sniffed type`);
        }
        const nameExt = extFromName(asset.name);
        if (nameExt && nameExt !== sniffed.ext) {
            diag(asset.id, 'warning', 'ASSET_EXTENSION_MISMATCH',
                `asset ${asset.id} name suggests '.${nameExt}' but validated content is '${sniffed.mime}'; virtual path uses '.${sniffed.ext}'`);
        }
        return { ok: true, ext: sniffed.ext, mime: sniffed.mime };
    }
    const declaredSupported = declared !== undefined
        && SUPPORTED_IMAGE_TYPES.some((t) => t.mime === declared);
    if (declaredSupported) {
        diag(asset.id, 'warning', 'ASSET_CORRUPT',
            `asset ${asset.id} declares '${declared}' but its bytes do not match ${declared} magic; treating as corrupt, no path assigned`);
    } else {
        diag(asset.id, 'warning', 'ASSET_UNSUPPORTED_MIME',
            `asset ${asset.id} has an unsupported or undetectable image type ` +
            `(declared: '${asset.mimeType ?? 'none'}'); Typst image() cannot render it, no path assigned`);
    }
    return { ok: false };
}
