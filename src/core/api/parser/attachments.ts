import { isInternalChipUrl as canonicalIsInternalChipUrl } from "../../utils/chipUtils.js";

export interface ImageAttachment {
    sourceEvidence?: { detectorKind: string; node: unknown };
    isGenerated?: boolean;
    providerRequestId?: string;
    imageOrdinal?: number;
    sourceUrl: string;
    width?: number;
    height?: number;
    size?: number;
    token?: string;
    fileName?: string;
    mimeType?: string;
}

export interface UserFileAttachment {
    sourceUrl: string;
    fileName: string;
    id: string;
    thumbnailUrl?: string;
}

export interface DeepResearchDocMeta {
    id: string;
    title: string;
    chipUrl?: string;
    createdAt?: number;
    contentId?: string;
    source?: "strict" | "heuristic-flat";
}

export interface DocLink {
    title: string;
    url: string;
}

export interface DocSectionsResult {
    sections: string[];
    links: DocLink[];
    contentMarkdown: string;
    contentMatch?: "exact" | "substring";
}

export interface GeminiParserAttachmentsModule {
    IMAGE_GEN_RE: RegExp;
    highResVariant: (url?: string | null) => string;
    isInternalChipUrl: (u?: string | null) => boolean;
    extractImageSelectionIndex: (sourceUrl?: string | null) => number | undefined;
    getImageDedupKey: (imageObj: Partial<ImageAttachment>) => string;
    filterNewImages: (images: ImageAttachment[], seenSet: Set<string>) => ImageAttachment[];
    extractImages: (obj: unknown, seqRef?: { value: number }) => ImageAttachment[];
    extractResponseImages: (candidate: unknown, visibleMedia: unknown, text: string, seqRef?: { value: number }) => ImageAttachment[];
    extractUserFiles: (turnUserArr: unknown) => UserFileAttachment[];
    extractDocumentsMeta: (root: unknown) => DeepResearchDocMeta[];
    findDocContentById: (root: unknown, docId: string) => unknown;
    parseDocSections: (docContentArr: unknown) => DocSectionsResult;
    findDocMarkdownByClues: (root: unknown, metaItem?: DeepResearchDocMeta | null) => string;
    itemMatchesFilename: (name?: string | null) => boolean;
    extractFileNameFromUrl: (url: string) => string | null;
}

import { deepWalk, RESEARCH_PROMPT_PREFIX_RE, GEMINI_JSPB_SCHEMA } from "./extractors.js";

