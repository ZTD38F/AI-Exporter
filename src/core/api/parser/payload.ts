// NOTE: Cannot import from extractors.ts (circular). Schema ref: GEMINI_JSPB_SCHEMA.ERROR_INFO.ERROR_SLOT = 5
const ERROR_SLOT = 5;

export interface InnerPayloadDiscoveryOptions {
    wrb?: string;
    rpcId?: string | string[];
    heuristicFilter?: (candidateStr: string) => boolean;
}

export interface InnerPayloadDiscoveryResult {
    inner: any | null;
    innerStr: string | null;
    isStandardWrb: boolean;
    bardError: string | null;
}

export function payloadToMs(val: unknown): number | null {
    if (!val) return null;
    if (Array.isArray(val) && typeof val[0] === "number" && val[0] > 1e9) {
        if (val[0] > 1e11) return Math.round(val[0]);
        const sec = val[0];
        const nano = typeof val[1] === "number" ? val[1] : 0;
        return Math.round(sec * 1000 + Math.floor(nano / 1e6));
    }
    if (typeof val === "number" && val > 1e9) {
        return val > 1e11 ? Math.round(val) : Math.round(val * 1000);
    }
    return null;
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
                if (Array.isArray(item) && item[0] === wrb && rpcList.includes(item[1]) && typeof item[2] === "string") {
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

    let inner: any = null;
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

export function extractCandidateValue<T>(
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

export function extractWithScan<T>(
    arr: unknown,
    candidateIndices: number[],
    transform: (val: unknown, index: number) => T | null,
    scanAll: boolean = true
): T | null {
    const candidateResult = extractCandidateValue(arr, candidateIndices, transform);
    if (candidateResult !== null) return candidateResult;

    if (scanAll && Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i++) {
            const res = transform(arr[i], i);
            if (res !== null && res !== undefined) return res;
        }
    }
    return null;
}

export function extractNextPageToken(
    inner: unknown,
    candidates: number[] = [1, 2, 3]
): string | null {
    return extractWithScan(
        inner,
        candidates,
        val => (typeof val === "string" && val.startsWith("tC") ? val : null)
    );
}

const PayloadParser = {
    payloadToMs,
    extractInnerPayload,
    extractNextPageToken,
    extractCandidateValue,
    extractWithScan
};

if (typeof module === "object" && module.exports) {
    module.exports = PayloadParser;
}

export default PayloadParser;
