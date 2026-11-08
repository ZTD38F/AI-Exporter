/** Untrusted Gemini source payload fallback belongs in L1, not the typed Domain layer. */
const UNKNOWN_PAYLOAD_MAX_DEPTH = 4;
const UNKNOWN_PAYLOAD_MAX_LENGTH = 2000;

function stringifyLimited(value: unknown, depth: number): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (depth >= UNKNOWN_PAYLOAD_MAX_DEPTH) return Array.isArray(value) ? '[…]' : '{…}';
    if (Array.isArray(value)) {
        return `[${value.map((v) => stringifyLimited(v, depth + 1)).join(', ')}]`;
    }
    // Object.entries(undefined) throws; preserve the existing unreadable fallback without a non-null assertion.
    if (value === undefined) throw new TypeError('Cannot enumerate undefined provider content');
    const entries: [string, unknown][] = Object.entries(value);
    entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${stringifyLimited(v, depth + 1)}`).join(', ')}}`;
}

export function formatUnknownPayload(payload: unknown): { text: string; truncated: boolean } {
    let text: string;
    try {
        text = stringifyLimited(payload, 0);
    } catch {
        text = '[unprintable payload]';
    }
    if (text.length > UNKNOWN_PAYLOAD_MAX_LENGTH) {
        return { text: text.slice(0, UNKNOWN_PAYLOAD_MAX_LENGTH) + '…', truncated: true };
    }
    return { text, truncated: false };
}
