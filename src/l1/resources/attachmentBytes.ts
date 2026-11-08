/** Decode raw byte carriers without interpreting provider or resource semantics. */
interface AttachmentByteInput {
    dataBuffer?: ArrayBuffer | ArrayBufferView | number[];
    dataBase64?: string;
    blobBase64?: string;
    contentMarkdown?: string;
}

function decodeBase64Payload(raw: string): Uint8Array | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const b64 = trimmed.includes(',') && /^data:/i.test(trimmed)
        ? trimmed.slice(trimmed.indexOf(',') + 1)
        : trimmed;
    const clean = b64.replace(/\s+/g, '');
    if (!clean) return null;
    try {
        if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
            const buf = Buffer.from(clean, 'base64');
            return buf.byteLength > 0 ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : null;
        }
        const binStr = atob(clean);
        if (!binStr.length) return null;
        const out = new Uint8Array(binStr.length);
        for (let k = 0; k < binStr.length; k++) out[k] = binStr.charCodeAt(k);
        return out;
    } catch {
        return null;
    }
}

export function extractAttachmentInlineBytes(a: AttachmentByteInput): Uint8Array | null {
    const buf = a.dataBuffer;
    if (buf) {
        if (buf instanceof Uint8Array) {
            return buf.byteLength > 0 ? buf : null;
        }
        if (buf instanceof ArrayBuffer) {
            return buf.byteLength > 0 ? new Uint8Array(buf) : null;
        }
        if (ArrayBuffer.isView(buf)) {
            return buf.byteLength > 0
                ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
                : null;
        }
        if (Array.isArray(buf) && buf.length > 0) {
            return new Uint8Array(buf);
        }
    }
    const rawB64 = a.dataBase64 || a.blobBase64;
    if (rawB64) {
        return decodeBase64Payload(rawB64);
    }
    if (a.contentMarkdown !== undefined) {
        const mdText = a.contentMarkdown.trim();
        if (mdText.length > 0) {
            return new TextEncoder().encode(mdText);
        }
    }
    return null;
}
