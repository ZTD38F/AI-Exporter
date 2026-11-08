import * as source from '../../../src/l1/parsers/gemini/rpc/sourceAttachments.js';
import type { RawImageCandidate, ImageAttachment } from '../../../src/l1/parsers/gemini/rpc/sourceAttachments.js';
export * from '../../../src/l1/parsers/gemini/rpc/sourceAttachments.js';
    const IMAGE_EXT_MIME: Record<string, string> = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
        ".bmp": "image/bmp", ".svg": "image/svg+xml", ".avif": "image/avif",
        ".tif": "image/tiff", ".tiff": "image/tiff", ".ico": "image/x-icon",
        ".heic": "image/heic", ".heif": "image/heif"
    };
    function mimeForExt(ext: string): string {
        return IMAGE_EXT_MIME[ext] || "image/jpeg";
    }

    function inferExt(url: string): string {
        try {
            let u = String(url).split("?")[0].split("#")[0];
            let m = u.match(/\.([a-z0-9]{2,5})$/i);
            if (m) {
                let ext = "." + m[1].toLowerCase();
                if (ext === ".jpeg") ext = ".jpg";
                if (IMAGE_EXT_MIME[ext]) return ext;
            }
        } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:attachments.ts]", e); }
        return ".jpg";
    }

    function normalizeRawImage(
        raw: RawImageCandidate,
        counter: { value: number }
    ): ImageAttachment {
        let ext = inferExt(raw.sourceUrl);
        const rawFileName = raw.rawFileName || (raw.title ? `${raw.title}.png` : "");
        if (rawFileName) {
            const dotIdx = rawFileName.lastIndexOf(".");
            if (dotIdx !== -1) ext = rawFileName.slice(dotIdx).toLowerCase();
        }
        const mimeType = raw.mimeType || mimeForExt(ext);
        let hashFrag = "";
        try {
            hashFrag = String(raw.sourceUrl).slice(-8).replace(/[^a-z0-9]/gi, "").slice(0, 4);
        } catch (e) {
            if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:attachments.ts]", e);
        }
        const isGenericRaw = !rawFileName || /^(?:image|img|screenshot|picture|photo|file)(?:\.[a-z0-9]+)?$/i.test(rawFileName);
        const fileName = isGenericRaw
            ? `image-${counter.value++}${hashFrag ? "-" + hashFrag : ""}${ext}`
            : rawFileName;

        return {
            sourceUrl: raw.sourceUrl,
            sourceEvidence: { detectorKind: raw.detectorKind, node: raw.evidenceNode ?? null },
            width: raw.width,
            height: raw.height,
            size: raw.size,
            token: raw.token,
            fileName,
            mimeType,
            ...(raw.detectorKind === "extractImages generated-media" ? { isGenerated: true } : {})
        };
    }


export function extractImages(obj: unknown, seqRef?: { value: number }): ImageAttachment[] {
    const counter = seqRef ?? { value: 1 };
    return source.collectImages(obj, raw => normalizeRawImage(raw, counter));
}

