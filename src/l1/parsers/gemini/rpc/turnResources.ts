import { GEMINI_JSPB_SCHEMA, type DecodedGeminiTurn, type DecodedGeminiCandidate } from './extractors.js';
import { decodeCandidateArtifacts } from './candidateArtifacts.js';
import type { GeminiAttachmentEvidence, GeminiDocumentEvidence, GeminiMessageEvidence } from './detailEvidence.js';
import {
    extractImageEvidence,
    extractResponseImageEvidence,
    extractUserFiles,
    extractDocumentsMeta,
    type GeminiDocumentReader,
    filterNewImages,
    isInternalChipUrl,
    type ImageAttachment,
    type UserFileAttachment,
    type DeepResearchDocMeta,
} from './sourceAttachments.js';
import { inspectStructuredContent, type GeminiStructuredExtraction } from './structuredContent.js';
import { stripInternalChipMarkdown } from '../../shared/chipUtils.js';
import { RESEARCH_PROMPT_PREFIX_RE } from '../../../../shared/utils/titleText.js';
import { shortId } from '../../../../shared/utils/pathUtils.js';

/** Central Gemini resource decoder: untrusted wire slots stop here.
 * Message composition only receives validated and normalized source evidence. */
export interface DecodedGeminiUserResources {
    images: ImageAttachment[];
    files: UserFileAttachment[];
}

export interface DecodedGeminiCandidateResources {
    images: ImageAttachment[];
    filteredImages: ImageAttachment[];
    structuredImages: ImageAttachment[];
    generatedFiles: GeminiAttachmentEvidence[];
    documents: GeminiDocumentEvidence[];
    structuredExtraction: GeminiStructuredExtraction;
}

export const DOC_TITLE_FALLBACK_RE = /^#\s+(.+)$/m;

function wireArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

/** Media decoding uses the same Turn payload that decodeTurn validated as text. */
export function decodeGeminiUserResources(
    rawTurn: unknown
): DecodedGeminiUserResources {
    const rawUserPayload = wireArray(rawTurn)
        ? rawTurn[GEMINI_JSPB_SCHEMA.TURN.USER_PAYLOAD] : undefined;
    return {
        images: extractImageEvidence(rawUserPayload),
        files: extractUserFiles(rawUserPayload),
    };
}

/** decodeTurn selects the draft; specialized decoders see only that draft's
 * raw media/document slots and never re-select a Candidate themselves. */
