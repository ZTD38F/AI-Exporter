import { geminiResponse, type GeminiResponseEnvelope } from './responseEnvelope.js';
import { findListConversationMetadata } from './listMetadata.js';
import type { GeminiDetailEvidence, GeminiMessageEvidence, GeminiDetailDebugEvidence } from './detailEvidence.js';
import type { TurnDriftReport, TitleResult } from "./extractors.js";

import {
    GEMINI_JSPB_SCHEMA,
    detectTurnSchemaDrift,
    decodeTurn,
    hasTurnContentMarkers,
    safeStructureClean,
    extractConversationId,
    smartSummarizePrompt,
    extractConversationTitle,
    normId,
    cleanTitle,
    isRealTitle
} from "./extractors.js";
import { createDocumentReader } from "./sourceAttachments.js";
import GeminiProtocol from "../../../protocol/gemini/protocol.js";
import { isDevMode as devModeEnabled } from "../../../../runtime/devMode.js";
import { extractNextPageToken } from "./payload.js";
import { classifyDetailBody } from './emptyDetail.js';
import { resolveDetailTitle } from "../../../../shared/utils/titleText.js";
import { decodeGeminiTurn, DOC_TITLE_FALLBACK_RE } from './turnResources.js';

const isTurnCache = new WeakMap<unknown[], boolean>();

function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTurn(turn: unknown): boolean {
    if (!isUnknownArray(turn) || turn.length < 3) return false;
    const cached = isTurnCache.get(turn);
    if (cached !== undefined) return cached;
    const head = turn[0];
    let idStr = "";
    if (typeof head === "string") idStr = head;
    else if (isUnknownArray(head) && head.length) {
        idStr = typeof head[0] === "string" ? head[0] : (isUnknownArray(head[0]) && typeof head[0][0] === "string" ? head[0][0] : "");
    }
    let result = false;
    if (idStr && (idStr.startsWith("c_") || idStr.startsWith("r_"))) {
        result = hasTurnContentMarkers(turn);
    }
    isTurnCache.set(turn, result);
    return result;
}

function isTurnsArray(arr: unknown): arr is unknown[] {
    if (!isUnknownArray(arr) || arr.length === 0) return false;
    let cnt = 0;
    for (const t of arr) if (isTurn(t)) cnt++;
    return cnt >= 1 && cnt / arr.length >= 0.5;
}

function findTurnsDeep(root: unknown, depth: number = 0): unknown[] | null {
    if (!root || depth > 6) return null;
    if (isTurnsArray(root)) return root;
    if (isUnknownArray(root)) {
        for (const el of root) {
            const found = findTurnsDeep(el, depth + 1);
            if (found) return found;
        }
    } else if (isUnknownRecord(root)) {
        for (const k in root) {
            const found = findTurnsDeep(root[k], depth + 1);
            if (found) return found;
        }
    }
    return null;
}

interface TurnsExtractionResult {
    turns: unknown[];
    inner: unknown;
    schemaDriftWarnings: string[];
    metadataConversation: GeminiDetailEvidence['metadataConversation'];
}

