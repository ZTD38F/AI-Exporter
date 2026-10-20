import { normalizeArchiveResourceName } from '../../assets/archivePath.js';
import type { Attachment as RepoAttachment, ChatMessage as RepoMessage } from '../../../../types/conversation.js';
import type { Asset, AssetKind, AssetStatus } from '../assets.js';
import { decodeDataUrl, buildDataUrlStorageRef, sha256Hex } from '../../assets/index.js';
import type { InlineByteStore } from '../../assets/index.js';
import { classifyAssetAvailability } from '../assetResolution.js';
import type { Diagnostic } from '../diagnostics.js';
import type { ImageInline } from '../inline.js';
import type { JsonValue } from '../json.js';
import type { SourceRef } from '../provenance.js';
import { extractImages } from '../../../api/parser/attachments.js';

export interface AssetLinkIndex {
    byRef: Map<string, string>;
    byBasename: Map<string, Set<string>>;
}

export function newAssetLinkIndex(): AssetLinkIndex {
    return { byRef: new Map(), byBasename: new Map() };
}

export function assetRefKeys(ref: string): string[] {
    const keys = [ref];
    const noPrefix = ref.replace(/^assets\//, '');
    if (noPrefix !== ref) keys.push(noPrefix);
    try {
        const decoded = decodeURIComponent(noPrefix);
        if (decoded !== noPrefix) keys.push(decoded);
    } catch {
    }
    return keys;
}

export function assetBasename(ref: string): string | undefined {
    const noPrefix = ref.replace(/^assets\//, '');
    const base = noPrefix.split('/').pop() ?? '';
    return base && base !== noPrefix ? base : undefined;
}

export function indexAssetRef(index: AssetLinkIndex, ref: string, assetId: string): void {
    for (const key of assetRefKeys(ref)) index.byRef.set(key, assetId);
    const base = assetBasename(ref);
    if (base) {
        let set = index.byBasename.get(base);
        if (!set) {
            set = new Set();
            index.byBasename.set(base, set);
        }
        set.add(assetId);
    }
}

export function dataUrlPreview(url: string): string {
    const head = url.slice(0, 64);
    return url.length > 64 ? `${head}…(${url.length} chars total)` : head;
}

const PENDING_INLINE_REF_PREFIX = 'assets/pending-inline/';

function pendingInlineRef(assetId: string): string {
    return `${PENDING_INLINE_REF_PREFIX}${assetId}`;
}

/**
 * Web Crypto digest step for inline data: URL assets. The synchronous
 * inline-parsing path only decodes bytes; this async pass — owned by the
 * async normalization entry point — computes the SHA-256 digests and swaps
 * the provisional byte-store refs for content-addressed storageRefs.
 */
export async function finalizeInlineAssetDigests(
    assets: readonly Asset[],
    byteStore: InlineByteStore,
): Promise<void> {
    for (const asset of assets) {
        const ref = asset.storageRef;
        if (!ref || !ref.startsWith(PENDING_INLINE_REF_PREFIX)) continue;
        const bytes = byteStore.get(ref);
        if (!bytes) continue;
        const digest = await sha256Hex(bytes);
        const storageRef = buildDataUrlStorageRef(digest, asset.mimeType ?? 'application/octet-stream');
        byteStore.put(storageRef, bytes);
        byteStore.remove(ref);
        asset.sha256 = digest;
        asset.storageRef = storageRef;
    }
}

export interface AssetParserContext {
    diagnostics: Diagnostic[];
    sourceRef: SourceRef;
    assetIndex: AssetLinkIndex;
    inlineAssets: Asset[];
    idPrefix: string;
    byteStore: InlineByteStore;
}

export function makeImageInline(assetId: string, alt: string, title: string | undefined): ImageInline {
    const cleanAlt = alt.trim();
    return {
        type: 'image',
        assetId,
        ...(cleanAlt ? { alt: cleanAlt } : {}),
        ...(title ? { title } : {}),
    };
}

export function linkInlineImage(src: string, alt: string, title: string | undefined, st: AssetParserContext): ImageInline {
    const trimmedSrc = src.trim();
    for (const key of assetRefKeys(trimmedSrc)) {
        const hit = st.assetIndex.byRef.get(key);
        if (hit) {
            return makeImageInline(hit, alt, title);
        }
    }
    let ambiguous = false;
    const base = assetBasename(trimmedSrc) ?? trimmedSrc;
    if (base) {
        const candidates = st.assetIndex.byBasename.get(base);
        if (candidates && candidates.size === 1) {
            return makeImageInline([...candidates][0], alt, title);
        }
        if (candidates && candidates.size > 1) {
            ambiguous = true;
            const ids = [...candidates].sort();
            st.diagnostics.push({
                id: `inline-image-ambiguous:${ids.join(',')}`,
                severity: 'warning',
                code: 'AMBIGUOUS_INLINE_IMAGE_ASSET',
                message: `inline image '${trimmedSrc.slice(0, 120)}' basename '${base}' matches ${ids.length} attachments; refusing to bind an arbitrary one`,
                sourceRef: st.sourceRef,
                details: { src: trimmedSrc.slice(0, 200), assetIds: ids } as JsonValue,
            });
        }
    }
    const assetId = `${st.idPrefix}-img${st.inlineAssets.length}`;
    const fileBase = (trimmedSrc.split('/').pop() ?? '').split('?')[0];
    const altName = alt.trim();
    let name = altName || fileBase || 'image';
    let status: AssetStatus;
    let sourceUrl: string | undefined;
    let storageRef: string | undefined;
    let mimeType: string | undefined;
    let sizeBytes: number | undefined;
    let failureReason: string | undefined;
    let dataUrlDiag: { code: 'DATA_URL_TOO_LARGE' | 'DATA_URL_MALFORMED'; message: string } | undefined;
    if (/^data:/i.test(trimmedSrc)) {
        // Omit sourceUrl so the raw data: URI payload is not duplicated in the serialized bundle.
        // Decoding stays synchronous here; the Web Crypto digest is computed by
        // finalizeInlineAssetDigests() once parsing reaches the async normalization layer.
        const decoded = decodeDataUrl(trimmedSrc);
        if (decoded.ok) {
            status = 'available';
            storageRef = pendingInlineRef(assetId);
            mimeType = decoded.mimeType;
            sizeBytes = decoded.sizeBytes;
            name = altName || decoded.suggestedName;
            st.byteStore.put(storageRef, decoded.bytes);
        } else {
            status = 'missing';
            failureReason = decoded.reason;
            dataUrlDiag = { code: decoded.code, message: decoded.message };
            // fileBase contains the base64 payload after 'image/<subType>'; avoid leaking it into name.
            if (!altName) name = 'image';
        }
    } else if (/^https?:\/\//i.test(trimmedSrc)) {
        status = 'remote';
        sourceUrl = trimmedSrc;
    } else if (/^blob:/i.test(trimmedSrc)) {
        status = 'missing';
        failureReason = 'blob: URL is not resolvable outside the originating page';
    } else {
        status = 'missing';
        failureReason = `inline image '${trimmedSrc.slice(0, 120)}' has no matching attachment or resolvable URL`;
    }
    st.inlineAssets.push({
        id: assetId,
        kind: 'image',
        name,
        ...(mimeType ? { mimeType } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(storageRef ? { storageRef } : {}),
        status,
        ...(failureReason ? { failureReason } : {}),
    });
    indexAssetRef(st.assetIndex, trimmedSrc, assetId);
    if (status === 'missing' && !ambiguous) {
        if (dataUrlDiag) {
            st.diagnostics.push({
                id: `inline-image-dataurl:${assetId}`,
                severity: 'warning',
                code: dataUrlDiag.code,
                message: dataUrlDiag.message,
                sourceRef: st.sourceRef,
                details: { src: dataUrlPreview(trimmedSrc) } as JsonValue,
            });
        } else {
            st.diagnostics.push({
                id: `inline-image-missing:${assetId}`,
                severity: 'warning',
                code: 'INLINE_IMAGE_ASSET_MISSING',
                message: `inline image '${name}' has no resolvable asset; renderers fall back to alt text`,
                sourceRef: st.sourceRef,
                details: { src: trimmedSrc.slice(0, 200) } as JsonValue,
            });
        }
    }
    return makeImageInline(assetId, alt, title);
}

export function mergeMessageAttachments(m: RepoMessage): RepoAttachment[] {
    const atts: RepoAttachment[] = [];
    const push = (a: RepoAttachment): void => {
        if (!a || typeof a !== 'object') return;
        const key = a.localName || a.url || a.sourceUrl || a.resolvedUrl || a.src;
        if (key) {
            const existing = atts.find((x) => (x.localName || x.url || x.sourceUrl || x.resolvedUrl || x.src) === key);
            if (existing) {
                for (const [k, v] of Object.entries(a)) {
                    if (v !== undefined && (existing as any)[k] === undefined) {
                        (existing as any)[k] = v;
                    }
                }
                return;
            }
        }
        const aToken = (a as any).token;
        if (aToken) {
            const existingToken = atts.find((x) => (x as any).token === aToken);
            if (existingToken) {
                if ((a as any).isGenerated && !(existingToken as any).isGenerated) {
                    for (const [k, v] of Object.entries(a)) {
                        if (v !== undefined) {
                            (existingToken as any)[k] = v;
                        }
                    }
                } else {
                    for (const [k, v] of Object.entries(a)) {
                        if (v !== undefined && (existingToken as any)[k] === undefined) {
                            (existingToken as any)[k] = v;
                        }
                    }
                }
                if (!existingToken.dataBuffer && a.dataBuffer) existingToken.dataBuffer = a.dataBuffer;
                if (!existingToken.blobBase64 && a.blobBase64) existingToken.blobBase64 = a.blobBase64;
                return;
            }
        }
        const aReqId = (a.providerRequestId || a.generation?.providerRequestId || '').toLowerCase().replace(/^r_/, '');
        if (aReqId) {
            const aOrd = a.imageOrdinal ?? a.generation?.imageOrdinal ?? 0;
            const existingGen = atts.find((x) => {
                const xReqId = (x.providerRequestId || x.generation?.providerRequestId || '').toLowerCase().replace(/^r_/, '');
                if (!xReqId || xReqId !== aReqId) return false;
                const aChat = String(a.generation?.chatId || '').trim().replace(/^c_/, '');
                const xChat = String(x.generation?.chatId || '').trim().replace(/^c_/, '');
                if (aChat && xChat && aChat !== xChat) return false;
                const xOrd = x.imageOrdinal ?? x.generation?.imageOrdinal ?? 0;
                return xOrd === aOrd;
            });
            if (existingGen) {
                for (const [k, v] of Object.entries(a)) {
                    if (v !== undefined && (existingGen as any)[k] === undefined) {
                        (existingGen as any)[k] = v;
                    }
                }
                if (!existingGen.dataBuffer && a.dataBuffer) existingGen.dataBuffer = a.dataBuffer;
                if (!existingGen.blobBase64 && a.blobBase64) existingGen.blobBase64 = a.blobBase64;
                return;
            }
        }
        atts.push({ ...a });
    };
    for (const a of m.attachments ?? []) push(a);
    for (const img of m.images ?? []) push({ ...img, type: img.type || 'image' });
    for (const doc of (m.documents ?? []) as RepoAttachment[]) push({ ...doc, type: doc.type || 'file' });
    if ((!m.images || m.images.length === 0) && (!m.attachments || m.attachments.length === 0) && m.structuredContent) {
        const scImages = extractImages(m.structuredContent);
        for (const img of scImages) {
            push({
                ...img,
                type: 'image',
                src: img.sourceUrl,
                name: img.fileName,
                title: img.fileName,
            });
        }
    }
    return atts;
}

export function attachmentDisplayName(a: RepoAttachment, isImage: boolean): string {
    return a.title || a.name || a.fileName || a.localName?.split('/').pop() || (isImage ? 'image.jpg' : 'file');
}

export function classifyAttachmentKind(a: RepoAttachment): { kind: AssetKind; isImage: boolean; diag?: string } {
    const mime = (a.mimeType || a.mime || '').toLowerCase();
    const name = attachmentDisplayName(a, false);
    const isImage = a.type === 'image' || a.isImage === true ||
        mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|bmp|avif)$/i.test(name);
    if (isImage) return { kind: 'image', isImage: true };
    if (mime.startsWith('audio/')) return { kind: 'audio', isImage: false };
    if (mime.startsWith('video/')) return { kind: 'video', isImage: false };
    if (a.type === 'file' || a.type === 'doc' || a.type === 'code' || mime) return { kind: 'file', isImage: false };
    return {
        kind: 'other',
        isImage: false,
        diag: `unrecognized attachment type '${String(a.type)}'; mapped to kind 'other'`,
    };
}

export function normalizeLocalName(localName: string): string {
    return normalizeArchiveResourceName(localName);
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

export function extractAttachmentInlineBytes(a: RepoAttachment): Uint8Array | null {
    const buf = a.dataBuffer;
    if (buf) {
        if (buf instanceof Uint8Array) {
            return buf.byteLength > 0 ? buf : null;
        }
        if (typeof ArrayBuffer !== 'undefined' && buf instanceof ArrayBuffer) {
            return buf.byteLength > 0 ? new Uint8Array(buf) : null;
        }
        if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(buf)) {
            const view = buf as ArrayBufferView;
            return view.byteLength > 0
                ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
                : null;
        }
        if (Array.isArray(buf) && buf.length > 0) {
            return new Uint8Array(buf);
        }
    }
    const rawB64 = typeof a.dataBase64 === 'string' && a.dataBase64
        ? a.dataBase64
        : (typeof a.blobBase64 === 'string' && a.blobBase64 ? a.blobBase64 : '');
    if (rawB64) {
        return decodeBase64Payload(rawB64);
    }
    if (typeof (a as any).contentMarkdown === 'string') {
        const mdText = ((a as any).contentMarkdown as string).trim();
        if (mdText.length > 0) {
            return new TextEncoder().encode(mdText);
        }
    }
    return null;
}

export interface AssetBuild {
    asset: Asset;
    diagnostics: Diagnostic[];
    isImage: boolean;
}

export function buildAsset(
    a: RepoAttachment,
    id: string,
    sourceRef: SourceRef,
    byteStore?: InlineByteStore,
): AssetBuild {
    const diagnostics: Diagnostic[] = [];
    const { kind, isImage, diag } = classifyAttachmentKind(a);
    if (diag) {
        diagnostics.push({
            id: `asset-kind:${id}`,
            severity: 'info',
            code: 'ASSET_KIND_FALLBACK',
            message: diag,
            sourceRef,
            details: { rawType: String(a.type ?? null) } as JsonValue,
        });
    }
    const rawLocal = a.localName || '';
    const localIsUrl = /^https?:\/\//i.test(rawLocal);
    const inlineBytes = extractAttachmentInlineBytes(a);
    const hasInlineBytes = inlineBytes !== null && inlineBytes.byteLength > 0;
    const hasLocalFile = !!rawLocal && !localIsUrl;
    const url = a.resolvedUrl || a.sourceUrl || a.url || a.src || (localIsUrl ? rawLocal : undefined);
    const explicitFailureReason = typeof (a as any).failureReason === 'string' && (a as any).failureReason.trim()
        ? (a as any).failureReason.trim()
        : undefined;

    let status: AssetStatus;
    let storageRef: string | undefined;
    let sourceUrl: string | undefined;
    let failureReason: string | undefined;
    if (hasInlineBytes) {
        status = 'available';
        storageRef = hasLocalFile
            ? normalizeLocalName(rawLocal)
            : (byteStore ? pendingInlineRef(id) : normalizeLocalName(attachmentDisplayName(a, isImage)));
        if (byteStore && storageRef && inlineBytes) {
            byteStore.put(storageRef, inlineBytes);
        }
        if (url) sourceUrl = url;
    } else if (explicitFailureReason) {
        status = 'failed';
        failureReason = explicitFailureReason;
        if (url) sourceUrl = url;
    } else if (hasLocalFile) {
        status = 'available';
        storageRef = normalizeLocalName(rawLocal);
        if (url) sourceUrl = url;
    } else if (url) {
        status = 'remote';
        sourceUrl = url;
        if (localIsUrl) {
            diagnostics.push({
                id: `asset-pseudo-local:${id}`,
                severity: 'info',
                code: 'PSEUDO_LOCAL_URL',
                message: `attachment localName is a remote URL; treating as remote, not local`,
                sourceRef,
                details: { localName: rawLocal } as JsonValue,
            });
        }
    } else {
        status = 'missing';
        failureReason = 'no usable bytes, local file or URL in attachment record';
        diagnostics.push({
            id: `asset-no-source:${id}`,
            severity: 'warning',
            code: 'ATTACHMENT_NO_SOURCE',
            message: `attachment has no usable bytes, local file or URL; marked missing`,
            sourceRef,
            details: { rawType: String(a.type ?? null) } as JsonValue,
        });
    }

    const mimeType = a.mimeType || a.mime || undefined;
    const sizeBytes = typeof a.size === 'number' ? a.size : (inlineBytes ? inlineBytes.byteLength : undefined);
    const asset: Asset = {
        id,
        kind,
        name: attachmentDisplayName(a, isImage),
        ...(mimeType ? { mimeType } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(typeof a.width === 'number' && typeof a.height === 'number'
            ? { dimensions: { widthPx: a.width, heightPx: a.height } }
            : {}),
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(storageRef ? { storageRef } : {}),
        status,
        ...(failureReason ? { failureReason } : {}),
    };
    const classified = classifyAssetAvailability(asset, hasInlineBytes || (hasLocalFile && !explicitFailureReason));
    if (classified.diagnostic) diagnostics.push(classified.diagnostic);
    return { asset, diagnostics, isImage };
}
