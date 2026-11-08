import type { GlobalSettings } from '../../src/application/settings/index.js';
import type { DomainConversationIndex } from '../../src/l2/conversationIndex.js';

/**
 * Runtime unit tests must treat L2 as a contract, not load L2's real validators.
 * These tiny ports accept only test fixture Accounts and ConversationKeys; the
 * real L2 validation/merge/selection is covered by L2's own tests.
 */
export function mockAccountRegistry(knownAccountIds: readonly string[]): Pick<typeof import('../../src/l2/accountRegistry.js'), 'isAccountId'> {
    return {
        isAccountId: (value: unknown): value is string =>
            typeof value === 'string' && knownAccountIds.includes(value),
    };
}

export function mockConversationKey(knownAccountIds: readonly string[]): Pick<typeof import('../../src/l2/conversationKey.js'), 'readConversationKey' | 'sameConversationKey'> {
    return {
        sameConversationKey: (a, b) => a.accountId === b.accountId && a.conversationId === b.conversationId,
        readConversationKey: (value: unknown) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw new TypeError('Invalid conversation key');
            }
            const candidate = value as Record<string, unknown>;
            if (Object.keys(candidate).some(key => key !== 'accountId' && key !== 'conversationId')
                || typeof candidate.accountId !== 'string' || !knownAccountIds.includes(candidate.accountId)
                || typeof candidate.conversationId !== 'string' || !candidate.conversationId
                || candidate.conversationId.trim() !== candidate.conversationId) {
                throw new TypeError('Invalid conversation key');
            }
            return { accountId: candidate.accountId, conversationId: candidate.conversationId };
        },
    };
}

/** Fail fast when a Runtime unit accidentally loads another owner's real code. */
export function assertRuntimeUnitBoundary(resolvedPath: string, root: string): void {
    const relative = resolvedPath.slice(root.length + 1).replace(/\\/g, '/');
    if (/^src\/(?:l1|l2|l3a|l3b|l4|application|ui|migration)\//.test(relative)) {
        throw new Error(`Runtime unit must mock external v2 module: ${relative}`);
    }
}

/** Runtime-unit stand-in for the public Application Live Save predicate. */
export function mockLiveSaveEffective(settings: GlobalSettings, directoryAvailable: boolean): boolean {
    const destination = settings.exportDelivery ?? (settings.enabledDisk ? 'folderWriter' : 'browserDownload');
    return settings.enabledDisk && settings.defaultFormat === 'markdown'
        && destination === 'folderWriter' && directoryAvailable;
}

// Frozen Application Settings defaults; tests supply only scenario-specific patches.
export const v2Settings = {
    defaultFormat: 'markdown' as const,
    skipExported: true,
    includeAssets: true,
    enabledDisk: false,
    developerMode: false,
} satisfies GlobalSettings;

// Frozen L2 Index DTO shape; Runtime Count only uses the returned array length.
export function v2IndexFixtures(accountId: string): DomainConversationIndex[] {
    return ['first', 'second'].map((conversationId, index) => ({
        key: { accountId, conversationId }, title: conversationId,
        titleSource: 'provider' as const, updatedAt: 1700000000000 + index,
    }));
}