function extractTurnsFromInner(
    inner: unknown,
    top: unknown[] | null,
    innerStr: string | null,
    isStandardWrb: boolean,
    wrb: string,
    detailRpc: string,
    isDevMode: boolean
): TurnsExtractionResult {
    const schemaDriftWarnings: string[] = [];
    if (top !== null && top.length > 0 && !isStandardWrb && innerStr) {
        schemaDriftWarnings.push(`Envelope drift: batchexecute response missing standard WRB detail RPC header [${wrb}, ${detailRpc}], fell back to heuristic payload discovery`);
    }

    let activeInner = inner;
    let turns: unknown[] | null = null;
    const innerSchema = GEMINI_JSPB_SCHEMA.INNER;
    const initialSlots = isUnknownArray(activeInner) ? activeInner : [];
    const primaryTurns = initialSlots[innerSchema.TURNS_OR_LIST_PRIMARY];
    if (isTurnsArray(primaryTurns)) {
        turns = primaryTurns;
    }
    if (!turns) turns = findTurnsDeep(activeInner);
    if (!turns && top !== null) {
        for (const item of top) {
            if (!isUnknownArray(item) || typeof item[2] !== "string") continue;
            if (item[2] === innerStr) continue;
            try {
                const altInner: unknown = JSON.parse(item[2]);
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

    const metaListIdx = innerSchema.METADATA_ONLY_LIST;
    const activeSlots = isUnknownArray(activeInner) ? activeInner : [];
    const metaRows = activeSlots[metaListIdx];
    const firstMeta = isUnknownArray(metaRows) ? metaRows[0] : undefined;
    const firstMetaSlots = isUnknownArray(firstMeta) ? firstMeta : null;
    const rawMetadataId = firstMetaSlots?.[0];
    const metadataId = typeof rawMetadataId === 'string' && rawMetadataId.startsWith('c_')
        ? rawMetadataId : undefined;
    const isMetadataOnly = !turns.length
        && activeSlots[innerSchema.TURNS_OR_LIST_PRIMARY] === null
        && activeSlots[innerSchema.LIST_SECONDARY] === null
        && isUnknownArray(metaRows) && metaRows.length > 0
        && metadataId !== undefined;
    const rawMetadataTitle = firstMetaSlots?.[1];
    const metadataConversation = isMetadataOnly && typeof rawMetadataTitle === 'string' && rawMetadataTitle.trim()
        ? { id: metadataId, title: cleanTitle(rawMetadataTitle) }
        : undefined;

    if (isMetadataOnly) {
        schemaDriftWarnings.push(`metadata-only payload: hNvQHb returned no turns (inner[${metaListIdx}][0] looks like a list-format row); exported messages will be empty`);
    }
    if (isMetadataOnly && isDevMode) {
        console.warn("[Parser] hNvQHb returned metadata-only payload (no turns). " +
            `inner[${metaListIdx}][0] looks like a list-format row, not a turns array. ` +
            "conv:", firstMetaSlots?.[0], "title:", firstMetaSlots?.[1],
            "rc_count:", firstMetaSlots?.filter(x => typeof x === "string" && x.startsWith("rc_")).length);
    }
    if (!turns.length && activeInner && isUnknownArray(activeInner) && activeInner.length > 0 && !isMetadataOnly) {
        schemaDriftWarnings.push(`Payload drift: inner JSON array present (length ${activeInner.length}) but unable to locate turns array`);
    }

    return { turns, inner: activeInner, schemaDriftWarnings, metadataConversation };
}

/** Source facts only: no archive destinations, unique names or synthetic image filenames. */
function decodeGeminiDetail(text: string | GeminiResponseEnvelope, targetConvId?: string): GeminiDetailEvidence {
    try {
        const response = geminiResponse(text);
        const top = response.scope(GeminiProtocol.RPCS.DETAIL);
        const isDevMode = devModeEnabled();

        const protocol = GeminiProtocol;
        const wrb = protocol.WRB || "wrb.fr";
        const detailRpc = protocol.RPCS ? protocol.RPCS.DETAIL : "hNvQHb";

        const { inner: extractedInner, innerStr, isStandardWrb } = response.payload(detailRpc);

        if (!extractedInner) throw new Error("invalid");

        const { turns, inner, schemaDriftWarnings, metadataConversation } = extractTurnsFromInner(
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

        const allMsgs: GeminiMessageEvidence[] = [];
        const dedupSet = new Set<string>();
        const docDedupSet = new Set<string>();
        const rev = [...turns].reverse();
        const documents = createDocumentReader(inner);

        let turnsRejected = 0;
        let turnsRecovered = 0;
        for (const rawTurn of rev) {
            const drift: TurnDriftReport = detectTurnSchemaDrift(rawTurn, convId);
            if (drift.isDrifted) {
                schemaDriftWarnings.push(...drift.warnings);
            }

            const turn = decodeTurn(rawTurn);
            if (!turn) {
                turnsRejected++;
                continue;
            }
            if (!isTurn(rawTurn)) turnsRecovered++;
            allMsgs.push(...decodeGeminiTurn(turn, rawTurn, documents, dedupSet, docDedupSet, convId));
        }

        const metadata = findListConversationMetadata(response, convId === 'c_unknown' ? targetConvId ?? '' : convId);
        const metaTitle = metadata?.title || null;
        const titleObj = extractConversationTitle(inner, turns);
        const nextToken = extractNextPageToken(inner, GEMINI_JSPB_SCHEMA.INNER.NEXT_TOKEN_CANDIDATES);
        const url = `https://gemini.google.com/app/${String(convId).replace(/^c_/, "")}`;

        let cleanT = metaTitle || cleanTitle(titleObj.title || convId);
        const isReal = isRealTitle(cleanT, convId);
        let finalSource: TitleResult["source"] = metaTitle ? "rpc" : (isReal ? titleObj.source : "default");
        if (!isReal && !metaTitle) {
            const sniffed = resolveDetailTitle(allMsgs, convId);
            if (sniffed) {
                cleanT = sniffed.title;
                finalSource = "sniff";
            }
        }
        let _debug: GeminiDetailDebugEvidence | null = null;
        if (!allMsgs.length) {
            try {
                _debug = {
                    turnsLen: turns?.length || 0,
                    innerKeys: inner ? Object.keys(inner) : null,
                    innerPreview: JSON.stringify(inner).slice(0, 1500),
                    topPreview: top ? JSON.stringify(top).slice(0, 800) : null
                };
            } catch (e) {
                console.debug("[GemExporter:parseDetail.ts]", e);
            }
        }
        if (schemaDriftWarnings.length) {
            if (!_debug) _debug = {};
            _debug.schemaDriftWarnings = schemaDriftWarnings;
        }

        return {
            id: convId,
            ...(metadataConversation ? { metadataConversation } : {}),
            title: cleanT,
            titleSource: finalSource,
            messages: allMsgs,
            updatedAt: metadata?.updatedAt ?? null,
            url,
            nextPageToken: nextToken,
            attachmentCount: allMsgs.reduce((a, m) => a + (m.attachmentCount || 0), 0),
            schemaDrift: schemaDriftWarnings.length ? schemaDriftWarnings : void 0,
            turnsRejected: turnsRejected > 0 ? turnsRejected : void 0,
            turnsRecovered: turnsRecovered > 0 ? turnsRecovered : void 0,
            bodyShape: classifyDetailBody(inner, convId),
            _raw: inner,
            _debug
        };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error("detail parse fail: " + message);
    }
}

export { decodeGeminiDetail, isTurn, findTurnsDeep, DOC_TITLE_FALLBACK_RE };

