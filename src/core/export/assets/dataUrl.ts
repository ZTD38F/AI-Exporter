import { sha256Hex } from './sha256.js';

export const INLINE_DATA_URL_MAX_BYTES = 10 * 1024 * 1024;

export type DataUrlDecodeErrorCode = 'DATA_URL_TOO_LARGE' | 'DATA_URL_MALFORMED';

export interface DecodedDataUrlBytes {
    ok: true;
    mimeType: string;
    bytes: Uint8Array;
    sizeBytes: number;
    suggestedName: string;
}

export interface DataUrlDecodeError {
    ok: false;
    code: DataUrlDecodeErrorCode;
    reason: string;
    message: string;
}

export interface DecodedDataUrlAsset {
    ok: true;
    mimeType: string;
    bytes: Uint8Array;
    sizeBytes: number;
    sha256: string;
    storageRef: string;
    suggestedName: string;
}

export type DataUrlDecodeResult = DecodedDataUrlAsset | DataUrlDecodeError;

/** Synchronous decode result: bytes + mime only, no digest. */
export type DataUrlBytesResult = DecodedDataUrlBytes | DataUrlDecodeError;

const MIME_EXTENSIONS: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/bmp': '.bmp',
    'image/avif': '.avif',
    'image/x-icon': '.ico',
    'image/vnd.microsoft.icon': '.ico',
    'image/tiff': '.tif',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'text/plain': '.txt',
    'text/html': '.html',
    'text/csv': '.csv',
    'application/pdf': '.pdf',
    'application/json': '.json',
    'application/zip': '.zip',
};

function extensionForMimeType(mimeType: string): string {
    return MIME_EXTENSIONS[mimeType] ?? '.bin';
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64Strict(clean: string): Uint8Array {
    if (clean.length % 4 !== 0) throw new Error('base64 length is not a multiple of 4');
    const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    if (!/^[A-Za-z0-9+/]*$/.test(clean.slice(0, clean.length - pad))) {
        throw new Error('illegal base64 character or misplaced padding');
    }
    const out = new Uint8Array((clean.length / 4) * 3 - pad);
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const a = B64_ALPHABET.indexOf(clean[i]);
        const b = B64_ALPHABET.indexOf(clean[i + 1]);
        const c = clean[i + 2] === '=' ? 0 : B64_ALPHABET.indexOf(clean[i + 2]);
        const d = clean[i + 3] === '=' ? 0 : B64_ALPHABET.indexOf(clean[i + 3]);
        if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('illegal base64 character');
        out[o++] = (a << 2) | (b >> 4);
        if (clean[i + 2] !== '=') out[o++] = ((b & 15) << 4) | (c >> 2);
        if (clean[i + 3] !== '=') out[o++] = ((c & 3) << 6) | d;
    }
    return out;
}

function malformed(reason: string): DataUrlDecodeError {
    return { ok: false, code: 'DATA_URL_MALFORMED', reason, message: `inline data: image is malformed (${reason}); marked missing` };
}

function tooLarge(estimatedBytes: number): DataUrlDecodeError {
    const limitMiB = INLINE_DATA_URL_MAX_BYTES / (1024 * 1024);
    const reason = `data: URL payload decodes to ~${estimatedBytes} bytes, above the ${limitMiB} MiB inline decode limit`;
    return { ok: false, code: 'DATA_URL_TOO_LARGE', reason, message: `inline data: image exceeds the ${limitMiB} MiB inline decode limit; marked missing` };
}

/** Synchronous data: URL decode: bytes + mime only, no hashing. */
export function decodeDataUrl(url: string): DataUrlBytesResult {
    const comma = url.indexOf(',');
    if (comma < 0) return malformed('no comma separating the header from the payload');
    const header = url.slice(url.indexOf(':') + 1, comma);
    const payload = url.slice(comma + 1);
    const parts = header.split(';');
    const isBase64 = parts.slice(1).some((p) => p.trim().toLowerCase() === 'base64');
    const rawType = parts[0].trim().toLowerCase();
    const mimeType = rawType || 'application/octet-stream';

    let bytes: Uint8Array;
    if (isBase64) {
        const clean = payload.replace(/\s+/g, '');
        if (clean.length > 0) {
            const estimated = Math.floor((clean.length * 3) / 4);
            if (estimated > INLINE_DATA_URL_MAX_BYTES) return tooLarge(estimated);
        }
        try {
            bytes = decodeBase64Strict(clean);
        } catch (err) {
            return malformed(`base64 payload is invalid (${err instanceof Error ? err.message : String(err)})`);
        }
    } else {
        if (payload.length > INLINE_DATA_URL_MAX_BYTES) return tooLarge(payload.length);
        try {
            bytes = new TextEncoder().encode(decodeURIComponent(payload));
        } catch {
            return malformed('payload is not valid percent-encoding');
        }
    }

    const ext = extensionForMimeType(mimeType);
    return {
        ok: true,
        mimeType,
        bytes,
        sizeBytes: bytes.length,
        suggestedName: `image${ext}`,
    };
}

export function buildDataUrlStorageRef(digest: string, mimeType: string): string {
    const ext = extensionForMimeType(mimeType);
    return `assets/sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}${ext}`;
}

/**
 * Full data: URL decode: synchronous decode plus an async Web Crypto SHA-256,
 * producing the content-addressed storageRef.
 */
export async function decodeDataUrlAsset(url: string): Promise<DataUrlDecodeResult> {
    const decoded = decodeDataUrl(url);
    if (!decoded.ok) return decoded;
    const digest = await sha256Hex(decoded.bytes);
    const storageRef = buildDataUrlStorageRef(digest, decoded.mimeType);
    return {
        ok: true,
        mimeType: decoded.mimeType,
        bytes: decoded.bytes,
        sizeBytes: decoded.sizeBytes,
        sha256: digest,
        storageRef,
        suggestedName: decoded.suggestedName,
    };
}
