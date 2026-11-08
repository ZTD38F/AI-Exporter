/** Boundary conversion: numeric values/strings are milliseconds, never guessed seconds. */
export function normalizeTimestamp(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const s = value.trim();
    const time = /^-?\d+$/.test(s) ? Number(s) : Date.parse(s);
    return Number.isSafeInteger(time) ? time : undefined;
}
