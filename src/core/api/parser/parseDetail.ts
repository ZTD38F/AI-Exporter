import type { Message, TitleSources } from "../../../types/index.js";
import { stripInternalChipMarkdown } from "../../utils/chipUtils.js";
import { sanitizeFileName } from "../../utils/pathUtils.js";
import { __resolveModule } from "../../utils/moduleOverrides.js";
import type { TurnDriftReport } from "./extractors.js";
import type { ImageAttachment, UserFileAttachment, DeepResearchDocMeta } from "./attachments.js";

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
    pagination?: {
        pagesFetched: number;
        complete: boolean;
        stopReason: "end_of_history" | "token_loop" | "safety_limit";
        remainingToken: string | null;
    };
    schemaDrift?: string[];
    turnsRejected?: number;
    truncated?: boolean;
    isTruncated?: boolean;
    truncateReason?: string;
    _raw?: any;
    _debug?: any;
}

export interface GeminiParserParseDetailModule {
    isTurn: (turn: unknown) => boolean;
    isTurnsArray: (arr: unknown) => boolean;
    findTurnsDeep: (root: unknown, depth?: number) => unknown[] | null;
    parseDetail: (text: string, targetConvId?: string, overrides?: any) => DetailParseResult;
    extractTurnRequestId?: (turn: any) => string | undefined;
    DOC_TITLE_FALLBACK_RE?: RegExp;
}

import {
    GEMINI_JSPB_SCHEMA,
    detectTurnSchemaDrift,
    hasTurnContentMarkers,
    extractModelCandidates,
    extractCandidateText,
    safeStructureClean,
    robustFirstPayload,
    deepWalk,
    extractThoughts,
    extractCitations,
    extractGroundingCitationMarkers,
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
    extractResponseImages,
    extractUserFiles,
    extractDocumentsMeta,
    findDocContentById,
    parseDocSections,
    findDocMarkdownByClues,
    filterNewImages,
    highResVariant,
    isInternalChipUrl
} from "./attachments.js";
import GeminiProtocol from "../../protocol/protocol.js";
import GeminiUtils from "../../utils/utils.js";
import { extractInnerPayload, extractNextPageToken } from "./payload.js";
import { resolveDetailTitle, RESEARCH_PROMPT_PREFIX_RE } from "../../utils/titleUtils.js";
import { shortId, shortScope as getShortScope } from "../../utils/pathUtils.js";
import { extractStructuredContent } from "./structuredContent.js";

const DOC_TITLE_FALLBACK_RE = /^#\s+(.+)$/m;

function getUtils(): any {
    return __resolveModule('GeminiUtils', GeminiUtils);
}

function getProtocol(): any {
    return __resolveModule('GeminiProtocol', GeminiProtocol);
}

function getSchema(): any {
    return GEMINI_JSPB_SCHEMA;
}

const isTurnCache = new WeakMap<object, boolean>();

function extractUserTextFromPayload(userPayload: unknown): string {
    if (!Array.isArray(userPayload) || userPayload.length === 0) return "";
    const first = userPayload[0];
    if (typeof first === "string") return first;
    if (Array.isArray(first) && typeof first[0] === "string") return first[0];
    return "";
}

/**
 * Extract turn request ID from Gemini JSPB turn structure.
 *
 * Schema investigation evidence:
 * In Google's Gemini JSPB wire format, turn[GEMINI_JSPB_SCHEMA.TURN.ID_META] (index 0)
 * is a metadata tuple [conversationId, requestId, ...].
 * - Standard slot (REQUEST_ID_SLOT = 1): `idMeta[1]` is "r_<requestId>" (e.g. ["c_d3226d9a046c1116", "r_turn_1"]).
 * - Alternate slot 0: `idMeta[0]` is "r_<requestId>" when conversationId is omitted.
 * - String idMeta: `idMeta` is directly "r_<requestId>".
 * - Never search in turn[1] (which is TIMESTAMP: [seconds, nanos]).
 * - Strict contract: no heuristic .find() scanning; unconfirmed slots return undefined to prevent accidental dedupe.
 */
