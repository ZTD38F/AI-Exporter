import { grokAccount } from '../../parsers/grok/source.js';
/** Always refresh identity; a cached profile must never bind another user's request. */
export async function observeGrokAccount() {
    const response = await fetch('/rest/auth/get-user', { credentials: 'include' });
    return response.ok ? grokAccount(await response.json()) : null;
}
