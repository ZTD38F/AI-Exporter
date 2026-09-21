// parseList.ts - MaZiqc conversation list RPC response parser
import type { GeminiParserExtractorsModule, GeminiJspbSchema } from "./extractors.js";

export interface ConversationListItem {
    id: string;
    title: string;
    titleSource: string;
    titles: { rpc: string };
    createdAt: number;
    updatedAt: number;
    chatTime: number;
    timestamp: number;
    messageCount: number;
    url: string;
}

export interface ListParseResult {
    conversations: ConversationListItem[];
    nextPageToken: string | null;
    _raw?: any;
    _debug?: any;
}

export interface GeminiParserParseListModule {
    extractListItemTimestamp: (item: unknown) => number | null;
    parseList: (text: string) => ListParseResult;
}

declare global {
    var GeminiParserParseList: GeminiParserParseListModule;
    var extractListItemTimestamp: (item: unknown) => number | null;
    var parseList: (text: string) => ListParseResult;
}

import { GEMINI_JSPB_SCHEMA, robustFirstPayload, cleanTitle, isRealTitle, normId } from "./extractors.js";
import { GeminiProtocol } from "../../protocol/protocol.js";

const FALLBACK_SCHEMA = GEMINI_JSPB_SCHEMA;

function getSchema(): any {
    return GEMINI_JSPB_SCHEMA;
}

