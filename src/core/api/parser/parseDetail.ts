// parseDetail.ts - hNvQHb conversation detail RPC response parser
import type { Message, Conversation, TitleSources } from "../../../types/index.js";
import type { GeminiParserExtractorsModule, GeminiJspbSchema, TurnDriftReport } from "./extractors.js";
import type { GeminiParserAttachmentsModule, ImageAttachment, UserFileAttachment, DeepResearchDocMeta } from "./attachments.js";

export interface DetailParseResult {
    id: string;
    title: string;
    titleSource: string;
    titles: TitleSources;
    messages: Message[];
    createdAt: number | null;
    chatTime: number | null;
    timestamp: number | null;
    updatedAt: number | null;
    url: string;
    nextPageToken: string | null;
    attachmentCount: number;
    schemaDrift?: string[];
    _raw?: any;
    _debug?: any;
}

export interface GeminiParserParseDetailModule {
    isTurn: (turn: unknown) => boolean;
    isTurnsArray: (arr: unknown) => boolean;
    findTurnsDeep: (root: unknown, depth?: number) => unknown[] | null;
    parseDetail: (text: string, targetConvId?: string, overrides?: any) => DetailParseResult;
}

declare global {
    var GeminiParserParseDetail: GeminiParserParseDetailModule;
    var findTurnsDeep: (root: unknown, depth?: number) => unknown[] | null;
    var parseDetail: (text: string, targetConvId?: string, overrides?: any) => DetailParseResult;
}

import {
    GEMINI_JSPB_SCHEMA,
    detectTurnSchemaDrift,
    extractModelCandidates,
    extractCandidateText,
    safeStructureClean,
    robustFirstPayload,
    deepWalk,
    extractThoughts,
    extractCitations,
    extractConversationId,
    smartSummarizePrompt,
    extractConversationTitle,
    extractMetaTitleFromTop,
    extractTurnTimestamp,
    normId,
    cleanTitle,
    isRealTitle
} from "./extractors.js";
import {
    extractImages,
    extractUserFiles,
    extractDocumentsMeta,
    findDocContentById,
    parseDocSections,
    findDocMarkdownByClues,
    filterNewImages,
    highResVariant,
    isInternalChipUrl
} from "./attachments.js";
import GeminiProtocol, { WRB, RPCS } from "../../protocol/protocol.js";
import GeminiUtils from "../../utils/utils.js";

function getExtractors(): any {
    return {
        GEMINI_JSPB_SCHEMA,
        detectTurnSchemaDrift,
        extractModelCandidates,
        extractCandidateText,
        safeStructureClean,
        robustFirstPayload,
        deepWalk,
        extractThoughts,
        extractCitations,
        extractConversationId,
        smartSummarizePrompt,
        extractConversationTitle,
        extractMetaTitleFromTop,
        extractTurnTimestamp,
        normId,
        cleanTitle,
        isRealTitle
    };
}

function getAttachments(): any {
    return {
        extractImages,
        extractUserFiles,
        extractDocumentsMeta,
        findDocContentById,
        parseDocSections,
        findDocMarkdownByClues,
        filterNewImages,
        highResVariant,
        isInternalChipUrl
    };
}

function getUtils(): any {
    return (typeof globalThis !== "undefined" && (globalThis as any).GeminiUtils) || GeminiUtils;
}

function getProtocol(): any {
    return (typeof globalThis !== "undefined" && (globalThis as any).GeminiProtocol) || GeminiProtocol;
}

const FALLBACK_SCHEMA = GEMINI_JSPB_SCHEMA;

function getSchema(): any {
    return GEMINI_JSPB_SCHEMA;
}