function extractTurnRequestId(turn: any): string | undefined {
    const idMeta = turn?.[GEMINI_JSPB_SCHEMA.TURN.ID_META];
    let raw: string | undefined;

    if (Array.isArray(idMeta)) {
        const reqSlot = GEMINI_JSPB_SCHEMA.TURN.REQUEST_ID_SLOT;
        if (typeof idMeta[reqSlot] === "string" && idMeta[reqSlot].startsWith("r_")) {
            raw = idMeta[reqSlot];
        } else if (typeof idMeta[0] === "string" && idMeta[0].startsWith("r_")) {
            raw = idMeta[0];
        }
    } else if (typeof idMeta === "string" && idMeta.startsWith("r_")) {
        raw = idMeta;
    }

    if (!raw) return undefined;
    const match = raw.match(/^r_([0-9a-fA-F]+)$/i);
    return match ? match[1].toLowerCase() : raw.replace(/^r_/i, '').toLowerCase();
}

function isTurn(turn: unknown): boolean {
    if (!Array.isArray(turn) || turn.length < 3) return false;
    const cached = isTurnCache.get(turn);
    if (cached !== undefined) return cached;
    const head = turn[0];
    let idStr = "";
    if (typeof head === "string") idStr = head;
    else if (Array.isArray(head) && head.length) {
        idStr = typeof head[0] === "string" ? head[0] : (Array.isArray(head[0]) && typeof head[0][0] === "string" ? head[0][0] : "");
    }
    let result = false;
    if (idStr && (idStr.startsWith("c_") || idStr.startsWith("r_"))) {
        result = hasTurnContentMarkers(turn);
    }
    isTurnCache.set(turn, result);
    return result;
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

interface TurnsExtractionResult {
    turns: any[];
    inner: any;
    schemaDriftWarnings: string[];
    turnsRejected: number;
}

function extractTurnsFromInner(
    inner: any,
    top: unknown[] | null,
    innerStr: string | null,
    isStandardWrb: boolean,
    wrb: string,
    detailRpc: string,
    isDevMode: boolean
): TurnsExtractionResult {
    const schemaDriftWarnings: string[] = [];
    if (Array.isArray(top) && top.length > 0 && !isStandardWrb && innerStr) {
        schemaDriftWarnings.push(`Envelope drift: batchexecute response missing standard WRB detail RPC header [${wrb}, ${detailRpc}], fell back to heuristic payload discovery`);
    }

    let activeInner = inner;
    let turns: any[] | null = null;
    const innerSchema = GEMINI_JSPB_SCHEMA.INNER;

    if (isTurnsArray(activeInner?.[innerSchema.TURNS_OR_LIST_PRIMARY])) {
        turns = activeInner[innerSchema.TURNS_OR_LIST_PRIMARY];
    }
    if (!turns) turns = findTurnsDeep(activeInner);
    if (!turns && Array.isArray(top)) {
        for (const item of top) {
            if (!Array.isArray(item) || typeof item[2] !== "string") continue;
            if (item[2] === innerStr) continue;
            try {
                const altInner = JSON.parse(item[2]);
                const altTurns = findTurnsDeep(altInner);
                if (altTurns) {
                    turns = altTurns;
                    activeInner = altInner;
                    break;
                }
            } catch { /* intentional: parse chunk candidate fallback */ }
        }
        if (!turns) {
            const topTurns = findTurnsDeep(top);
            if (topTurns) turns = topTurns;
        }
    }
    if (!turns) turns = [];

    // 4. Detect "metadata-only" response: inner = [null, null, [[conv_id_str, title, ...]]]
    const metaListIdx = innerSchema.METADATA_ONLY_LIST;
    const isMetadataOnly = !turns.length
        && activeInner[innerSchema.TURNS_OR_LIST_PRIMARY] === null
        && activeInner[innerSchema.LIST_SECONDARY] === null
        && Array.isArray(activeInner[metaListIdx]) && activeInner[metaListIdx].length > 0
        && typeof activeInner[metaListIdx][0]?.[0] === "string" && activeInner[metaListIdx][0][0].startsWith("c_");

    if (isMetadataOnly) {
        schemaDriftWarnings.push(`metadata-only payload: hNvQHb returned no turns (inner[${metaListIdx}][0] looks like a list-format row); exported messages will be empty`);
    }
    if (isMetadataOnly && isDevMode) {
        console.warn("[Parser] hNvQHb returned metadata-only payload (no turns). " +
            `inner[${metaListIdx}][0] looks like a list-format row, not a turns array. ` +
            "conv:", activeInner[metaListIdx][0]?.[0], "title:", activeInner[metaListIdx][0]?.[1],
            "rc_count:", activeInner[metaListIdx][0]?.filter((x: any) => typeof x === "string" && x.startsWith("rc_")).length);
    }
    if (!turns.length && activeInner && Array.isArray(activeInner) && activeInner.length > 0 && !isMetadataOnly) {
        schemaDriftWarnings.push(`Payload drift: inner JSON array present (length ${activeInner.length}) but unable to locate turns array`);
    }

    // P1-8: count elements the turn recognizer rejects. They are dropped from
    // the exported messages, so the count must travel with the result instead
    // of being silently lost. The array itself is left untouched.
    let turnsRejected = 0;
    for (const t of turns) {
        if (!isTurn(t)) turnsRejected++;
    }

    return { turns, inner: activeInner, schemaDriftWarnings, turnsRejected };
}

function buildUserMessage(
    turn: any,
    ts: number | null,
    shortScope: string,
    getUniqueLocalName: (p: string) => string,
    dedupSet: Set<string>,
    docDedupSet: Set<string>,
    imageSeq: { value: number }
): Message | null {
    const userPayload = turn?.[GEMINI_JSPB_SCHEMA.TURN.USER_PAYLOAD];
    const uText = extractUserTextFromPayload(userPayload);
    const uImgs = filterNewImages(extractImages(userPayload, imageSeq), dedupSet);
    const uFiles = extractUserFiles(userPayload).filter((f: UserFileAttachment) => {
        const key = f.id || f.sourceUrl || f.fileName;
        if (!key || docDedupSet.has(key)) return false;
        docDedupSet.add(key);
        return true;
    });

    if (!uText && !uImgs.length && !uFiles.length) return null;

    let userMsgId = "";
    if (Array.isArray(turn?.[0])) {
        userMsgId = turn[0].find((x: any) => typeof x === "string" && x.startsWith("r_"))
            || (typeof turn[0][1] === "string" ? turn[0][1] : "")
            || (typeof turn[0][0] === "string" ? turn[0][0] : "");
    } else if (typeof turn?.[0] === "string") {
        userMsgId = turn[0];
    }

    const formattedImages = uImgs.length ? uImgs.map((i: ImageAttachment) => ({
        ...i,
        resolvedUrl: highResVariant(i.sourceUrl),
        localName: getUniqueLocalName(`assets/${shortScope}${sanitizeFileName(i.fileName || "img.jpg", "img.jpg")}`),
        type: "image",
        isImage: true
    })) : void 0;

    const formattedDocs = uFiles.length ? uFiles.map((f: UserFileAttachment) => {
        const safeFileName = sanitizeFileName(f.fileName || "attachment", "attachment");
        return {
            id: f.id,
            title: f.fileName || safeFileName,
            createdAt: ts,
            chipUrl: "",
            sections: [],
            links: [],
            contentMarkdown: void 0,
            url: f.sourceUrl,
            candidates: f.thumbnailUrl ? [f.sourceUrl, f.thumbnailUrl] : [f.sourceUrl],
            localName: getUniqueLocalName(`files/${shortScope}${safeFileName}`),
            type: "file"
        };
    }) : void 0;

    const attachments: any[] = [];
    if (formattedImages) {
        for (const im of formattedImages) {
            attachments.push({
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
    if (formattedDocs) {
        for (const d of formattedDocs) {
            attachments.push({
                type: "file",
                name: d.title || d.id,
                title: d.title,
                url: d.url,
                localName: d.localName,
                contentMarkdown: d.contentMarkdown
            });
        }
    }

    const userRequestId = extractTurnRequestId(turn);

    return {
        id: userMsgId,
        role: "user",
        providerRequestId: userRequestId || void 0,
        turnId: userMsgId || void 0,
        content: uText,
        timestamp: ts,
        images: formattedImages,
        documents: formattedDocs,
        attachments: attachments.length ? attachments : void 0,
        attachmentCount: attachments.length,
        messageCount: 1
    };
}

function parseCandidateResponse(
    cand: any,
    turn: any,
    ts: number | null,
    inner: any,
    shortScope: string,
    getUniqueLocalName: (p: string) => string,
    dedupSet: Set<string>,
    docDedupSet: Set<string>,
    imageSeq: { value: number },
    candidateIndex = 0,
    convId?: string
): Message | null {
    const candidateId = cand?.[GEMINI_JSPB_SCHEMA.CANDIDATE.ID] || "";
    const candidateBlock = cand?.[GEMINI_JSPB_SCHEMA.CANDIDATE.BODY] || cand;
    let responseText = extractCandidateText(cand);

    if (!responseText) {
        const textArr: string[] = [];
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

    const structuredContent = extractStructuredContent(turn, cand, candidateIndex);
    const rawAnswerDocument = candidateIndex === 0 && Array.isArray(turn?.[GEMINI_JSPB_SCHEMA.TURN.MODEL_PAYLOAD])
        ? turn[GEMINI_JSPB_SCHEMA.TURN.MODEL_PAYLOAD][GEMINI_JSPB_SCHEMA.MODEL_PAYLOAD.STRUCTURED_CONTENT ?? 12]
        : undefined;
    const answerBody = cand?.[GEMINI_JSPB_SCHEMA.CANDIDATE.BODY];
    const candImages = extractResponseImages(cand, [answerBody, rawAnswerDocument, structuredContent], responseText, imageSeq);
    const filteredImages = filterNewImages(candImages, dedupSet);

    let docsMeta: DeepResearchDocMeta[] = extractDocumentsMeta(candidateBlock);
    if (!docsMeta.length && !docDedupSet.size) {
        docsMeta = extractDocumentsMeta(inner);
    }
    const docs = docsMeta.filter((docItem: DeepResearchDocMeta) => {
        const key = docItem.id || docItem.chipUrl;
        if (!key || docDedupSet.has(key)) return false;
        const isRc = /^rc_/.test(docItem.id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(docItem.id);
        const isHttp = docItem.id.includes("immersive_entry_chip") || docItem.id.startsWith("http");
        if (!isRc && isHttp) return false;
        docDedupSet.add(key);
        return true;
    });

    const docDetails: any[] = [];
    if (docs.length) {
        try {
            for (const metaItem of docs) {
                const primary = findDocContentById(inner, metaItem.id);
                const alt = metaItem.contentId ? findDocContentById(inner, metaItem.contentId) : null;
                const parsedPrimary = parseDocSections(primary);
                const parsedAlt = alt ? parseDocSections(alt) : { sections: [], links: [], contentMarkdown: void 0 };
                const md = parsedPrimary.contentMarkdown || parsedAlt.contentMarkdown || findDocMarkdownByClues(inner, metaItem);
                const cleanMd = md ? stripInternalChipMarkdown(md).trim() : "";
                if (!cleanMd) continue;

                let docTitle = metaItem.title || "";
                if (!docTitle || RESEARCH_PROMPT_PREFIX_RE.test(docTitle) || docTitle === "Document") {
                    const hMatch = cleanMd.match(DOC_TITLE_FALLBACK_RE);
                    if (hMatch && hMatch[1].trim()) {
                        docTitle = hMatch[1].trim();
                    }
                }
                if (!docTitle || RESEARCH_PROMPT_PREFIX_RE.test(docTitle)) {
                    docTitle = `深度研究报告_${shortId(metaItem.id || "doc")}`;
                }

                // P1-9: 上游链任一 heuristic 标记 → 外层写 hasFabricatedText + 日志，
                // 不得静默把拼凑结果转成正常可信结果
                const heuristicChain = metaItem.source === "heuristic-flat"
                    || (parsedPrimary as any)?.contentMatch === "substring"
                    || (parsedAlt as any)?.contentMatch === "substring";
                if (heuristicChain && typeof console !== "undefined" && console.warn) {
                    console.warn(`[GemExporter:parseDetail.ts] heuristic doc content for "${docTitle}" (id=${metaItem.id}); marked hasFabricatedText`);
                }
                docDetails.push({
                    id: metaItem.id,
                    title: docTitle,
                    createdAt: metaItem.createdAt,
                    chipUrl: "",
                    sections: [...parsedPrimary.sections, ...parsedAlt.sections],
                    links: [...parsedPrimary.links, ...parsedAlt.links],
                    contentMarkdown: cleanMd,
                    url: "",
                    localName: getUniqueLocalName(`files/${shortScope}${sanitizeFileName(docTitle, "doc").slice(0, 60)}.md`),
                    type: "file",
                    ...(heuristicChain ? { hasFabricatedText: true } : {})
                });
            }
        } catch (er) {
            console.warn("doc parse err", er);
        }
    }

    const thoughts = extractThoughts(candidateBlock);
    const citations = extractCitations(candidateBlock);
    const groundingCitationMarkers = extractGroundingCitationMarkers(cand || candidateBlock);

    if (responseText) {
        responseText = responseText.replace(/^rc_[a-z0-9_]{10,}\s*/i, "");
        responseText = stripInternalChipMarkdown(responseText);
    }

    const providerRequestId = extractTurnRequestId(turn);
    let genOrdinal = 0;
    const formattedImages = filteredImages.length ? filteredImages.map((img: any) => {
        const isGen = !!img.isGenerated;
        const ordinal = isGen ? genOrdinal++ : undefined;
        return {
            ...img,
            resolvedUrl: highResVariant(img.sourceUrl),
            localName: getUniqueLocalName(`assets/${shortScope}${sanitizeFileName(img.fileName || "img.jpg", "img.jpg")}`),
            type: "image",
            providerRequestId: isGen ? providerRequestId : undefined,
            imageOrdinal: ordinal,
            ...(isGen && providerRequestId ? {
                generation: {
                    chatId: String(convId || '').replace(/^c_/, ''),
                    providerRequestId,
                    imageOrdinal: ordinal,
                    generationOrdinal: 0,
                }
            } : {})
        };
    }) : void 0;

    const attachments: any[] = [];
    if (formattedImages) {
        for (const img of formattedImages) {
            attachments.push({
                type: "image",
                src: img.resolvedUrl || img.sourceUrl,
                localName: img.localName || `assets/${shortScope}${img.fileName}`,
                alt: img.fileName,
                isBlob: false,
                isImage: true,
                originalUrl: img.sourceUrl,
                token: img.token,
                providerRequestId: img.providerRequestId,
                imageOrdinal: img.imageOrdinal,
                ...(img.isGenerated ? { isGenerated: true } : {}),
                ...(img.generation ? { generation: img.generation } : {})
            });
        }
    }
    if (docDetails.length) {
        for (const d of docDetails) {
            if (d.contentMarkdown || (d.url && !isInternalChipUrl(d.url))) {
                attachments.push({
                    type: "file",
                    name: d.title || d.id,
                    title: d.title,
                    url: d.url,
                    localName: d.localName,
                    contentMarkdown: d.contentMarkdown
                });
            }
        }
    }

    if (!responseText && !thoughts && !attachments.length && !docDetails.length && !structuredContent) return null;

    const fallbackTurnId = Array.isArray(turn?.[0])
        ? (turn[0].find((x: any) => typeof x === "string" && (x.startsWith("rc_") || x.startsWith("r_"))) || turn[0][1] || turn[0][0])
        : turn?.[0];

    return {
        id: candidateId || fallbackTurnId || "",
        role: "model",
        content: responseText || "",
        providerRequestId: providerRequestId || void 0,
        turnId: fallbackTurnId || void 0,
        thoughts: thoughts || void 0,
        citations: citations.length ? citations : void 0,
        timestamp: ts,
        images: formattedImages,
        documents: docDetails.length ? docDetails : void 0,
        attachments: attachments.length ? attachments : void 0,
        attachmentCount: attachments.length,
        messageCount: 1,
        ...(structuredContent ? { structuredContent } : {}),
        ...(groundingCitationMarkers.length ? { groundingCitationMarkers } : {})
    };
}

function parseDetail(text: string, targetConvId?: string, _overrides: any = {}): DetailParseResult {
    try {
        const top = robustFirstPayload(text);
        const utils = getUtils();
        const isDevMode = (utils && typeof utils.isDevMode === "function") ? utils.isDevMode() : false;

        const protocol = getProtocol();
        const wrb = protocol.WRB || "wrb.fr";
        const detailRpc = protocol.RPCS ? protocol.RPCS.DETAIL : "hNvQHb";

        const { inner: extractedInner, innerStr, isStandardWrb } = extractInnerPayload(top, {
            wrb,
            rpcId: detailRpc,
            heuristicFilter: s => /c_[a-zA-Z0-9_-]{8,64}/.test(s) || s.includes("rc_") || s.startsWith("[[")
        });

        if (!extractedInner) throw new Error("invalid");

        const { turns, inner, schemaDriftWarnings, turnsRejected } = extractTurnsFromInner(
            extractedInner,
            top,
            innerStr,
            isStandardWrb,
            wrb,
            detailRpc,
            isDevMode
        );

        let convId = extractConversationId(inner, turns);
        if (convId === "c_unknown" && targetConvId) convId = targetConvId;
        const shortScope = getShortScope(convId);

        const allMsgs: Message[] = [];
        const dedupSet = new Set<string>();
        const docDedupSet = new Set<string>();
        const usedLocalNames = new Set<string>();
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

        const imageSeq = { value: 1 };
        const rev = [...turns].reverse();

        for (const turn of rev) {
            const drift: TurnDriftReport = detectTurnSchemaDrift(turn, convId);
            if (drift.isDrifted) {
                schemaDriftWarnings.push(...drift.warnings);
            }
            const ts = extractTurnTimestamp(turn) ?? null;

            const userMsg = buildUserMessage(turn, ts, shortScope, getUniqueLocalName, dedupSet, docDedupSet, imageSeq);
            if (userMsg) {
                allMsgs.push(userMsg);
            }

            const candList = extractModelCandidates(turn);
            if (Array.isArray(candList)) {
                for (let ci = 0; ci < candList.length; ci++) {
                    const cand = candList[ci];
                    const modelMsg = parseCandidateResponse(
                        cand,
                        turn,
                        ts,
                        inner,
                        shortScope,
                        getUniqueLocalName,
                        dedupSet,
                        docDedupSet,
                        imageSeq,
                        ci,
                        convId
                    );
                    if (modelMsg) {
                        allMsgs.push(modelMsg);
                    }
                }
            }
        }

        const metaTitle = Array.isArray(top) ? extractMetaTitleFromTop(top, convId || targetConvId) : null;
        const titleObj = extractConversationTitle(inner, turns);
        const nextToken = extractNextPageToken(inner, GEMINI_JSPB_SCHEMA.INNER.NEXT_TOKEN_CANDIDATES);
        const url = `https://gemini.google.com/app/${String(convId).replace(/^c_/, "")}`;
        const times = turns.map(t => extractTurnTimestamp(t)).filter((x: any): x is number => Number.isFinite(x));
        const minTs = times.length ? Math.min(...times) : null;
        const maxTs = times.length ? Math.max(...times) : null;

        let cleanT = metaTitle || cleanTitle(titleObj.title || convId);
        const isReal = isRealTitle(cleanT, convId);
        let finalSource = metaTitle ? "rpc" : (isReal ? titleObj.source : "default");
        if (!isReal && !metaTitle) {
            const sniffed = resolveDetailTitle(allMsgs, convId);
            if (sniffed) {
                cleanT = sniffed.title;
                finalSource = sniffed.source;
            }
        }
        const titlesMap: TitleSources = {};
        if (finalSource !== "default" && cleanT) {
            titlesMap[finalSource as keyof TitleSources] = cleanT;
        }

        let _debug: any = null;
        if (!allMsgs.length) {
            try {
                _debug = {
                    turnsLen: turns?.length || 0,
                    innerKeys: inner ? Object.keys(inner) : null,
                    innerPreview: JSON.stringify(inner).slice(0, 1500),
                    topPreview: top ? JSON.stringify(top).slice(0, 800) : null
                };
            } catch (e) {
                if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:parseDetail.ts]", e);
            }
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
            turnsRejected: turnsRejected > 0 ? turnsRejected : void 0,
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
    parseDetail,
    extractTurnRequestId,
    DOC_TITLE_FALLBACK_RE
};

export const GeminiParserParseDetail: GeminiParserParseDetailModule = {
    isTurn,
    isTurnsArray,
    findTurnsDeep,
    parseDetail,
    extractTurnRequestId,
    DOC_TITLE_FALLBACK_RE
};

if (typeof module === 'object' && module.exports) module.exports = GeminiParserParseDetail;

export default GeminiParserParseDetail;