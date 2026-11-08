import { activeClaudeOrganization, claudeUuid } from '../../sniffer/claude/observation.js';
import type { Account } from '../../../l2/accountRegistry.js';

interface ClaudeOrganization { uuid: string; name?: string }
let pending: Promise<void> | undefined;
let organizations: ClaudeOrganization[] = [];
let expires = 0;
/** Verify membership once per short session; changing cookies never reuses an old binding. */
export async function observeClaudeAccount(): Promise<Omit<Account, 'id'> | null> {
    const id = activeClaudeOrganization(document.cookie);
    if (!id) return null;
    if (Date.now() >= expires) {
        pending ??= fetch('/api/organizations', { credentials: 'include' })
            .then(async response => {
                const raw: unknown = response.ok ? await response.json() : null;
                organizations = Array.isArray(raw) ? raw.flatMap((item: unknown): ClaudeOrganization[] => {
                    if (!item || typeof item !== 'object' || !('uuid' in item)
                        || typeof item.uuid !== 'string' || !claudeUuid(item.uuid)) return [];
                    const name = 'name' in item && typeof item.name === 'string' ? item.name.trim() : '';
                    return [{ uuid: item.uuid, ...(name ? { name } : {}) }];
                }) : [];
                expires = Date.now() + 30_000;
            })
            .finally(() => { pending = undefined; });
        await pending;
    }
    if (activeClaudeOrganization(document.cookie) !== id) return null;
    const organization = organizations.find(org => org.uuid === id);
    if (!organization) return null;
    return { providerId: 'claude', providerAccountId: id,
        ...(organization.name ? { displayName: organization.name } : {}) };
}
