import type { Account } from '../../l2/accountRegistry.js';
import { getOrCreateAccount } from '../api/accountRegistry.js';
import { hasGrokAccess, readGrokSource, ensureGrokRegistered } from '../../l1/client/grok/grokAccess.js';
import { grokAccount } from '../../l1/parsers/grok/source.js';
import { syncPlatformContentScripts } from './platformInjection.js';
export async function discoverGrokAccounts(): Promise<Account[]> {
    if (!await hasGrokAccess()) return [];
    const user = grokAccount(await readGrokSource('/rest/auth/get-user'));
    await ensureGrokRegistered();
    await syncPlatformContentScripts('grok');
    return [await getOrCreateAccount('grok', user.providerAccountId, user.email, user.displayName)];
}
