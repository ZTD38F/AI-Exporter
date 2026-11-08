export interface SourceGeneratedMediaIdentity {
    chatId: string;
    providerRequestId?: string;
    time?: number | null;
    prompt?: string;
    generationOrdinal: number;
    imageCount?: number;
    /** Present only when the source establishes a stable ordinal (single image => 0). */
    imageOrdinal?: number;
    turnId?: string;
}


/** Takeout activity timestamps have second precision; RPC retains milliseconds. */
export function eventSecond(value: number | undefined): number | null {
    if (value === undefined || !Number.isFinite(value) || value <= 0) return null;
    return Math.floor(value / 1000);
}

export function normalizeRequestId(id: string | undefined): string | null {
    if (id === undefined || !id.trim()) return null;
    const clean = id.trim().toLowerCase().replace(/^r_/, '');
    return /^[0-9a-f]{16}$/.test(clean) ? clean : (clean.length >= 8 ? clean : null);
}

export function normalizeChatId(id: string): string {
    return id.trim().replace(/^c_/, '');
}

export function sameGenerationEvent(a: SourceGeneratedMediaIdentity, b: SourceGeneratedMediaIdentity): boolean {
    const aChat = normalizeChatId(a.chatId);
    const bChat = normalizeChatId(b.chatId);
    if (!aChat || !bChat || aChat !== bChat) {
        return false;
    }

    const aReq = normalizeRequestId(a.providerRequestId);
    const bReq = normalizeRequestId(b.providerRequestId);
    if (aReq && bReq) {
        return aReq === bReq;
    }
    return a.generationOrdinal === b.generationOrdinal
        && eventSecond(a.time ?? undefined) !== null && eventSecond(a.time ?? undefined) === eventSecond(b.time ?? undefined)
        && !!a.prompt && a.prompt.trim() === b.prompt?.trim();
}
