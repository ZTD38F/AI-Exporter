export interface ConversationListItem {
    id: string;
    title: string;
    titleSource: string;
    titles: { rpc: string };
    createdAt: number | null;
    updatedAt: number | null;
    chatTime: number | null;
    timestamp: number | null;
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

import { GEMINI_JSPB_SCHEMA, robustFirstPayload, cleanTitle, isRealTitle, normId } from "./extractors.js";
import { GeminiProtocol } from "../../protocol/protocol.js";
import { payloadToMs, extractInnerPayload, extractNextPageToken, extractWithScan } from "./payload.js";

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

        const candidateIndices = [
            listItemSchema.TIMESTAMP,
            listItemSchema.UPDATE_TIME_ALT,
            listItemSchema.CREATE_TIME_ALT,
            listItemSchema.COUNT_ALT1
        ];

        return extractWithScan(
            item,
            candidateIndices,
            (val, idx) => {
                if (candidateIndices.includes(idx)) {
                    return payloadToMs(val);
                }
                return (Array.isArray(val) && val.length <= 4) ? payloadToMs(val) : null;
            }
        );
    }

    function parseList(text: string): ListParseResult {
        try {
            let top = robustFirstPayload(text);
            const protocol = getProtocol();
            const wrb = protocol.WRB || "wrb.fr";
            const listRpc = protocol.RPCS ? protocol.RPCS.LIST : "MaZiqc";

            const { inner, innerStr, bardError } = extractInnerPayload(top, {
                wrb,
                rpcId: listRpc,
                heuristicFilter: s => s.startsWith("[") || s.startsWith('"[') || /c_[a-zA-Z0-9_-]{8,64}/.test(s)
            });

            if (!innerStr || !inner) {
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
            const innerSchema = GEMINI_JSPB_SCHEMA.INNER;
            let list = Array.isArray(inner[innerSchema.LIST_SECONDARY]) ? inner[innerSchema.LIST_SECONDARY] : (Array.isArray(inner[innerSchema.METADATA_ONLY_LIST]) ? inner[innerSchema.METADATA_ONLY_LIST] : []);
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
                createTs = payloadToMs(createArr);
                updateTs = payloadToMs(updateArr);

                let effectiveTime = serverTs || updateTs || createTs;

                if (typeof item[listItemSchema.COUNT_ALT2] === "number") {
                    count = item[listItemSchema.COUNT_ALT2];
                } else if (typeof item[listItemSchema.COUNT_ALT1] === "number") {
                    count = item[listItemSchema.COUNT_ALT1];
                }

                if (id) {
                    let cleanId = normId(id);
                    const cleanT = cleanTitle(title || cleanId);
                    const isReal = isRealTitle(cleanT, cleanId);
                    convs.push({
                        id: cleanId,
                        title: cleanT,
                        titleSource: isReal ? "rpc" : "default",
                        titles: { rpc: cleanT },
                        createdAt: createTs || effectiveTime || null,
                        updatedAt: effectiveTime || null,
                        chatTime: effectiveTime || null,
                        timestamp: effectiveTime || null,
                        messageCount: count,
                        url: `https://gemini.google.com/app/${cleanId}`
                    });
                }
            }
            const nextToken = extractNextPageToken(inner, innerSchema.NEXT_TOKEN_CANDIDATES);
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

if (typeof module === 'object' && module.exports) module.exports = GeminiParserParseList;

export default GeminiParserParseList;

