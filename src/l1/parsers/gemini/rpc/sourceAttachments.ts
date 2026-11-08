import type { GeminiStructuredDocument, GeminiStructuredNode } from './structuredContent.js';
import { isInternalChipUrl as canonicalIsInternalChipUrl } from "../../shared/chipUtils.js";
import { isJsonValue, type JsonValue } from "../../../../shared/utils/jsonTypes.js";
import { payloadToMs } from "./payload.js";

export interface ImageAttachment {
    /** JSON-serialized matched wire tuple; never an unvalidated runtime value. */
    sourceEvidence?: { detectorKind: string; node: JsonValue };
    isGenerated?: boolean;
    providerRequestId?: string;
    imageOrdinal?: number;
    sourceUrl: string;
    width?: number;
    height?: number;
    size?: number;
    token?: string;
    fileName?: string;
    title?: string;
    mimeType?: string;
}

export interface GeminiResponseImageEvidence {
    images: ImageAttachment[];
    /** Body-local images retain their own order and token deduplication. */
    structuredImages: ImageAttachment[];
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

import { deepWalk, RESEARCH_PROMPT_PREFIX_RE, GEMINI_JSPB_SCHEMA } from "./extractors.js";


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
            if (console.warn) {
                console.warn(`[Gemini Exporter] media URL skipped (host not in whitelist, ${kind}): host=${host} url=${String(url).slice(0, 220)}`);
            }
        } catch (e) { /* ignore */ }
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

    function isInternalChipUrl(u?: string | null): boolean {
        return canonicalIsInternalChipUrl(u);
    }

    export interface RawImageCandidate {
        evidenceNode?: JsonValue;
        sourceUrl: string;
        width?: number;
        height?: number;
        size?: number;
        token?: string;
        rawFileName?: string;
        title?: string;
        mimeType?: string;
        detectorKind: string;
    }

    type ImageNodeDetector = (node: unknown, schema: typeof GEMINI_JSPB_SCHEMA) => RawImageCandidate | null;

    function isRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function isUnknownArray(value: unknown): value is unknown[] {
        return Array.isArray(value);
    }

    const detectInlineImageTuple: ImageNodeDetector = (node, schema) => {
        if (!isUnknownArray(node)) return null;
        const slots = node;
        const inl = schema.INLINE_IMAGE;
        const url = slots[inl.URL];
        const width = slots[inl.WIDTH];
        const height = slots[inl.HEIGHT];
        if (
            node.length >= 3 &&
            typeof url === "string" &&
            url.startsWith("http") &&
            typeof width === "number" &&
            typeof height === "number"
        ) {
            const rawToken = slots[inl.TOKEN];
            return {
                sourceUrl: url,
                width,
                height,
                token: typeof rawToken === "string" ? rawToken : void 0,
                detectorKind: "extractImages [url,w,h]"
            };
        }
        return null;
    };

    const detectGeneratedMediaNode: ImageNodeDetector = (node, schema) => {
        if (!isUnknownArray(node)) return null;
        const slots = node;
        const gen = schema.GENERATED_IMAGE;
        const url = slots[gen.URL];
        const filename = slots[gen.FILENAME];
        const mimeTypeVal = slots[gen.MIME_TYPE];
        const dims = slots[gen.DIMENSIONS];
        if (
            node.length >= 4 &&
            typeof url === "string" &&
            url.startsWith("http") &&
            (
                (typeof filename === "string" && (/\.(jpe?g|png|webp|gif)$/i.test(filename) || /watermarked_img_/i.test(filename))) ||
                (typeof mimeTypeVal === "string" && mimeTypeVal.startsWith("image/")) ||
                (isUnknownArray(dims) && typeof dims[0] === "number" && typeof dims[1] === "number")
            )
        ) {
            // Derivative upscale renditions (e.g. 2x with UPSCALE_FACTOR > 1) are secondary variants,
            // not the authoritative source generation.
            const upscaleFactor = slots[gen.UPSCALE_FACTOR];
            if (typeof upscaleFactor === "number" && upscaleFactor > 1) {
                return null;
            }
            const rawFileName = (typeof filename === "string" && filename.trim()) ? filename.trim() : "";
            const rawDims = isUnknownArray(dims) ? dims : null;
            const width = rawDims !== null && typeof rawDims[0] === "number" ? rawDims[0] : void 0;
            const height = rawDims !== null && typeof rawDims[1] === "number" ? rawDims[1] : void 0;
            const size = rawDims !== null && typeof rawDims[2] === "number" ? rawDims[2] : void 0;
            const mimeType = typeof mimeTypeVal === "string" ? mimeTypeVal : void 0;
            const rawToken = slots[gen.TOKEN];
            const token = typeof rawToken === "string" ? rawToken : void 0;
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
        if (isRecord(node)) {
            const obj = node;
            if (obj.attachmentType !== 36) return null;
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
                title,
                detectorKind: "extractImages attachmentType:36"
            };
        }

        if (isUnknownArray(node) && node.length >= 8) {
            const slots = node;
            const slot0 = slots[0];
            const slot3 = slots[3];
            const slot7 = slots[7];
            const gstaticTuple = isUnknownArray(slot3) && slot3.length >= 4
                ? slot3
                : (isUnknownArray(slot0) && slot0.length >= 4 ? slot0 : null);
            const rawImageTuple = gstaticTuple?.[0];
            const imageTuple = isUnknownArray(rawImageTuple) ? rawImageTuple : null;
            const rawUrl = imageTuple?.[0];
            if (typeof rawUrl === "string") {
                const rawWidth = gstaticTuple?.[2];
                const rawHeight = gstaticTuple?.[3];
                const width = typeof rawWidth === "number" ? rawWidth : undefined;
                const height = typeof rawHeight === "number" ? rawHeight : undefined;

                let title: string | undefined;
                let fallbackGoogleUrl: string | undefined;
                const fallbackTuple = isUnknownArray(slot7) ? slot7 : null;
                const fallbackUrl = fallbackTuple?.[0];
                if (typeof fallbackUrl === "string") {
                    fallbackGoogleUrl = fallbackUrl;
                    const fallbackTitle = fallbackTuple?.[2];
                    if (typeof fallbackTitle === "string" && fallbackTitle.trim()) {
                        title = fallbackTitle.trim();
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
                    title,
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

    function sourceImage(raw: RawImageCandidate): ImageAttachment {
        return {
            sourceUrl: raw.sourceUrl,
            sourceEvidence: { detectorKind: raw.detectorKind, node: raw.evidenceNode ?? null },
            width: raw.width, height: raw.height, size: raw.size, token: raw.token,
            ...(raw.rawFileName ? { fileName: raw.rawFileName } : {}),
            ...(raw.title ? { title: raw.title } : {}),
            ...(raw.mimeType ? { mimeType: raw.mimeType } : {}),
            ...(raw.detectorKind === 'extractImages generated-media' ? { isGenerated: true } : {}),
        };
    }

    /** One response may expose the same wire tuple through body and metadata
     * roots. Reuse its decoded evidence while each list keeps its own order,
     * token preference and visibility rules. The reader lives for one extraction. */
    function createImageEvidenceReader(normalize: (raw: RawImageCandidate) => ImageAttachment = sourceImage): (node: object) => ImageAttachment | null {
        const evidence = new WeakMap<object, ImageAttachment | null>();
        const warnedHosts = new Set<string>();
        return node => {
            if (evidence.has(node)) return evidence.get(node) ?? null;
            evidence.set(node, null);
            for (const detector of IMAGE_DETECTORS) {
                const raw = detector(node, GEMINI_JSPB_SCHEMA);
                if (!raw) continue;
                if (isInternalChipUrl(raw.sourceUrl)) return null;
                if (!isGoogleMediaHost(raw.sourceUrl)) {
                    warnWhitelistDropOnce(warnedHosts, raw.sourceUrl, raw.detectorKind);
                    return null;
                }
                // Retain a bounded JSON-only snapshot of the matched tuple.
                const evidenceJson = JSON.stringify(node);
                const snapshot: unknown = evidenceJson.length <= 12000
                    ? JSON.parse(evidenceJson) : { truncated: true, preview: evidenceJson.slice(0, 12000) };
                if (isJsonValue(snapshot)) raw.evidenceNode = snapshot;
                const image = normalize(raw);
                evidence.set(node, image);
                return image;
            }
            return null;
        };
    }

    function collectImages(obj: unknown, normalize: (raw: RawImageCandidate) => ImageAttachment = sourceImage,
        readEvidence = createImageEvidenceReader(normalize), decoded: Iterable<ImageAttachment> = []): ImageAttachment[] {
        const images: ImageAttachment[] = [];
        const seenKeys = new Set<string>();

        const addImage = (img: ImageAttachment) => {
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
        };
        deepWalk(obj, node => {
            const image = readEvidence(node);
            if (image) addImage(image);
        });
        for (const image of decoded) addImage(image);
        return images;
    }

    function extractImageEvidence(obj: unknown): ImageAttachment[] {
        return collectImages(obj);
    }
    function* structuredImageEvidence(nodes: readonly GeminiStructuredNode[]): Generator<ImageAttachment> {
        for (const node of nodes) {
            switch (node.nodeType) {
                case 0:
                    yield* node.images ?? [];
                    break;
                case 'paragraph':
                case 15:
                    yield* structuredImageEvidence(node.children);
                    break;
                case 14:
                case 20:
                    for (const item of node.items) yield* structuredImageEvidence(item.children);
                    break;
                case 17:
                    for (const row of node.rows) for (const cell of row.cells) yield* structuredImageEvidence(cell.children);
                    break;
            }
        }
    }

    function extractResponseImageEvidence(candidate: readonly unknown[], visibleMedia: readonly unknown[], text: string, structuredContent?: GeminiStructuredDocument): GeminiResponseImageEvidence {
        const readEvidence = createImageEvidenceReader();
        const structuredImages = collectImages(undefined, sourceImage, readEvidence, structuredImageEvidence(structuredContent?.children ?? []));
        const visibleKeys = new Set(collectImages(visibleMedia, sourceImage, readEvidence, structuredImages).map(getImageDedupKey));
        const inlineUrls = new Set<string>();
        for (const match of text.matchAll(/!\[[^\]]*\]\(<?(https?:\/\/[^\s)>]+)>?(?:\s+[^)]*)?\)|<img\b[^>]*\bsrc=["'](https?:\/\/[^"']+)["']/gi)) {
            inlineUrls.add(match[1] || match[2]);
        }
        const images = collectImages([candidate, visibleMedia], sourceImage, readEvidence, structuredImages).filter(image => {
            if (image.sourceEvidence?.detectorKind !== 'extractImages attachmentType:36') return true;
            // Search results in candidate metadata are not automatically answer images.
            // Require an attachment in the answer document/body or a real inline image URL.
            return visibleKeys.has(getImageDedupKey(image)) || inlineUrls.has(image.sourceUrl);
        });
        return { images, structuredImages };
    }

    function itemMatchesFilename(name: string): boolean {
        const trimmed = name.trim();
        if (!trimmed) return false;
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return false;
        if (trimmed.startsWith("//") || trimmed.includes("://")) return false;
        if (trimmed.includes("?") || trimmed.includes("&") || trimmed.includes("=")) return false;
        if (trimmed.includes("/") || trimmed.includes("\\")) return false;
        return /\.[a-zA-Z0-9_-]{1,20}$/.test(trimmed);
    }

    function extractFileNameFromUrl(url: string): string | null {
        if (!url) return null;
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
        if (!isUnknownArray(turnUserArr)) return files;
        let warnedHosts = new Set<string>();
        let seenUrls = new Set<string>();

        deepWalk(turnUserArr, (node) => {
            if (!isUnknownArray(node)) return;

            const googleUrls: string[] = [];
            const filenames: string[] = [];
            let fallbackId = "";

            const slots = node;
            for (let i = 0; i < slots.length; i++) {
                const item = slots[i];
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
            if (isUnknownArray(node)) {
                const entries = node;
                for (let i = 0; i < entries.length; i++) {
                    const entry = entries[i];
                    if (!isUnknownArray(entry) || entry.length < 4) continue;
                    const fields = entry;
                    const chip = fields[doc.CHIP_URL];
                    const chipParts = isUnknownArray(chip) ? chip : null;
                    const chipUrl = chipParts?.[0];
                    const id = fields[doc.ID];
                    const rawTitle = fields[doc.TITLE];
                    if (typeof chipUrl !== "string" || !chipUrl.includes("immersive_entry_chip")
                        || typeof id !== "string" || typeof rawTitle !== "string") continue;

                    const title = researchPrefixRe.test(rawTitle) ? "" : rawTitle;
                    const rawTimestamp = fields[doc.TIMESTAMP];
                    const createdAt = payloadToMs(isUnknownArray(rawTimestamp) ? rawTimestamp[0] : undefined) ?? undefined;
                    const rawContentId = fields[doc.CONTENT_ID];
                    const contentId = typeof rawContentId === "string" && rawContentId.length > 10
                        ? rawContentId : undefined;
                    pushMeta({ id, title, chipUrl, createdAt, contentId });
                }
            }
        });
        if (out.length > 0) return out;

        // Pass 2: flat fallback, only when the strict path produced nothing.
        // Heuristic by construction — results are marked source: 'heuristic-flat'.
        deepWalk([root], (node) => {
            if (isUnknownArray(node)) {
                const entries = node;
                for (let i = 0; i < entries.length; i++) {
                    const entry = entries[i];
                    if (!isUnknownArray(entry)) continue;
                    const item = entry;
                    try {
                        const flat = item.flat(Infinity).filter((x): x is string => typeof x === "string");
                        if (flat.length > 500) continue;
                        const chip = flat.find(x => x.includes("immersive_entry_chip"));
                        if (chip) {
                            const uuid = flat.find(x => uuidRe.test(x));
                            const title = flat.find(x => !x.includes("http") && !uuidRe.test(x) && x.length >= 8 && !x.includes("c_") && !x.includes(".html") && !researchPrefixRe.test(x));
                            pushMeta({
                                id: uuid || flat.find(x => x.includes("rc_")) || chip,
                                title: title || "",
                                chipUrl: chip,
                                source: "heuristic-flat"
                            });
                        }
                    } catch (e) { console.debug("[GemExporter:attachments.ts]", e); }
                }
            }
        });
        return out;
    }

/** One lazy response scan shared by every Turn. Raw nodes never leave this decoder. */
export interface GeminiDocumentReader {
    byId(id: string): DocSectionsResult | null;
    byTitle(meta: DeepResearchDocMeta): string;
}
export function createDocumentReader(root: unknown): GeminiDocumentReader {
    const candidates: { node: unknown[]; identifiers: string[] }[] = [];
    const markdown = new Map<string, Set<string>>();
    const parsed = new Map<unknown[], DocSectionsResult>();
    const matches = new Map<string, DocSectionsResult | null>();
    let indexed = false;
    function index() {
        if (indexed) return;
        indexed = true;
        deepWalk(root, node => {
            if (!isUnknownArray(node)) return;
            const strings = node.filter((value): value is string => typeof value === 'string');
            const hasSections = node.some(x => isUnknownArray(x) && x.some(y => isUnknownArray(y) && typeof y[0] === 'string' && y[0].length > 50));
            const hasLongStr = strings.some(value => value.length > 200 && (value.includes('#') || value.includes('\n\n')));
            if (hasSections || hasLongStr) candidates.push({ node, identifiers: strings });
            for (const text of strings) {
                if (text.length <= 200 || !(text.includes('# ') || text.includes('\n\n'))
                    || text.includes('immersive_entry_chip') || text.includes('BardErrorInfo')) continue;
                const heading = /^\s*#{1,6}[ \t]+([^\r\n]+)/.exec(text);
                const title = heading?.[1].replace(/[ \t]+#+[ \t]*$/, '').trim();
                if (!title) continue;
                const values = markdown.get(title) ?? new Set<string>();
                values.add(text);
                markdown.set(title, values);
            }
        });
    }
    return {
        byId(id) {
            if (!id) return null;
            index();
            if (matches.has(id)) return matches.get(id) ?? null;
            const target = id.replace(/^c_/, '');
            for (const { node, identifiers } of candidates) {
                // Preserve source order, including the established short substring fallback.
                const value = identifiers.find(value => value === id || value === target
                    || value.length < 80 && (value.includes(id) || value.includes(target)));
                if (value === undefined) continue;
                let sections = parsed.get(node);
                if (!sections) { sections = parseDocSections(node); parsed.set(node, sections); }
                const result: DocSectionsResult = { ...sections,
                    ...(value !== id && value !== target ? { contentMatch: 'substring' } : {}) };
                matches.set(id, result);
                return result;
            }
            matches.set(id, null);
            return null;
        },
        byTitle(meta) {
            const title = meta.title.trim();
            if (!title || title === 'Document') return '';
            index();
            const values = markdown.get(title);
            return values?.size === 1 ? [...values][0] : '';
        },
    };
}

    function parseDocSections(docContentArr: unknown, contentMatch?: "substring"): DocSectionsResult {
        let sections: string[] = [];
        let links: DocLink[] = [];
        let contentMarkdown = "";
        // P1-9: provenance is explicitly passed from the matcher, never read
        // as an ad hoc property on the raw wire array.
        if (!isUnknownArray(docContentArr)) return { sections, links, contentMarkdown, contentMatch };

        deepWalk(docContentArr, (node) => {
            if (isUnknownArray(node)) {
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


export {
    collectImages,
    isInternalChipUrl,
    filterNewImages,
    extractImageEvidence,
    extractResponseImageEvidence,
    extractUserFiles,
    extractDocumentsMeta,
    parseDocSections,
    itemMatchesFilename,
    extractFileNameFromUrl
};