const RESEARCH_PROMPT_PREFIX_RE = /^(?:我已经完成了研究|我拟定了一个研究方案|I've completed your research|Here is a research plan)/i;


    function isTurn(turn: unknown): boolean {
        if (!Array.isArray(turn) || turn.length < 3) return false;
        const head = turn[0];
        let idStr = "";
        if (typeof head === "string") idStr = head;
        else if (Array.isArray(head) && head.length) {
            idStr = typeof head[0] === "string" ? head[0] : (Array.isArray(head[0]) && typeof head[0][0] === "string" ? head[0][0] : "");
        }
        if (!idStr || (!idStr.startsWith("c_") && !idStr.startsWith("r_"))) return false;
        // 需含 user 文本或 candidate rc_
        try {
            const s = JSON.stringify(turn);
            return s.includes("rc_") || s.includes("c_d") || s.includes("r_") || Array.isArray(turn[2]);
        } catch {
            return false;
        }
    }

    function isTurnsArray(arr: unknown): boolean {
        if (!Array.isArray(arr) || arr.length === 0) return false;
        let cnt = 0;
        for (const t of arr) if (isTurn(t)) cnt++;
        return cnt >= 1 && cnt / arr.length >= 0.5;
    }

    function findTurnsDeep(root: unknown, depth: number = 0): unknown[] | null {
        if (!root || depth > 6) return null;
        if (isTurnsArray(root)) return root as unknown[];
        if (Array.isArray(root)) {
            for (const el of root) {
                const found = findTurnsDeep(el, depth + 1);
                if (found) return found;
            }
        } else if (root && typeof root === "object") {
            for (const k in (root as Record<string, unknown>)) {
                const found = findTurnsDeep((root as Record<string, unknown>)[k], depth + 1);
                if (found) return found;
            }
        }
        return null;
    }

    function parseDetail(text: string, targetConvId?: string, overrides: any = {}): DetailParseResult {
        const ext = Object.assign({}, getExtractors(), overrides.extractors);
        const att = Object.assign({}, getAttachments(), overrides.attachments);

        const schema = ext.GEMINI_JSPB_SCHEMA || getSchema();
        const robustFirstPayload = ext.robustFirstPayload || ((t: string) => { try { return JSON.parse(t); } catch (_) { return null; } });
        const detectTurnSchemaDrift = ext.detectTurnSchemaDrift || (() => ({ isDrifted: false, warnings: [] }));
        const extractConversationId = ext.extractConversationId || ((inner: any) => inner?.[0] || "c_unknown");
        const extractTurnTimestamp = ext.extractTurnTimestamp || (() => null);
        const extractModelCandidates = ext.extractModelCandidates || (() => []);
        const extractCandidateText = ext.extractCandidateText || (() => "");
        const extractThoughts = ext.extractThoughts || (() => null);
        const extractCitations = ext.extractCitations || (() => []);
        const extractMetaTitleFromTop = ext.extractMetaTitleFromTop || (() => null);
        const extractConversationTitle = ext.extractConversationTitle || (() => ({ title: "未命名对话", source: "default" }));
        const cleanTitle = ext.cleanTitle || ((t: any) => String(t || "").trim());
        const isRealTitle = ext.isRealTitle || ((t: any) => !!(t && String(t).trim().length >= 2));
        const deepWalk = ext.deepWalk || ((root: any, visitor: any) => {
            function walk(node: any) {
                if (!node || typeof node !== "object") return;
                visitor(node);
                if (Array.isArray(node)) for (let el of node) walk(el);
                else for (let k in node) if (Object.prototype.hasOwnProperty.call(node, k)) walk(node[k]);
            }
            walk(root);
        });

        const filterNewImages = att.filterNewImages || ((imgs: any) => imgs);
        const extractImages = att.extractImages || (() => []);
        const extractUserFiles = att.extractUserFiles || (() => []);
        const extractDocumentsMeta = att.extractDocumentsMeta || (() => []);
        const findDocContentById = att.findDocContentById || (() => null);
        const parseDocSections = att.parseDocSections || (() => ({ sections: [], links: [], contentMarkdown: void 0 }));
        const findDocMarkdownByClues = att.findDocMarkdownByClues || (() => "");
        const highResVariant = att.highResVariant || ((u: any) => u);
        const isInternalChipUrl = att.isInternalChipUrl || (() => false);

        try {
            let top = robustFirstPayload(text);
            const utils = getUtils();
            const isDevMode = (utils && typeof utils.isDevMode === "function") ? utils.isDevMode() : false;
            const shouldVerbose = !!isDevMode;

            const protocol = getProtocol();
            const wrb = protocol.WRB || "wrb.fr";
            const detailRpc = protocol.RPCS ? protocol.RPCS.DETAIL : "hNvQHb";

            if (shouldVerbose) {
                try {
                    const summary = Array.isArray(top) ? top.map((it, i) => {
                        const rpc = Array.isArray(it) ? it[1] : String(it).slice(0, 20);
                        const innerLen = Array.isArray(it) && typeof it[2] === "string" ? it[2].length : (typeof it === "string" ? it.length : 0);
                        const preview = Array.isArray(it) && typeof it[2] === "string" ? it[2].slice(0, 300).replace(/\n/g, " ") : "";
                        return { idx: i, rpc, innerLen, preview };
                    }) : { topType: typeof top, len: text?.length };
                    if (!top || !Array.isArray(top)) console.log("[Parser Verbose] top candidates", summary);
                    if (!top || (Array.isArray(top) && !top.some(it => Array.isArray(it) && it[1] === detailRpc && typeof it[2] === "string" && it[2].includes("rc_")))) {
                        console.warn("[Parser Verbose] no hNvQHb with rc_ found, top summary", summary);
                    }
                } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:parseDetail.ts]", e); }
            }

            let schemaDriftWarnings: string[] = [];
            let innerStr: string | null = null;
            if (Array.isArray(top)) {
                let foundStandardWrb = false;
                for (let item of top) {
                    if (Array.isArray(item) && item[0] === wrb && item[1] === detailRpc && typeof item[2] === "string") {
                        innerStr = item[2];
                        foundStandardWrb = true;
                        break;
                    }
                }
                if (!innerStr) {
                    for (let item of top) {
                        if (Array.isArray(item) && typeof item[2] === "string" && (item[2].includes("c_") || item[2].includes("rc_") || item[2].startsWith("[["))) {
                            innerStr = item[2];
                            break;
                        }
                    }
                    if (top.length > 0 && !foundStandardWrb && innerStr) {
                        schemaDriftWarnings.push(`Envelope drift: batchexecute response missing standard WRB detail RPC header [${wrb}, ${detailRpc}], fell back to heuristic payload discovery`);
                    }
                }
            }

            let inner: any = null;
            if (innerStr) {
                try {
                    inner = JSON.parse(innerStr);
                } catch { /* intentional: parse chunk candidate fallback */ }
            }
            if (!inner && Array.isArray(top)) {
                for (let item of top) {
                    if (typeof item === "string" && item.startsWith("[[")) {
                        try {
                            inner = JSON.parse(item);
                        } catch { /* intentional: parse chunk candidate fallback */ }
                    }
                    if (inner) break;
                }
            }
            if (!inner) throw new Error("invalid");

            let turns: any[] | null = null;
            // 优先按原协议 inner[0] 快速路径
            if (isTurnsArray(inner?.[0])) turns = inner[0];
            // 全量深搜 inner
            if (!turns) turns = findTurnsDeep(inner);
            // 再搜 top 的其他条目（hNvQHb 为 list 形态时，turns 在 MaZiqc 的 inner 中）
            if (!turns && Array.isArray(top)) {
                for (const item of top) {
                    if (!Array.isArray(item) || typeof item[2] !== "string") continue;
                    if (item[2] === innerStr) continue;
                    try {
                        const altInner = JSON.parse(item[2]);
                        const altTurns = findTurnsDeep(altInner);
                        if (altTurns) { turns = altTurns; inner = altInner; break; }
                    } catch { /* intentional: parse chunk candidate fallback */ }
                }
                if (!turns) {
                    const topTurns = findTurnsDeep(top);
                    if (topTurns) turns = topTurns;
                }
            }
            if (!turns) turns = [];

            // Detect "metadata-only" response: inner = [null, null, [[conv_id_str, title, ...]]]
            const isMetadataOnly = !turns.length
                && inner[0] === null && inner[1] === null
                && Array.isArray(inner[2]) && inner[2].length > 0
                && typeof inner[2][0]?.[0] === "string" && inner[2][0][0].startsWith("c_");
            if (isMetadataOnly && isDevMode) {
                console.warn("[Parser] hNvQHb returned metadata-only payload (no turns). " +
                    "inner[2][0] looks like a list-format row, not a turns array. " +
                    "conv:", inner[2][0]?.[0], "title:", inner[2][0]?.[1],
                    "rc_count:", inner[2][0]?.filter((x: any) => typeof x === "string" && x.startsWith("rc_")).length);
            }
            if (!turns.length && inner && Array.isArray(inner) && inner.length > 0 && !isMetadataOnly) {
                schemaDriftWarnings.push(`Payload drift: inner JSON array present (length ${inner.length}) but unable to locate turns array`);
            }

            let convId = extractConversationId(inner, turns);
            if (convId === "c_unknown" && targetConvId) convId = targetConvId;
            let shortScope = convId ? String(convId).replace(/^c_/, "").slice(-6) + "_" : "";
            let msgs: any[] = [];
            let dedupSet = new Set<string>();
            let docDedupSet = new Set<string>();
            let usedLocalNames = new Set<string>();
            const getUniqueLocalName = (preferredPath: string): string => {
                if (!usedLocalNames.has(preferredPath)) {
                    usedLocalNames.add(preferredPath);
                    return preferredPath;
                }
                const dotIdx = preferredPath.lastIndexOf('.');
                const base = dotIdx !== -1 ? preferredPath.slice(0, dotIdx) : preferredPath;
                const ext = dotIdx !== -1 ? preferredPath.slice(dotIdx) : '';
                let idx = 2;
                while (usedLocalNames.has(`${base}_${idx}${ext}`)) {
                    idx++;
                }
                const unique = `${base}_${idx}${ext}`;
                usedLocalNames.add(unique);
                return unique;
            };
            let imageSeq = { value: 1 };
            let rev = [...turns].reverse();

            for (let turn of rev) {
                let drift: TurnDriftReport = detectTurnSchemaDrift(turn, convId);
                if (drift.isDrifted) {
                    schemaDriftWarnings.push(...drift.warnings);
                }
                let ts = extractTurnTimestamp(turn) || Date.now();
                let uText = turn?.[schema.TURN.USER_PAYLOAD]?.[0]?.[0] || "";
                let uImgs = filterNewImages(extractImages(turn?.[schema.TURN.USER_PAYLOAD], imageSeq), dedupSet);
                let uFiles = extractUserFiles(turn?.[schema.TURN.USER_PAYLOAD]).filter((f: UserFileAttachment) => {
                    let key = f.id || f.sourceUrl || f.fileName;
                    if (!key || docDedupSet.has(key)) return false;
                    docDedupSet.add(key);
                    return true;
                });
                if (uText || uImgs.length || uFiles.length) {
                    msgs.push({
                        id: turn?.[0]?.[0] || "",
                        role: "user",
                        content: uText,
                        timestamp: ts,
                        images: uImgs.length ? uImgs.map((i: ImageAttachment) => ({
                            ...i,
                            resolvedUrl: highResVariant(i.sourceUrl),
                            localName: getUniqueLocalName(`assets/${shortScope}${(i.fileName || "img.jpg").replace(/[\\/:*?"<>|]/g, "_")}`),
                            type: "image",
                            isImage: true
                        })) : void 0,
                        documents: uFiles.length ? uFiles.map((f: UserFileAttachment) => ({
                            id: f.id,
                            title: f.fileName,
                            createdAt: ts,
                            chipUrl: "",
                            sections: [],
                            links: [],
                            contentMarkdown: void 0,
                            url: f.sourceUrl,
                            localName: getUniqueLocalName(`files/${shortScope}${(f.fileName || "doc.md").replace(/[\\/:*?"<>|]/g, "_")}`),
                            type: "file"
                        })) : void 0
                    });
                }

                let candList = extractModelCandidates(turn);
                if (Array.isArray(candList)) {
                    for (let cand of candList) {
                        let candidateId = cand?.[schema.CANDIDATE.ID] || "";
                        let candidateBlock = cand?.[schema.CANDIDATE.BODY] || cand;
                        let responseText = extractCandidateText(cand);
                        if (!responseText) {
                            let textArr: string[] = [];
                            deepWalk(cand, (node: any) => {
                                if (Array.isArray(node)) {
                                    if (node.length >= 1 && typeof node[0] === "string" && node[0].length > 0 && !node[0].startsWith("http") && !node[0].startsWith("rc_") && !node[0].startsWith("c_")) {
                                        if (node[0].trim().length > 2 && !textArr.includes(node[0])) {
                                            textArr.push(node[0]);
                                        }
                                    }
                                }
                            });
                            responseText = textArr.join("\n\n");
                        }
                        let candImages = extractImages(cand, imageSeq);
                        let filteredImages = filterNewImages(candImages, dedupSet);
                        let docsMeta: DeepResearchDocMeta[] = extractDocumentsMeta(candidateBlock);
                        if (!docsMeta.length && !docDedupSet.size) {
                            docsMeta = extractDocumentsMeta(inner);
                        }
                        let docs = docsMeta.filter((docItem: DeepResearchDocMeta) => {
                            let key = docItem.id || docItem.chipUrl;
                            if (!key || docDedupSet.has(key)) return false;
                            let isRc = /^rc_/.test(docItem.id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(docItem.id);
                            let isHttp = docItem.id.includes("immersive_entry_chip") || docItem.id.startsWith("http");
                            if (!isRc && isHttp) return false;
                            docDedupSet.add(key);
                            return true;
                        });
                        let docDetails: any[] = [];
                        if (docs.length) {
                            try {
                                docDetails = docs.map((metaItem: DeepResearchDocMeta) => {
                                    let primary = findDocContentById(inner, metaItem.id);
                                    let alt = metaItem.contentId ? findDocContentById(inner, metaItem.contentId) : null;
                                    let parsedPrimary = parseDocSections(primary);
                                    let parsedAlt = alt ? parseDocSections(alt) : {
                                        sections: [],
                                        links: [],
                                        contentMarkdown: void 0
                                    };
                                    let md = parsedPrimary.contentMarkdown || parsedAlt.contentMarkdown || findDocMarkdownByClues(inner, metaItem);

                                    let docTitle = metaItem.title || "";
                                    if (!docTitle || RESEARCH_PROMPT_PREFIX_RE.test(docTitle) || docTitle === "Document") {
                                        if (md) {
                                            let hMatch = md.match(/^#\\s+(.+)$/m);
                                            if (hMatch && hMatch[1].trim()) {
                                                docTitle = hMatch[1].trim();
                                            }
                                        }
                                    }
                                    if (!docTitle || RESEARCH_PROMPT_PREFIX_RE.test(docTitle)) {
                                        docTitle = `深度研究报告_${String(metaItem.id || "doc").replace(/[^a-zA-Z0-9_-]/g, "").slice(-6)}`;
                                    }

                                    if (!md) return null;

                                    return {
                                        id: metaItem.id,
                                        title: docTitle,
                                        createdAt: metaItem.createdAt,
                                        chipUrl: "",
                                        sections: [...parsedPrimary.sections, ...parsedAlt.sections],
                                        links: [...parsedPrimary.links, ...parsedAlt.links],
                                        contentMarkdown: md,
                                        url: "",
                                        localName: getUniqueLocalName(`files/${shortScope}${docTitle.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}.md`),
                                        type: "file"
                                    };
                                }).filter(Boolean);
                            } catch (er) {
                                console.warn("doc parse err", er);
                            }
                        }
                        let thoughts = extractThoughts(candidateBlock);
                        let citations = extractCitations(candidateBlock);
                        if (responseText) {
                            responseText = responseText.replace(/^rc_[a-z0-9_]{10,}\\s*/i, "");
                            responseText = responseText.replace(/(?:^|\n)\\s*(?:\[)?https?:\/\/googleusercontent\.com\/(?:immersive_entry_chip|deep_research_confirmation_content|map_content|map_location_reference|grounding_content|web_search_content|youtube_content|flights_content|hotels_content|workspace_content)(?:\/[^\s\n\]]*)?(?:\])?\\s*(?=\n|$)/gi, "\n");
                            responseText = responseText.replace(/\[([^\]]+)\]\(https?:\/\/googleusercontent\.com\/(?:immersive_entry_chip|deep_research_confirmation_content|map_content|map_location_reference|grounding_content|web_search_content|youtube_content|flights_content|hotels_content|workspace_content)[^\)]*\)/gi, "$1");
                            responseText = responseText.replace(/https?:\/\/googleusercontent\.com\/(?:immersive_entry_chip|deep_research_confirmation_content|map_content|map_location_reference|grounding_content|web_search_content|youtube_content|flights_content|hotels_content|workspace_content)(?:\/[^\s\n\)]*)?/gi, "").trim();
                            if (filteredImages.length > 0) {
                                responseText = responseText.replace(/(?:^|\n)\\s*(?:\[)?https?:\/\/googleusercontent\.com\/(?:image_generation_content|imagegenerationcontent|generated_image)(?:\/[^\s\n\]]*)?(?:\])?\\s*(?=\n|$)/gi, "\n");
                                responseText = responseText.replace(/\[([^\]]+)\]\(https?:\/\/googleusercontent\.com\/(?:image_generation_content|imagegenerationcontent|generated_image)[^\)]*\)/gi, "$1");
                                responseText = responseText.replace(/https?:\/\/googleusercontent\.com\/(?:image_generation_content|imagegenerationcontent|generated_image)(?:\/[^\s\n\)]*)?/gi, "").trim();
                            }
                        }
                        if (responseText || thoughts || filteredImages.length || docDetails.length) {
                            msgs.push({
                                id: candidateId || turn?.[0]?.[0] || "",
                                role: "model",
                                content: responseText || "",
                                thoughts: thoughts || void 0,
                                citations: citations.length ? citations : void 0,
                                timestamp: ts,
                                images: filteredImages.length ? filteredImages.map((img: any) => ({
                                    ...img,
                                    resolvedUrl: highResVariant(img.sourceUrl),
                                    localName: getUniqueLocalName(`assets/${shortScope}${(img.fileName || "img.jpg").replace(/[\\/:*?"<>|]/g, "_")}`),
                                    type: "image"
                                })) : void 0,
                                documents: docDetails.length ? docDetails : void 0
                            });
                        }
                    }
                }
            }

            if (!convId) convId = extractConversationId(inner, turns);
            if (convId === "c_unknown" && targetConvId) convId = targetConvId;
            let metaTitle = extractMetaTitleFromTop(top, convId || targetConvId);
            let titleObj = extractConversationTitle(inner, turns);
            let nextToken: string | null = null;
            if (typeof inner[1] === "string" && inner[1].startsWith("tC")) nextToken = inner[1];
            let url = `https://gemini.google.com/app/${String(convId).replace(/^c_/, "")}`;
            let times = turns.map(t => extractTurnTimestamp(t)).filter((x: any): x is number => Number.isFinite(x));
            let minTs = times.length ? Math.min(...times) : null;
            let maxTs = times.length ? Math.max(...times) : null;

            let allMsgs: Message[] = msgs.map(m => {
                let atts: any[] = [];
                if (m.images) {
                    for (let im of m.images) {
                        if (im.resolvedUrl || im.sourceUrl) {
                            atts.push({
                                type: "image",
                                src: im.resolvedUrl || im.sourceUrl,
                                localName: im.localName || `assets/${shortScope}${im.fileName}`,
                                alt: im.fileName,
                                isBlob: false,
                                isImage: true,
                                originalUrl: im.sourceUrl
                            });
                        }
                    }
                }
                if (m.documents) {
                    for (let d of m.documents) {
                        if (d.contentMarkdown || (d.url && !isInternalChipUrl(d.url))) {
                            atts.push({
                                type: "file",
                                name: d.title || d.id,
                                title: d.title,
                                url: d.url || d.sourceUrl,
                                localName: d.localName,
                                contentMarkdown: d.contentMarkdown
                            });
                        }
                    }
                }
                return {
                    ...m,
                    attachments: atts.length ? atts : void 0,
                    attachmentCount: atts.length,
                    messageCount: 1
                };
            });

            let cleanT = metaTitle || cleanTitle(titleObj.title || convId);
            let isReal = isRealTitle(cleanT, convId);
            let finalSource = metaTitle ? "rpc" : (isReal ? titleObj.source : "default");
            if (!isReal && !metaTitle) {
                let firstUser = allMsgs.find(m => m.role === "user" && m.content && m.content.trim());
                if (firstUser) {
                    let candidate = cleanTitle(firstUser.content.trim().slice(0, 60).replace(/\n+/g, " "));
                    if (isRealTitle(candidate, convId)) {
                        cleanT = candidate;
                        finalSource = "sniff";
                    }
                }
            }
            const titlesMap: TitleSources = {};
            if (finalSource !== "default" && cleanT) {
                titlesMap[finalSource as keyof TitleSources] = cleanT;
            }
            if (metaTitle) {
                titlesMap.rpc = metaTitle;
            }

            let _debug: any = null;
            if (!allMsgs.length) {
                try {
                    _debug = { turnsLen: turns?.length || 0, innerKeys: inner ? Object.keys(inner) : null, innerPreview: JSON.stringify(inner).slice(0, 1500), topPreview: top ? JSON.stringify(top).slice(0, 800) : null };
                } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:parseDetail.ts]", e); }
            }
            if (schemaDriftWarnings.length) {
                if (!_debug) _debug = {};
                _debug.schemaDriftWarnings = schemaDriftWarnings;
            }

            return {
                id: convId,
                title: cleanT,
                titleSource: finalSource,
                titles: titlesMap,
                messages: allMsgs,
                createdAt: minTs,
                chatTime: maxTs || minTs,
                timestamp: maxTs || minTs,
                updatedAt: maxTs,
                url,
                nextPageToken: nextToken,
                attachmentCount: allMsgs.reduce((a, m) => a + (m.attachmentCount || 0), 0),
                schemaDrift: schemaDriftWarnings.length ? schemaDriftWarnings : void 0,
                _raw: inner,
                _debug
            };
        } catch (e: any) {
            throw new Error("detail parse fail: " + e.message);
        }
    }

export {
    isTurn,
    isTurnsArray,
    findTurnsDeep,
    parseDetail
};

export const GeminiParserParseDetail: GeminiParserParseDetailModule = {
    isTurn,
    isTurnsArray,
    findTurnsDeep,
    parseDetail
};

if (typeof globalThis !== 'undefined') {
    (globalThis as any).GeminiParserParseDetail = GeminiParserParseDetail;
    (globalThis as any).findTurnsDeep = findTurnsDeep;
    (globalThis as any).parseDetail = parseDetail;
}
if (typeof module === 'object' && module.exports) module.exports = GeminiParserParseDetail;

export default GeminiParserParseDetail;