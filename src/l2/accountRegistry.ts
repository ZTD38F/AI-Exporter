/** The only durable account entity. Runtime routing and credentials live outside this model. */
export interface Account {
    id: string;
    providerId: string;
    providerAccountId: string;
    email?: string;
    displayName?: string;
}
export const DEFAULT_ACCOUNT_KEY = 'default';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isAccountId(value: unknown): value is string {
    return typeof value === 'string' && uuid.test(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) throw new TypeError('Invalid account');
    return value;
}
/** Validate temporary transport parameters without introducing another account entity. */
export function readAccountParameters(value: unknown): Omit<Account, 'id'> {
    const raw = object(value);
    const fields = ['providerId', 'providerAccountId', 'email', 'displayName'];
    const { providerId, providerAccountId, email, displayName } = raw;
    if (Object.keys(raw).some(key => !fields.includes(key))
        || typeof providerId !== 'string' || !providerId || providerId !== providerId.trim()
        || typeof providerAccountId !== 'string' || !providerAccountId || providerAccountId !== providerAccountId.trim()
        || (email !== undefined && (typeof email !== 'string' || !email || email !== email.trim()))
        || (displayName !== undefined && (typeof displayName !== 'string' || !displayName || displayName !== displayName.trim()))) {
        throw new TypeError('Invalid account parameters');
    }
    return { providerId, providerAccountId,
        ...(providerAccountId === DEFAULT_ACCOUNT_KEY ? {} : {
            ...(email !== undefined ? { email } : {}),
            ...(displayName !== undefined ? { displayName } : {}) }) };
}
export function readAccount(value: unknown): Account {
    const { id, ...parameters } = object(value);
    if (!isAccountId(id)) throw new TypeError('Invalid local account UUID');
    return { id, ...readAccountParameters(parameters) };
}
export function readAccountRegistry(value: unknown): Account[] {
    if (!Array.isArray(value)) throw new TypeError('Invalid account registry');
    const accounts = value.map(readAccount);
    const ids = new Set<string>(), subjects = new Set<string>();
    for (const account of accounts) {
        const subject = JSON.stringify([account.providerId, account.providerAccountId]);
        if (ids.has(account.id) || subjects.has(subject)) throw new TypeError('Duplicate account identity');
        ids.add(account.id); subjects.add(subject);
    }
    return accounts;
}
/** Pure identity match and profile update. Account admission allocates; Storage commits atomically. */
export function findAccount(accounts: readonly Account[], providerId: string, providerAccountId: string,
    email?: string, displayName?: string): Account | null {
    const parameters = readAccountParameters({ providerId, providerAccountId, email, displayName });
    const matches = accounts.filter(account => account.providerId === providerId && account.providerAccountId === providerAccountId);
    if (matches.length > 1) throw new TypeError('Duplicate account identity');
    return matches.length ? { ...matches[0], ...parameters } : null;
}

/** Only released-1.7 migration aliases may become a verified Gaia identity. */
export function isLegacyGeminiIdentityUpgrade(old: Account, incoming: Omit<Account, 'id'>): boolean {
    return old.providerId === 'gemini' && incoming.providerId === 'gemini'
        && !!old.email && old.providerAccountId === 'legacy-email:' + old.email.toLowerCase()
        && old.email.toLowerCase() === incoming.email?.toLowerCase()
        && /^\d+$/.test(incoming.providerAccountId);
}
