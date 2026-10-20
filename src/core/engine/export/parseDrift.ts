/**
 * Phase C (P1-8/P1-9): parser 诊断抽取 —— 纯函数，供导出链路与单测共用。
 *
 * 规则：
 * - turnsRejected > 0（解析器拒识并丢弃了 turn）或会话含 heuristic 拼凑文档
 *   → 导出记录必须标 partial，不能是 ok。
 * - schemaDrift 告警本身只要求可见（warn 日志 + meta.json + _export_errors.json），
 *   不单独决定 partial。
 */
export interface ChatParseDrift {
    schemaDrift: string[];
    turnsRejected: number;
    hasHeuristicDocs: boolean;
}

export function extractChatParseDrift(chat: any): ChatParseDrift {
    const schemaDrift = Array.isArray(chat?.schemaDrift)
        ? chat.schemaDrift.filter((s: any) => typeof s === "string")
        : [];
    const turnsRejected = typeof chat?.turnsRejected === "number" && chat.turnsRejected > 0
        ? Math.floor(chat.turnsRejected)
        : 0;
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    const hasHeuristicDocs = messages.some((m: any) =>
        Array.isArray(m?.documents) && m.documents.some((d: any) => d != null && d.hasFabricatedText === true)
    );
    return { schemaDrift, turnsRejected, hasHeuristicDocs };
}

export function chatRecordStatusWithDrift(base: "ok" | "empty", drift: ChatParseDrift): "ok" | "empty" | "partial" {
    if (drift.turnsRejected > 0 || drift.hasHeuristicDocs) return "partial";
    return base;
}
