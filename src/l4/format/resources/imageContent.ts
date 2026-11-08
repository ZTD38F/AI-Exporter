import type { Diagnostic } from '../../../shared/diagnostics/diagnostic.js';

export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

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

export function checkImageContent(
    asset: { id: string; name?: string; mimeType?: string },
    bytes: Uint8Array,
    diag: (assetId: string, severity: Diagnostic['severity'], code: string, message: string) => void,
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
