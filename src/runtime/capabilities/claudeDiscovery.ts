import { syncPlatformContentScripts } from './platformInjection.js';
import { getOrCreateAccount } from '../api/accountRegistry.js';
import { hasClaudeAccess, readClaudeSource, ensureClaudeRegistered } from '../../l1/client/claude/claudeAccess.js';
import type { Account } from '../../l2/accountRegistry.js';
import { claudeUuid } from '../../l1/sniffer/claude/observation.js';

/** Read only chat-capable Claude organizations; never invent an account from a tab URL. */
export async function discoverClaudeAccounts(): Promise<Account[]> {
    if (!await hasClaudeAccess()) return [];
    const raw = await readClaudeSource('/api/organizations');
    if (!Array.isArray(raw)) throw new TypeError('Claude organization response changed');
    const verified = raw.flatMap((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || !('uuid' in value)
            || typeof value.uuid !== 'string' || !claudeUuid(value.uuid)) return [];
        const name = 'name' in value && typeof value.name === 'string' ? value.name.trim() : '';
        const chat = 'capabilities' in value && Array.isArray(value.capabilities) && value.capabilities.includes('chat');
        return [{ uuid: value.uuid, name, chat }];
    });
    const chatOrganizations = verified.filter(value => value.chat);
    // Older Claude accounts may omit capabilities. Fallback only when
    // exactly one organization makes source identity unambiguous.
    const organizations = chatOrganizations.length ? chatOrganizations
        : verified.length === 1 ? verified : [];
    if (!organizations.length) return [];
    await ensureClaudeRegistered();
    await syncPlatformContentScripts('claude');
    const accounts: Account[] = [];
    for (const organization of organizations) {
        accounts.push(await getOrCreateAccount('claude', organization.uuid,
            undefined, organization.name || undefined));
    }
    return accounts;
}
