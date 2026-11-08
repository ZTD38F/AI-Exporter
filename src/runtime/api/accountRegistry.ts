import { ensureV2Ready } from './runtimeReady.js';
import * as accountStore from '../../l3a/storageService.js';
import * as accountAdmission from '../../l2/accountAdmission.js';
import { readAccount, readAccountRegistry, DEFAULT_ACCOUNT_KEY, type Account } from '../../l2/accountRegistry.js';

/** Extension pages and the worker share the extension-origin Registry. */
function inExtensionContext(): boolean {
    return typeof location !== 'undefined' && location.protocol === 'chrome-extension:';
}
/** All surfaces resolve Accounts from the extension-origin Registry. */
type RegistryRequest =
    | { command: 'get'; accountId: Account['id'] }
    | { command: 'list'; providerId?: Account['providerId'] }
    | ({ command: 'getOrCreate' } & Omit<Account, 'id'>);
async function request(parameters: RegistryRequest): Promise<unknown> {
    const response: unknown = await chrome.runtime.sendMessage({ action: 'accountRegistry', ...parameters });
    if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true || !('value' in response)) {
        throw new Error(response && typeof response === 'object' && 'error' in response ? String(response.error) : 'Account registry unavailable');
    }
    return response.value;
}
export async function getOrCreateAccount(providerId: string, providerAccountId: string,
    email?: string, displayName?: string): Promise<Account> {
    await ensureV2Ready();
    const account = readAccount(inExtensionContext()
        ? await accountAdmission.getOrCreateAccount(providerId, providerAccountId, email, displayName)
        : await request({ command: 'getOrCreate', providerId, providerAccountId, email, displayName }));
    if (account.providerId !== providerId || (providerAccountId !== DEFAULT_ACCOUNT_KEY && account.providerAccountId !== providerAccountId)) throw new TypeError('Account registry identity mismatch');
    return account;
}
export async function listAccounts(providerId?: string): Promise<Account[]> {
    await ensureV2Ready();
    return readAccountRegistry(inExtensionContext()
        ? await accountStore.listAccounts()
        : await request({ command: 'list', providerId })).filter(account => !providerId || account.providerId === providerId);
}
export async function getAccount(accountId: string): Promise<Account | null> {
    await ensureV2Ready();
    const result = inExtensionContext()
        ? await accountStore.getAccount(accountId)
        : await request({ command: 'get', accountId });
    if (result === null) return null;
    const account = readAccount(result);
    if (account.id !== accountId) throw new TypeError('Account registry UUID mismatch');
    return account;
}
