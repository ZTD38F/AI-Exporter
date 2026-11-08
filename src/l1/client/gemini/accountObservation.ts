import type { Account } from '../../../l2/accountRegistry.js';

/** Gaia is Gemini identity evidence; email/name are display hints, never local primary keys. */
export function geminiAccountObservation(profile: { gaiaId?: string; email?: string; name?: string } | null): Omit<Account, 'id'> | null {
    if (!profile?.gaiaId?.trim() || profile.gaiaId.trim() === 'default') return null;
    return { providerId: 'gemini', providerAccountId: profile.gaiaId.trim(),
        ...(profile?.email?.trim() ? { email: profile.email.trim().toLowerCase() } : {}),
        ...(profile?.name?.trim() ? { displayName: profile.name.trim() } : {}) };
}
