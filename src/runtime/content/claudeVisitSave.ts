import { isLiveSaveEffective, type GlobalSettings } from '../../application/settings/index.js';
import { claudeUuid } from '../../l1/sniffer/claude/observation.js';
import type { ConversationKey } from '../../l2/conversationKey.js';

/** One opt-in acquisition per visit when SSR bypasses native detail traffic. */
export function createClaudeVisitSave(deps: {
    path: () => string;
    settings: () => Promise<GlobalSettings>;
    account: () => Promise<{ id: string } | null>;
    save: (key: ConversationKey, refresh: boolean) => Promise<unknown>;
}) {
    let visit = { path: deps.path(), native: false, attempted: false };
    return {
        observe(path: string) {
            if (visit.path !== path) visit = { path, native: false, attempted: false };
        },
        nativeDetail(id: string) {
            if (visit.path === '/chat/' + id) visit.native = true;
        },
        async save() {
            const current = visit;
            const id = /^\/chat\/([^/]+)\/?$/.exec(current.path)?.[1];
            if (!claudeUuid(id) || current.native || current.attempted) return;
            const settings = await deps.settings();
            if (visit !== current || deps.path() !== current.path || current.native || current.attempted
                || !isLiveSaveEffective(settings, true)) return;
            // Mark before identity lookup; failures wait for a new visit, never retry.
            current.attempted = true;
            const account = await deps.account();
            if (!account || visit !== current || deps.path() !== current.path || current.native) return;
            if (!isLiveSaveEffective(await deps.settings(), true)
                || visit !== current || deps.path() !== current.path || current.native) return;
            await deps.save({ accountId: account.id, conversationId: id }, true);
        },
    };
}