function getProtocol(): any {
    return GeminiProtocol;
}




    /**
     * Extracts official server-side last updated timestamp from a MaZiqc list item.
     * Google Gemini encodes timestamp as [seconds, nanos] at index 5.
     * Falls back to legacy indices 2, 3 or any valid [seconds, nanos] pair.
     */
    function extractListItemTimestamp(item: unknown): number | null {
        if (!Array.isArray(item)) return null;
        const schema = getSchema();
        const listItemSchema = schema.LIST_ITEM || FALLBACK_SCHEMA.LIST_ITEM;

        // 1. Primary candidate: index 5 (Google official server updatedAt [sec, nano])
        const primary = item[listItemSchema.TIMESTAMP];
        if (Array.isArray(primary) && typeof primary[0] === "number" && primary[0] > 1e9) {
            return Math.round(primary[0] * 1000 + Math.floor((primary[1] || 0) / 1e6));
        }
        if (typeof primary === "number" && primary > 1e9) {
            return primary > 1e11 ? Math.round(primary) : Math.round(primary * 1000);
        }

        // 2. Secondary candidates: index 2, 3, 4
        const alts = [
            item[listItemSchema.UPDATE_TIME_ALT],
            item[listItemSchema.CREATE_TIME_ALT],
            item[listItemSchema.COUNT_ALT1]
        ];
        for (const cand of alts) {
            if (Array.isArray(cand) && typeof cand[0] === "number" && cand[0] > 1e9) {
                return Math.round(cand[0] * 1000 + Math.floor((cand[1] || 0) / 1e6));
            }
            if (typeof cand === "number" && cand > 1e9) {
                return cand > 1e11 ? Math.round(cand) : Math.round(cand * 1000);
            }
        }

        // 3. Fallback: scan any element matching [seconds, nanos]
        for (let i = 0; i < item.length; i++) {
            const val = item[i];
            if (Array.isArray(val) && typeof val[0] === "number" && val[0] > 1e9 && val.length <= 4) {
                return Math.round(val[0] * 1000 + Math.floor((val[1] || 0) / 1e6));
            }
        }
        return null;
    }

    function parseList(text: string): ListParseResult {
        try {
            let top = robustFirstPayload(text);
            let innerStr: string | null = null;
            const protocol = getProtocol();
            const wrb = protocol.WRB || "wrb.fr";
            const listRpc = protocol.RPCS ? protocol.RPCS.LIST : "MaZiqc";

            if (Array.isArray(top)) {
                for (let item of top) {
                    if (Array.isArray(item) && item[0] === wrb && item[1] === listRpc && typeof item[2] === "string") {
                        innerStr = item[2];
                        break;
                    }
                }
                if (!innerStr) {
                    for (let item of top) {
                        if (Array.isArray(item) && typeof item[2] === "string" && (item[2].startsWith("[") || item[2].startsWith('"[') || item[2].includes("c_"))) {
                            innerStr = item[2];
                            break;
                        }
                    }
                }
            }
            if (!innerStr) {
                let bardError: string | null = null;
                if (Array.isArray(top)) {
                    for (let item of top) {
                        if (Array.isArray(item) && item[5]) {
                            let str5 = JSON.stringify(item[5]);
                            if (str5.includes("BardErrorInfo")) {
                                bardError = str5;
                                break;
                            }
                        }
                    }
                }
                if (bardError) {
                    console.log("[Gemini Exporter] Google 服务端翻页到达极限 (BardErrorInfo):", bardError);
                } else {
                    console.warn("[Gemini Exporter] parseList: no inner JSON string found. Raw text len:", text?.length);
                }
                return {
                    conversations: [],
                    nextPageToken: null,
                    _debug: {
                        error: bardError ? "BARD_ERROR_INFO" : "NO_INNER_STR",
                        bardError: bardError,
                        textLen: text?.length,
                        rawPreview: text?.slice(0, 500),
                        topParsed: top ? JSON.stringify(top).slice(0, 500) : null
                    }
                };
            }
            let inner = JSON.parse(innerStr);
            let list = Array.isArray(inner[1]) ? inner[1] : (Array.isArray(inner[2]) ? inner[2] : []);
            let convs: ConversationListItem[] = [];
            const schema = getSchema();
            const listItemSchema = schema.LIST_ITEM || FALLBACK_SCHEMA.LIST_ITEM;

            for (let item of list) {
                if (!Array.isArray(item)) continue;
                let id = item[listItemSchema.ID] || item[0] || "",
                    title = item[listItemSchema.TITLE] || item[1] || "",
                    createTs: number | null = null,
                    updateTs: number | null = null,
                    count = 0;

                let serverTs = extractListItemTimestamp(item);

                let createArr = item[listItemSchema.CREATE_TIME_ALT];
                let updateArr = item[listItemSchema.UPDATE_TIME_ALT];
                if (Array.isArray(createArr) && typeof createArr[0] === "number" && createArr[0] > 1e9) {
                    createTs = Math.round(1000 * createArr[0] + Math.floor((createArr[1] || 0) / 1e6));
                }
                if (Array.isArray(updateArr) && typeof updateArr[0] === "number" && updateArr[0] > 1e9) {
                    updateTs = Math.round(1000 * updateArr[0] + Math.floor((updateArr[1] || 0) / 1e6));
                }

                let effectiveTime = serverTs || updateTs || createTs;
                let fallbackTime = effectiveTime || Date.now();

                if (typeof item[listItemSchema.COUNT_ALT2] === "number") {
                    count = item[listItemSchema.COUNT_ALT2];
                } else if (typeof item[listItemSchema.COUNT_ALT1] === "number") {
                    count = item[listItemSchema.COUNT_ALT1];
                } else if (typeof item[5] === "number") {
                    count = item[5];
                }

                if (id) {
                    let cleanId = String(id).replace(/^c_/, "").trim();
                    const cleanT = cleanTitle(title || cleanId);
                    const isReal = isRealTitle(cleanT, cleanId);
                    convs.push({
                        id: cleanId,
                        title: cleanT,
                        titleSource: isReal ? "rpc" : "default",
                        titles: { rpc: cleanT },
                        createdAt: createTs || effectiveTime || fallbackTime,
                        updatedAt: effectiveTime || fallbackTime,
                        chatTime: effectiveTime || fallbackTime,
                        timestamp: effectiveTime || fallbackTime,
                        messageCount: count,
                        url: `https://gemini.google.com/app/${cleanId}`
                    });
                }
            }
            let nextToken: string | null = null;
            if (typeof inner[1] === "string" && inner[1].startsWith("tC")) nextToken = inner[1];
            if (!nextToken && typeof inner[2] === "string" && inner[2].startsWith("tC")) nextToken = inner[2];
            if (!nextToken && typeof inner[3] === "string" && inner[3].startsWith("tC")) nextToken = inner[3];
            if (!nextToken && Array.isArray(inner)) {
                for (let elem of inner) {
                    if (typeof elem === "string" && elem.startsWith("tC")) {
                        nextToken = elem;
                        break;
                    }
                }
            }
            return {
                conversations: convs,
                nextPageToken: nextToken,
                _raw: inner
            };
        } catch (e: any) {
            console.error("[Gemini Exporter] parseList exception:", e.message, "raw text snippet:", text ? text.slice(0, 300) : "empty");
            throw new Error("列表解析失败: " + e.message);
        }
    }

export {
    extractListItemTimestamp,
    parseList
};

export const GeminiParserParseList: GeminiParserParseListModule = {
    extractListItemTimestamp,
    parseList
};

if (typeof globalThis !== 'undefined') {
    (globalThis as any).GeminiParserParseList = GeminiParserParseList;
    (globalThis as any).extractListItemTimestamp = extractListItemTimestamp;
    (globalThis as any).parseList = parseList;
}
if (typeof module === 'object' && module.exports) module.exports = GeminiParserParseList;

export default GeminiParserParseList;

