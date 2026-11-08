// NOTE: Cannot import from extractors.ts (circular). Schema ref: GEMINI_JSPB_SCHEMA.ERROR_INFO.ERROR_SLOT = 5
const ERROR_SLOT = 5;

interface InnerPayloadDiscoveryOptions {
    wrb?: string;
    rpcId?: string | string[];
    heuristicFilter?: (candidateStr: string) => boolean;
}

export interface InnerPayloadDiscoveryResult {
    inner: unknown | null;
    innerStr: string | null;
    isStandardWrb: boolean;
    bardError: string | null;
}

/** Provider-native Unix timestamps become finite safe integer milliseconds, truncating sub-ms precision. */
export function payloadToMs(val: unknown): number | null {
    let ms: number | null = null;
    if (Array.isArray(val) && typeof val[0] === 'number' && Number.isSafeInteger(val[0]) && val[0] > 1e9) {
        const sec = val[0];
        const nano: unknown = val[1] === undefined ? 0 : val[1];
        if (typeof nano !== 'number' || !Number.isSafeInteger(nano) || nano < 0 || nano >= 1e9) return null;
        // Truncate the fraction before adding the epoch to avoid floating-point
        // rounding of a nanosecond value just below the next millisecond.
        ms = sec > 1e11 ? sec : sec * 1000 + Math.trunc(nano / 1e6);
    } else if (typeof val === 'number' && Number.isFinite(val) && val > 1e9) {
        ms = val > 1e11 ? Math.trunc(val) : Math.trunc(val * 1000);
    }
    return ms !== null && Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

export function extractInnerPayload(
    top: unknown,
    options?: InnerPayloadDiscoveryOptions
): InnerPayloadDiscoveryResult {
    const wrb = options?.wrb || "wrb.fr";
    const rpcTarget = options?.rpcId;
    const rpcList = Array.isArray(rpcTarget)
        ? rpcTarget
        : (rpcTarget ? [rpcTarget] : []);

    let innerStr: string | null = null;
    let isStandardWrb = false;

    if (Array.isArray(top)) {
        if (rpcList.length > 0) {
            for (const item of top) {
                if (Array.isArray(item) && item[0] === wrb && typeof item[1] === 'string' && rpcList.includes(item[1]) && typeof item[2] === "string") {
                    innerStr = item[2];
                    isStandardWrb = true;
                    break;
                }
            }
        }

        if (!innerStr && options?.heuristicFilter) {
            for (const item of top) {
                if (Array.isArray(item) && typeof item[2] === "string" && options.heuristicFilter(item[2])) {
                    innerStr = item[2];
                    isStandardWrb = false;
                    break;
                }
            }
        }
    }

    let inner: unknown = null;
    if (innerStr) {
        try {
            inner = JSON.parse(innerStr);
        } catch { /* intentional: parse chunk candidate fallback */ }
    }

    if (!inner && Array.isArray(top)) {
        for (const item of top) {
            if (typeof item === "string" && item.startsWith("[[")) {
                try {
                    inner = JSON.parse(item);
                } catch { /* intentional: parse chunk candidate fallback */ }
            }
            if (inner) break;
        }
    }

    let bardError: string | null = null;
    if (!innerStr && !inner && Array.isArray(top)) {
        for (const item of top) {
            if (Array.isArray(item) && item[ERROR_SLOT]) {
                const str5 = JSON.stringify(item[ERROR_SLOT]);
                if (str5.includes("BardErrorInfo")) {
                    bardError = str5;
                    break;
                }
            }
        }
    }

    return {
        inner,
        innerStr,
        isStandardWrb,
        bardError
    };
}

export function extractCandidateValue<T extends string | number>(
    arr: unknown,
    candidateIndices: number[],
    transform: (val: unknown, index: number) => T | null
): T | null {
    if (!Array.isArray(arr)) return null;
    for (const idx of candidateIndices) {
        if (idx >= 0 && idx < arr.length) {
            const res = transform(arr[idx], idx);
            if (res !== null && res !== undefined) return res;
        }
    }
    return null;
}

export function extractNextPageToken(
    inner: unknown,
    candidates: number[] = [1, 2, 3]
): string | null {
    const token = (value: unknown): string | null => typeof value === 'string' && value.startsWith('tC') ? value : null;
    const preferred = extractCandidateValue(inner, candidates, token);
    if (preferred !== null || !Array.isArray(inner)) return preferred;
    for (let i = 0; i < inner.length; i++) {
        if (candidates.includes(i)) continue;
        const value = token(inner[i]);
        if (value !== null) return value;
    }
    return null;
}