export function decodeGeminiCandidateResources(
    candidate: DecodedGeminiCandidate,
    documents: GeminiDocumentReader,
    dedupSet: Set<string>,
    docDedupSet: Set<string>,
    convId?: string
): DecodedGeminiCandidateResources {
    const { source: cand, index: candidateIndex, body: answerBody, turnDocument } = candidate;
    const candidateBlock = answerBody || cand;
    // Preserve the established ownership, fallback and ordering rules.
    const structuredExtraction = inspectStructuredContent({
        turnDocument, candidateIndex
    });
    const structuredContent = structuredExtraction.status === 'decoded' ? structuredExtraction.document : undefined;
    const rawAnswerDocument = candidateIndex === 0 ? turnDocument : undefined;
    const { images: candImages, structuredImages } = extractResponseImageEvidence(
        cand, [answerBody, rawAnswerDocument], candidate.text, structuredContent
    );
    const filteredImages = filterNewImages(candImages, dedupSet);

    const { generatedFiles, nativeDocuments } = decodeCandidateArtifacts(cand, convId);
    let docsMeta: DeepResearchDocMeta[] = nativeDocuments.length ? [] : extractDocumentsMeta(candidateBlock);
    if (!nativeDocuments.length && !docsMeta.length) {
        // The conversation envelope contains documents from other turns too.
        // Only the correlated answer document may supply missing chip metadata.
        docsMeta = extractDocumentsMeta([cand, rawAnswerDocument]);
    }
    const docs = docsMeta.filter((docItem: DeepResearchDocMeta) => {
        if (generatedFiles.some(file => file.id === docItem.id)
            || generatedFiles.length > 0 && docItem.source === 'heuristic-flat') return false;
        const key = docItem.id || docItem.chipUrl;
        if (!key || docDedupSet.has(key)) return false;
        const isRc = /^rc_/.test(docItem.id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(docItem.id);
        const isHttp = docItem.id.includes("immersive_entry_chip") || docItem.id.startsWith("http");
        if (!isRc && isHttp) return false;
        docDedupSet.add(key);
        return true;
    });

    const docDetails: GeminiDocumentEvidence[] = nativeDocuments.filter(doc => {
        if (docDedupSet.has(doc.id)) return false;
        docDedupSet.add(doc.id);
        return true;
    });
    if (docs.length) {
        try {
            for (const metaItem of docs) {
                const parsedPrimary = documents.byId(metaItem.id);
                const parsedAlt = metaItem.contentId && metaItem.contentId !== metaItem.id ? documents.byId(metaItem.contentId) : null;
                const md = parsedPrimary?.contentMarkdown || parsedAlt?.contentMarkdown || documents.byTitle(metaItem);
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
                    || parsedPrimary?.contentMatch === "substring"
                    || parsedAlt?.contentMatch === "substring";
                if (heuristicChain) {
                    console.warn(`[GemExporter:parseDetail.ts] heuristic doc content for "${docTitle}" (id=${metaItem.id}); marked hasFabricatedText`);
                }
                docDetails.push({
                    id: metaItem.id,
                    title: docTitle,
                    createdAt: metaItem.createdAt,
                    chipUrl: metaItem.chipUrl ?? "",
                    sections: [...(parsedPrimary?.sections ?? []), ...(parsedAlt?.sections ?? [])],
                    links: [...(parsedPrimary?.links ?? []), ...(parsedAlt?.links ?? [])],
                    contentMarkdown: cleanMd,
                    url: "",
                    type: "file",
                    ...(heuristicChain ? { hasFabricatedText: true } : {})
                });
            }
        } catch (er) {
            console.warn("doc parse err", er);
        }
    }

    return {
        images: candImages,
        filteredImages,
        structuredImages,
        generatedFiles,
        documents: docDetails,
        structuredExtraction,
    };
}

function buildUserMessage(
    turn: DecodedGeminiTurn,
    resources: DecodedGeminiUserResources,
    dedupSet: Set<string>,
    docDedupSet: Set<string>
): GeminiMessageEvidence | null {
    const ts = turn.timestamp;
    const uText = turn.userText;
    const uImgs = filterNewImages(resources.images, dedupSet);
    const uFiles = resources.files.filter((f: UserFileAttachment) => {
        const key = f.id || f.sourceUrl || f.fileName;
        if (!key || docDedupSet.has(key)) return false;
        docDedupSet.add(key);
        return true;
    });

    if (!uText && !uImgs.length && !uFiles.length) return null;

    const userMsgId = turn.userMessageId;

    const formattedImages = uImgs.length ? uImgs.map((i: ImageAttachment) => ({
        ...i,
        type: "image",
        isImage: true
    })) : void 0;

    const formattedDocs = uFiles.length ? uFiles.map((f: UserFileAttachment) => {
        return {
            id: f.id,
            title: f.fileName || "attachment",
            createdAt: ts,
            chipUrl: "",
            sections: [],
            links: [],
            contentMarkdown: void 0,
            url: f.sourceUrl,
            candidates: f.thumbnailUrl ? [f.sourceUrl, f.thumbnailUrl] : [f.sourceUrl],
            type: "file"
        };
    }) : void 0;

    const attachments: GeminiAttachmentEvidence[] = [];
    if (formattedImages) {
        for (const im of formattedImages) {
            attachments.push({
                type: "image",
                src: im.sourceUrl,
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
                contentMarkdown: d.contentMarkdown
            });
        }
    }

    const rawRequestId = turn.rawProviderRequestId;

    return {
        id: rawRequestId ?? "",
        role: "user",
        providerRequestId: rawRequestId || void 0,
        rawProviderRequestId: rawRequestId,
        turnId: userMsgId || void 0,
        content: uText,
        timestamp: ts,
        images: formattedImages,
        documents: formattedDocs,
        attachments: attachments.length ? attachments : void 0,
        attachmentCount: attachments.length,
        messageCount: 1,
        structuredImages: []
    };
}

function parseCandidateResponse(
    candidate: DecodedGeminiCandidate,
    turn: DecodedGeminiTurn,
    resources: DecodedGeminiCandidateResources,
    convId?: string
): GeminiMessageEvidence | null {
    const ts = turn.timestamp;
    const candidateId = candidate.id;
    let responseText = candidate.text;
    const { images: candImages, filteredImages, generatedFiles, documents: docDetails, structuredExtraction, structuredImages } = resources;
    const structuredContent = structuredExtraction.status === 'decoded' ? structuredExtraction.document : undefined;

    const { thoughts, citations, sourceAttributions, groundingCitationMarkers } = candidate;

    if (responseText) {
        responseText = responseText.replace(/^rc_[a-z0-9_]{10,}\s*/i, "");
        responseText = stripInternalChipMarkdown(responseText);
    }

    const rawRequestId = turn.rawProviderRequestId;
    const generatedCount = candImages.filter(img => img.isGenerated).length;
    const generationPrompt = turn.userText;
    const formattedImages = filteredImages.length ? filteredImages.map((img: ImageAttachment) => {
        const isGen = !!img.isGenerated;
        const ordinal = isGen ? (img.imageOrdinal ?? (generatedCount === 1 ? 0 : undefined)) : undefined;
        return {
            ...img,
            type: "image",
            providerRequestId: isGen ? rawRequestId : undefined,
            imageOrdinal: ordinal,
            ...(isGen ? {
                generation: {
                    chatId: String(convId || '').replace(/^c_/, ''),
                    providerRequestId: rawRequestId,
                    imageOrdinal: ordinal,
                    generationOrdinal: 0,
                    imageCount: generatedCount,
                    ...(ts !== null ? { time: ts } : {}),
                    ...(generationPrompt.trim() ? { prompt: generationPrompt } : {}),
                }
            } : {})
        };
    }) : void 0;

    const attachments: GeminiAttachmentEvidence[] = [...generatedFiles];
    if (formattedImages) {
        for (const img of formattedImages) {
            attachments.push({
                type: "image",
                src: img.sourceUrl,
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
                    id: d.id,
                    name: d.title || d.id,
                    title: d.title,
                    url: d.url,
                        contentMarkdown: d.contentMarkdown
                });
            }
        }
    }

    if (!responseText && !thoughts && !attachments.length && !docDetails.length && !structuredContent) return null;

    const fallbackTurnId = turn.fallbackTurnId;

    return {
        id: candidateId,
        role: "model",
        content: responseText || "",
        providerRequestId: rawRequestId || void 0,
        rawProviderRequestId: rawRequestId,
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
        structuredExtraction,
        structuredImages,
        ...(sourceAttributions.length ? { sourceAttributions } : {}),
        ...(groundingCitationMarkers.length ? { groundingCitationMarkers } : {})
    };
}

/** The Turn ingress closes all JSPB slots before message composition.
 * Context-dependent document binding and deduplication remain in this decoder. */
export function decodeGeminiTurn(
    turn: DecodedGeminiTurn,
    rawTurn: unknown,
    documents: GeminiDocumentReader,
    dedupSet: Set<string>,
    docDedupSet: Set<string>,
    convId?: string
): GeminiMessageEvidence[] {
    const messages: GeminiMessageEvidence[] = [];
    const userMessage = buildUserMessage(turn, decodeGeminiUserResources(rawTurn), dedupSet, docDedupSet);
    if (userMessage) messages.push(userMessage);

    if (turn.candidate) {
        const resources = decodeGeminiCandidateResources(turn.candidate, documents, dedupSet, docDedupSet, convId);
        const modelMessage = parseCandidateResponse(turn.candidate, turn, resources, convId);
        if (modelMessage) messages.push(modelMessage);
    }
    return messages;
}
