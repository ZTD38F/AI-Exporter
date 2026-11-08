import type { Account } from '../../../l2/accountRegistry.js';
export function grokObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Grok source record');
    return value as Record<string, unknown>;
}
export const grokUuid = (value: unknown): value is string => typeof value === 'string'
    && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
export function grokTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'string') return undefined;
    const time = Date.parse(value);
    return Number.isSafeInteger(time) && time > 0 ? time : undefined;
}
export function grokAccount(raw: unknown): Omit<Account, 'id'> {
    const user = grokObject(raw);
    if (!grokUuid(user.userId)) throw new TypeError('Grok user identity unavailable');
    const name = [user.givenName, user.familyName].filter(v => typeof v === 'string').join(' ').trim();
    return { providerId: 'grok', providerAccountId: user.userId,
        ...(typeof user.email === 'string' && user.email.trim() ? { email: user.email.trim() } : {}),
        ...(name ? { displayName: name } : {}) };
}