const IMAGE_GEN_RE = /https?:\/\/googleusercontent\.com\/(?:image_generation_content|imagegenerationcontent|generated_image)\/([a-zA-Z0-9_-]+)/i;

    const GOOGLE_MEDIA_HOST_RE = /(^|\.)googleusercontent\.com$|(^|\.)usercontent\.google\.com$|(^|\.)drive\.google\.com$|(^|\.)docs\.google\.com$|(^|\.)gstatic\.com$/i;
    function getUrlHost(u: string): string {
        const m = /^https?:\/\/([^/:?#]+)/i.exec(u || "");
        return m ? m[1].toLowerCase() : "";
    }
    function isGoogleMediaHost(u: string): boolean {
        return GOOGLE_MEDIA_HOST_RE.test(getUrlHost(u));
    }

    function warnWhitelistDropOnce(warned: Set<string>, url: string, kind: string): void {
        try {
            let host = getUrlHost(url);
            let key = kind + "|" + host;
            if (warned.has(key)) return;
            warned.add(key);
            if (typeof console !== "undefined" && console.warn) {
                console.warn(`[Gemini Exporter] media URL skipped (host not in whitelist, ${kind}): host=${host} url=${String(url).slice(0, 220)}`);
            }
        } catch (e) { /* ignore */ }
    }

    function extractImageSelectionIndex(sourceUrl?: string | null): number | undefined {
        if (!sourceUrl || typeof sourceUrl !== "string") return undefined;
        let match = sourceUrl.match(IMAGE_GEN_RE);
        if (!match) return undefined;
        if (!/^\d+$/.test(match[1])) return void 0;
        return parseInt(match[1], 10);
    }

    function getImageDedupKey(imageObj: Partial<ImageAttachment>): string {
        return imageObj.token
            ? `token:${imageObj.token}`
            : (imageObj.sourceUrl || [imageObj.fileName, imageObj.mimeType, imageObj.width, imageObj.height, imageObj.size].filter(x => x != null && x !== "").join(":"));
    }

    function filterNewImages(images: ImageAttachment[], seenSet: Set<string>): ImageAttachment[] {
        return images.filter(img => {
            let key = getImageDedupKey(img);
            if (!key) return true;
            if (seenSet.has(key)) return false;
            seenSet.add(key);
            return true;
        });
    }

    function highResVariant(url?: string | null): string {
        if (!url || typeof url !== "string") return url || "";
        if (url.includes("googleusercontent.com/p/") || url.includes("/places/v1/media")) {
            return url;
        }
        const qIdx = url.indexOf("?");
        const base = qIdx === -1 ? url : url.slice(0, qIdx);
        const query = qIdx === -1 ? "" : url.slice(qIdx);
        let resized = base.replace(/=[sw]\d+(?:-[a-z0-9]+)*$/i, "=s0");
        if ((base.includes("/gg/") || base.includes("/rd-gg/")) && !/=[sw]\d+/i.test(base) && !base.endsWith("=s0")) {
            resized = base + "=s0";
        }
        return resized + query;
    }

    function isInternalChipUrl(u?: string | null): boolean {
        return canonicalIsInternalChipUrl(u);
    }

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

    interface RawImageCandidate {
        evidenceNode?: unknown;
        sourceUrl: string;
        width?: number;
        height?: number;
        size?: number;
        token?: string;
        rawFileName?: string;
        mimeType?: string;
        detectorKind: string;
    }

    type ImageNodeDetector = (node: any, schema: typeof GEMINI_JSPB_SCHEMA) => RawImageCandidate | null;

    const detectInlineImageTuple: ImageNodeDetector = (node, schema) => {
        if (!Array.isArray(node)) return null;
        const inl = schema.INLINE_IMAGE;
        const url = node[inl.URL];
        const width = node[inl.WIDTH];
        const height = node[inl.HEIGHT];
        if (
            node.length >= 3 &&
            typeof url === "string" &&
            url.startsWith("http") &&
            typeof width === "number" &&
            typeof height === "number"
        ) {
            return {
                sourceUrl: url,
                width,
                height,
                token: typeof node[inl.TOKEN] === "string" ? node[inl.TOKEN] : void 0,
                detectorKind: "extractImages [url,w,h]"
            };
        }
        return null;
    };

    const detectGeneratedMediaNode: ImageNodeDetector = (node, schema) => {
        if (!Array.isArray(node)) return null;
        const gen = schema.GENERATED_IMAGE;
        const url = node[gen.URL];
        const filename = node[gen.FILENAME];
        const mimeTypeVal = node[gen.MIME_TYPE];
        const dims = node[gen.DIMENSIONS];
        if (
            node.length >= 4 &&
            typeof url === "string" &&
            url.startsWith("http") &&
            (
                (typeof filename === "string" && (/\.(jpe?g|png|webp|gif)$/i.test(filename) || /watermarked_img_/i.test(filename))) ||
                (typeof mimeTypeVal === "string" && mimeTypeVal.startsWith("image/")) ||
                (Array.isArray(dims) && typeof dims[0] === "number" && typeof dims[1] === "number")
            )
        ) {
            // Derivative upscale renditions (e.g. 2x with UPSCALE_FACTOR > 1) are secondary variants,
            // not the authoritative source generation.
            if (typeof node[gen.UPSCALE_FACTOR] === "number" && node[gen.UPSCALE_FACTOR] > 1) {
                return null;
            }
            const rawFileName = (typeof filename === "string" && filename.trim()) ? filename.trim() : "";
            const width = Array.isArray(dims) && typeof dims[0] === "number" ? dims[0] : void 0;
            const height = Array.isArray(dims) && typeof dims[1] === "number" ? dims[1] : void 0;
            const size = Array.isArray(dims) && typeof dims[2] === "number" ? dims[2] : void 0;
            const mimeType = typeof mimeTypeVal === "string" ? mimeTypeVal : void 0;
            const token = typeof node[gen.TOKEN] === "string" ? node[gen.TOKEN] : void 0;
            return {
                sourceUrl: url,
                width,
                height,
                size,
                token,
                rawFileName,
                mimeType,
                detectorKind: "extractImages generated-media"
            };
        }
        return null;
    };

    const detectAttachmentType36: ImageNodeDetector = (node) => {
        // Form 1: Deserialized object with attachmentType === 36 (runtime structured content node / attachment)
        if (node && typeof node === "object" && !Array.isArray(node) && (node as any).attachmentType === 36) {
            const obj = node as any;
            const kc = typeof obj.Kc === "string" ? obj.Kc : undefined;
            const ze = typeof obj.Ze === "string" ? obj.Ze : (typeof obj.NHc === "string" ? obj.NHc : undefined);
            const imgUrl = typeof obj.imageUrl === "string" ? obj.imageUrl : undefined;
            const title = typeof obj.title === "string" ? obj.title.trim() : undefined;
            const width = typeof obj.imageWidth === "number" ? obj.imageWidth : undefined;
            const height = typeof obj.imageHeight === "number" ? obj.imageHeight : undefined;

            const sourceUrl = (kc && isGoogleMediaHost(kc))
                ? kc
                : ((ze && isGoogleMediaHost(ze))
                    ? ze
                    : ((imgUrl && isGoogleMediaHost(imgUrl))
                        ? imgUrl
                        : (kc || ze || imgUrl || "")));

            if (!sourceUrl || !sourceUrl.startsWith("http")) return null;

            return {
                sourceUrl,
                width,
                height,
                rawFileName: title ? `${title}.png` : undefined,
                detectorKind: "extractImages attachmentType:36"
            };
        }

        // Form 2: Wire format tuple for search image attachment (repeated array with image URLs and title)
        if (Array.isArray(node) && node.length >= 8) {
            const slot0 = node[0];
            const slot3 = node[3];
            const slot7 = node[7];
            const gstaticTuple = Array.isArray(slot3) && slot3.length >= 4
                ? slot3
                : (Array.isArray(slot0) && slot0.length >= 4 ? slot0 : null);
            if (gstaticTuple && Array.isArray(gstaticTuple[0]) && typeof gstaticTuple[0][0] === "string") {
                const rawUrl = gstaticTuple[0][0];
                const width = typeof gstaticTuple[2] === "number" ? gstaticTuple[2] : undefined;
                const height = typeof gstaticTuple[3] === "number" ? gstaticTuple[3] : undefined;

                let title: string | undefined;
                let fallbackGoogleUrl: string | undefined;
                if (Array.isArray(slot7) && typeof slot7[0] === "string") {
                    fallbackGoogleUrl = slot7[0];
                    if (typeof slot7[2] === "string" && slot7[2].trim()) {
                        title = slot7[2].trim();
                    }
                }

                const sourceUrl = (isGoogleMediaHost(rawUrl))
                    ? rawUrl
                    : (fallbackGoogleUrl && isGoogleMediaHost(fallbackGoogleUrl) ? fallbackGoogleUrl : rawUrl);

                if (!sourceUrl || !sourceUrl.startsWith("http")) return null;

                return {
                    sourceUrl,
                    width,
                    height,
                    rawFileName: title ? `${title}.png` : undefined,
                    detectorKind: "extractImages attachmentType:36"
                };
            }
        }
        return null;
    };

    const IMAGE_DETECTORS: ImageNodeDetector[] = [
        detectGeneratedMediaNode,
        detectInlineImageTuple,
        detectAttachmentType36
    ];

    function normalizeRawImage(
        raw: RawImageCandidate,
        counter: { value: number }
    ): ImageAttachment {
        let ext = inferExt(raw.sourceUrl);
        const rawFileName = raw.rawFileName || "";
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

    function extractImages(obj: unknown, seqRef?: { value: number }): ImageAttachment[] {
        const images: ImageAttachment[] = [];
        const seenKeys = new Set<string>();
        const warnedHosts = new Set<string>();
        const counter = seqRef && typeof seqRef.value === "number" ? seqRef : { value: 1 };

        deepWalk(obj, (node) => {
            if (!node || typeof node !== "object") return;

            for (const detector of IMAGE_DETECTORS) {
                const raw = detector(node, GEMINI_JSPB_SCHEMA);
                if (!raw) continue;

                if (isInternalChipUrl(raw.sourceUrl)) {
                    return;
                }

                if (!isGoogleMediaHost(raw.sourceUrl)) {
                    warnWhitelistDropOnce(warnedHosts, raw.sourceUrl, raw.detectorKind);
                    return;
                }

                // Keep the matched media tuple (not the conversation body) for failed
                // attachment diagnostics, so false detections can be reproduced.
                const evidenceJson = JSON.stringify(node);
                raw.evidenceNode = evidenceJson.length <= 12000
                    ? JSON.parse(evidenceJson)
                    : { truncated: true, preview: evidenceJson.slice(0, 12000) };
                const img = normalizeRawImage(raw, counter);
                if (img.token) {
                    const existingIdx = images.findIndex(existing => existing.token === img.token);
                    if (existingIdx !== -1) {
                        if (img.isGenerated && !images[existingIdx].isGenerated) {
                            const oldKey = getImageDedupKey(images[existingIdx]);
                            seenKeys.delete(oldKey);
                            const newKey = getImageDedupKey(img);
                            seenKeys.add(newKey);
                            images[existingIdx] = img;
                        }
                        return;
                    }
                }

                const key = getImageDedupKey(img);
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    images.push(img);
                }
                return;
            }
        });
        return images;
    }

    function extractResponseImages(candidate: unknown, visibleMedia: unknown, text: string, seqRef?: { value: number }): ImageAttachment[] {
        const visibleKeys = new Set(extractImages(visibleMedia).map(getImageDedupKey));
        const inlineUrls = new Set<string>();
        for (const match of text.matchAll(/!\[[^\]]*\]\(<?(https?:\/\/[^\s)>]+)>?(?:\s+[^)]*)?\)|<img\b[^>]*\bsrc=["'](https?:\/\/[^"']+)["']/gi)) {
            inlineUrls.add(match[1] || match[2]);
        }
        return extractImages([candidate, visibleMedia], seqRef).filter(image => {
            if (image.sourceEvidence?.detectorKind !== 'extractImages attachmentType:36') return true;
            // Search results in candidate metadata are not automatically answer images.
            // Require an attachment in the answer document/body or a real inline image URL.
            return visibleKeys.has(getImageDedupKey(image)) || inlineUrls.has(image.sourceUrl);
        });
    }

    function itemMatchesFilename(name?: string | null): boolean {
        if (typeof name !== "string") return false;
        const trimmed = name.trim();
        if (!trimmed) return false;
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return false;
        if (trimmed.startsWith("//") || trimmed.includes("://")) return false;
        if (trimmed.includes("?") || trimmed.includes("&") || trimmed.includes("=")) return false;
        if (trimmed.includes("/") || trimmed.includes("\\")) return false;
        return /\.[a-zA-Z0-9_-]{1,20}$/.test(trimmed);
    }

    function extractFileNameFromUrl(url: string): string | null {
        if (!url || typeof url !== "string") return null;
        try {
            const qIdx = url.indexOf("?");
            if (qIdx !== -1) {
                const query = url.slice(qIdx);
                const m = query.match(/[?&](?:file_?name|name|title)=([^&#]+)/i);
                if (m && m[1]) {
                    try {
                        const decoded = decodeURIComponent(m[1]).trim();
                        if (decoded && !decoded.includes("://") && !decoded.includes("/") && !decoded.includes("\\")) {
                            return decoded;
                        }
                    } catch {
                        const raw = m[1].trim();
                        if (raw && !raw.includes("://") && !raw.includes("/")) return raw;
                    }
                }
            }
            const cleanPath = url.split("?")[0].split("#")[0];
            const lastSlash = cleanPath.lastIndexOf("/");
            if (lastSlash !== -1) {
                const candidate = cleanPath.slice(lastSlash + 1);
                if (candidate && itemMatchesFilename(candidate)) {
                    try {
                        return decodeURIComponent(candidate);
                    } catch {
                        return candidate;
                    }
                }
            }
            if (qIdx !== -1) {
                const query = url.slice(qIdx);
                const segments = query.split(/[&;]/);
                for (const seg of segments) {
                    const eqIdx = seg.indexOf("=");
                    if (eqIdx !== -1) {
                        const val = seg.slice(eqIdx + 1);
                        const parts = val.split(/[/\\]/);
                        const lastPart = parts[parts.length - 1];
                        try {
                            const dec = decodeURIComponent(lastPart).trim();
                            if (dec && itemMatchesFilename(dec)) return dec;
                        } catch {
                            if (lastPart && itemMatchesFilename(lastPart)) return lastPart;
                        }
                    }
                }
            }
        } catch { /* ignore */ }
        return null;
    }

    function extractUserFiles(turnUserArr: unknown): UserFileAttachment[] {
        let files: UserFileAttachment[] = [];
        if (!Array.isArray(turnUserArr)) return files;
        let warnedHosts = new Set<string>();
        let seenUrls = new Set<string>();

        deepWalk(turnUserArr, (node) => {
            if (!Array.isArray(node)) return;

            const googleUrls: string[] = [];
            const filenames: string[] = [];
            let fallbackId = "";

            for (let i = 0; i < node.length; i++) {
                const item = node[i];
                if (typeof item === "string") {
                    const trimmed = item.trim();
                    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
                        // A prompt containing a URL is prose, not a file attachment.
                        // Docs editor/share links also remain links in the prompt.
                        if (/\s/.test(trimmed) || /^https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\//i.test(trimmed)) continue;
                        if (isGoogleMediaHost(trimmed) && !isInternalChipUrl(trimmed)) {
                            googleUrls.push(trimmed);
                        } else if (!isGoogleMediaHost(trimmed) && !isInternalChipUrl(trimmed)) {
                            warnWhitelistDropOnce(warnedHosts, trimmed, "extractUserFiles [url]");
                        }
                    } else if (itemMatchesFilename(trimmed)) {
                        filenames.push(trimmed);
                    } else if (trimmed && !fallbackId && trimmed.length < 100) {
                        fallbackId = trimmed;
                    }
                }
            }

            if (!googleUrls.length) return;

            const downloadUrls = googleUrls.filter(u =>
                u.includes("/download") ||
                u.includes("c=bard_storage") ||
                /[?&](?:file_?name|name)=/i.test(u) ||
                u.includes("contribution.usercontent")
            );
            const thumbUrls = googleUrls.filter(u =>
                u.includes("/viewer/thumb") ||
                u.includes("drive.google.com/viewer")
            );

            let sourceUrl = downloadUrls[0] || googleUrls.find(u => !thumbUrls.includes(u)) || googleUrls[0];
            let thumbnailUrl = thumbUrls[0] || (sourceUrl !== googleUrls[0] ? googleUrls[0] : undefined);

            if (seenUrls.has(sourceUrl)) return;
            seenUrls.add(sourceUrl);

            let fileName = filenames[0] || extractFileNameFromUrl(sourceUrl) || (thumbnailUrl ? extractFileNameFromUrl(thumbnailUrl) : null);
            if (!fileName) {
                for (const u of googleUrls) {
                    const fn = extractFileNameFromUrl(u);
                    if (fn) { fileName = fn; break; }
                }
            }
            if (!fileName) {
                fileName = "attachment";
            }

            const id = fallbackId || fileName || sourceUrl;
            files.push({
                sourceUrl,
                fileName,
                id,
                thumbnailUrl
            });
        });
        return files;
    }

    function extractDocumentsMeta(root: unknown): DeepResearchDocMeta[] {
        let out: DeepResearchDocMeta[] = [];
        let uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
        const researchPrefixRe = RESEARCH_PROMPT_PREFIX_RE;
        const doc = GEMINI_JSPB_SCHEMA.DEEP_RESEARCH_DOC;

        function pushMeta(metaObj: DeepResearchDocMeta) {
            if (metaObj.id && metaObj.title) {
                let cleanTitle = metaObj.title;
                if (researchPrefixRe.test(cleanTitle)) {
                    cleanTitle = "";
                }
                // deepWalk 会访问嵌套的每一层数组，同一文档可能被重复发现 —— 按 id 去重
                const key = metaObj.id || metaObj.chipUrl || "";
                if (key && out.some(m => (m.id || m.chipUrl || "") === key)) return;
                out.push({
                    id: metaObj.id,
                    title: cleanTitle,
                    chipUrl: metaObj.chipUrl,
                    createdAt: metaObj.createdAt,
                    contentId: metaObj.contentId,
                    source: metaObj.source
                });
            }
        }

        // Pass 1: strict path only — typed indices, never marked heuristic.
        deepWalk([root], (node) => {
            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) {
                    let item = node[i];
                    if (Array.isArray(item) && item.length >= 4 && Array.isArray(item[doc.CHIP_URL]) && item[doc.CHIP_URL].length > 0 && typeof item[doc.CHIP_URL][0] === "string" && item[doc.CHIP_URL][0].includes("immersive_entry_chip") && typeof item[doc.ID] === "string" && typeof item[doc.TITLE] === "string") {
                        let chipUrl = item[doc.CHIP_URL][0],
                            id = item[doc.ID],
                            rawTitle = item[doc.TITLE];
                        let title = researchPrefixRe.test(rawTitle) ? "" : rawTitle;
                        let createdAt: number | undefined;
                        if (Array.isArray(item[doc.TIMESTAMP]) && typeof item[doc.TIMESTAMP][0] === "number") createdAt = 1000 * item[doc.TIMESTAMP][0];
                        let contentId = typeof item[doc.CONTENT_ID] === "string" && item[doc.CONTENT_ID].length > 10 ? item[doc.CONTENT_ID] : void 0;
                        pushMeta({
                            id,
                            title,
                            chipUrl,
                            createdAt,
                            contentId
                        });
                    }
                }
            }
        });
        if (out.length > 0) return out;

        // Pass 2: flat fallback, only when the strict path produced nothing.
        // Heuristic by construction — results are marked source: 'heuristic-flat'.
        deepWalk([root], (node) => {
            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) {
                    let item = node[i];
                    if (!Array.isArray(item)) continue;
                    try {
                        let flat = item.flat(Infinity).filter(x => typeof x === "string");
                        if (flat.length > 500) continue;
                        let chip = flat.find(x => x.includes("immersive_entry_chip"));
                        if (chip) {
                            let uuid = flat.find(x => uuidRe.test(x));
                            let title = flat.find(x => !x.includes("http") && !uuidRe.test(x) && x.length >= 8 && !x.includes("c_") && !x.includes(".html") && !researchPrefixRe.test(x));
                            pushMeta({
                                id: uuid || flat.find(x => x.includes("rc_")) || chip,
                                title: title || "",
                                chipUrl: chip,
                                source: "heuristic-flat"
                            });
                        }
                    } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:attachments.ts]", e); }
                }
            }
        });
        return out;
    }

    function findDocContentById(root: unknown, docId: string): unknown {
        if (!docId) return null;
        let targetId = String(docId).replace(/^c_/, "");
        let matched: any = null;

        deepWalk(root, (node) => {
            if (matched) return false;
            if (Array.isArray(node)) {
                let idMatch: "exact" | "substring" | null = null;
                for (let elem of node) {
                    if (typeof elem !== "string") continue;
                    if (elem === docId || elem === targetId) {
                        idMatch = "exact";
                        break;
                    }
                    // P1-9: substring 兜底只允许短元素（<80），长正文里"提到" ID 不算命中
                    if (elem.length < 80 && (elem.includes(docId) || elem.includes(targetId))) {
                        idMatch = "substring";
                        break;
                    }
                }
                if (idMatch) {
                    let hasSections = node.some(x => Array.isArray(x) && x.some(y => Array.isArray(y) && typeof y[0] === "string" && y[0].length > 50));
                    let hasLongStr = node.some(x => typeof x === "string" && x.length > 200 && (x.includes("#") || x.includes("\n\n")));
                    if (hasSections || hasLongStr) {
                        matched = node;
                        if (idMatch === "substring") matched.contentMatch = "substring";
                        return false;
                    }
                }
            }
        });
        return matched;
    }

    function parseDocSections(docContentArr: unknown): DocSectionsResult {
        let sections: string[] = [];
        let links: DocLink[] = [];
        let contentMarkdown = "";
        // P1-9: 上游 heuristic 标记透传，不静默转成正常可信结果
        const contentMatch = (docContentArr as any)?.contentMatch === "substring" ? "substring" as const : void 0;
        if (!Array.isArray(docContentArr)) return { sections, links, contentMarkdown, contentMatch };

        deepWalk(docContentArr, (node) => {
            if (Array.isArray(node)) {
                if (node.length >= 2 && typeof node[0] === "string" && typeof node[1] === "string" && node[1].startsWith("http")) {
                    links.push({
                        title: node[0],
                        url: node[1]
                    });
                }
                if (node.length >= 1 && typeof node[0] === "string" && node[0].length > 50) {
                    let text = node[0];
                    if (!sections.includes(text)) sections.push(text);
                }
            }
        });
        if (sections.length) {
            contentMarkdown = sections.join("\n\n");
        }
        return {
            sections,
            links,
            contentMarkdown,
            contentMatch
        };
    }

    function findDocMarkdownByClues(root: unknown, metaItem?: DeepResearchDocMeta | null): string {
        if (!metaItem) return "";
        let candidates: string[] = [];

        deepWalk(root, (node) => {
            if (Array.isArray(node)) {
                for (let elem of node) {
                    if (typeof elem === "string" && elem.length > 200 && (elem.includes("# ") || elem.includes("## ") || elem.includes("\n\n"))) {
                        if (!elem.includes("immersive_entry_chip") && !elem.includes("BardErrorInfo")) {
                            candidates.push(elem);
                        }
                    }
                }
            }
        });
        if (!candidates.length) return "";
        if (metaItem.title) {
            let match = candidates.find(c => c.includes(metaItem.title));
            if (match) return match;
        }
        candidates.sort((a, b) => b.length - a.length);
        return candidates[0] || "";
    }

export {
    IMAGE_GEN_RE,
    highResVariant,
    isInternalChipUrl,
    extractImageSelectionIndex,
    getImageDedupKey,
    filterNewImages,
    extractImages,
    extractResponseImages,
    extractUserFiles,
    extractDocumentsMeta,
    findDocContentById,
    parseDocSections,
    findDocMarkdownByClues,
    itemMatchesFilename,
    extractFileNameFromUrl
};

export const GeminiParserAttachments: GeminiParserAttachmentsModule = {
    IMAGE_GEN_RE,
    highResVariant,
    isInternalChipUrl,
    extractImageSelectionIndex,
    getImageDedupKey,
    filterNewImages,
    extractImages,
    extractResponseImages,
    extractUserFiles,
    extractDocumentsMeta,
    findDocContentById,
    parseDocSections,
    findDocMarkdownByClues,
    itemMatchesFilename,
    extractFileNameFromUrl
};

if (typeof module === 'object' && module.exports) module.exports = GeminiParserAttachments;

export default GeminiParserAttachments;

