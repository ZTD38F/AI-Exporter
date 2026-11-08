import { readAccountParameters, readAccountRegistry, findAccount, readAccount, DEFAULT_ACCOUNT_KEY, isLegacyGeminiIdentityUpgrade, type Account } from './accountRegistry.js';
import { admitAccountAtomically } from '../l3a/storageService.js';

/** L2 decides ownership; Storage serializes the decision with the account write. */
export async function getOrCreateAccount(providerId: Account['providerId'], providerAccountId: Account['providerAccountId'],
    email?: Account['email'], displayName?: Account['displayName']): Promise<Account> {
    const parameters = readAccountParameters({ providerId, providerAccountId, email, displayName });
    return admitAccountAtomically(providerId, current => {
        const accounts = readAccountRegistry([...current]);
        if (providerAccountId === DEFAULT_ACCOUNT_KEY) {
            // Unknown content belongs to an existing real subject, never a second placeholder.
            // IDs are persistent, so the same subject wins after every restart.
            const real = accounts.filter(account => account.providerAccountId !== DEFAULT_ACCOUNT_KEY)
                .sort((a, b) => a.id.localeCompare(b.id))[0];
            return real ?? accounts.find(account => account.providerAccountId === DEFAULT_ACCOUNT_KEY)
                ?? readAccount({ id: crypto.randomUUID(), ...parameters });
        }
        const matched = findAccount(accounts, providerId, providerAccountId, email, displayName);
        if (matched) return matched;
        const legacy = accounts.filter(account => isLegacyGeminiIdentityUpgrade(account, parameters));
        if (legacy.length === 1) return readAccount({ id: legacy[0].id, ...parameters });
        // A placeholder identity rewrite: a sole placeholder becomes the first verified subject.
        if (accounts.length === 1 && accounts[0].providerAccountId === DEFAULT_ACCOUNT_KEY)
            return readAccount({ id: accounts[0].id, ...parameters });
        return readAccount({ id: crypto.randomUUID(), ...parameters });
    });
}
