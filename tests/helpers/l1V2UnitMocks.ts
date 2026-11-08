/**
 * Contract-shaped L1 test doubles. This module is preloaded BEFORE any L1 import
 * by scripts/test-l1-units.cjs. Nothing here starts L2, Runtime or IndexedDB.
 *
 * Types are checked against the frozen v2 public entrypoints. Mock decisions are
 * scripted by tests; this deliberately does NOT reproduce L2 selection/Coverage.
 */
import type { Account } from '../../src/l2/accountRegistry.js';
import type { ConversationKey } from '../../src/l2/conversationKey.js';
import type { DetailIngestResult } from '../../src/l2/ingestion.js';
import type { AccountContext } from '../../src/runtime/content/accountContext.js';

type Ingest = typeof import('../../src/l2/ingestion.js');
type IndexCall = { accountId: Parameters<Ingest['ingestIndexes']>[0];
    items: Parameters<Ingest['ingestIndexes']>[1]; page: Parameters<Ingest['ingestIndexes']>[2] };
type DetailCall = { accountId: Parameters<Ingest['ingestDetail']>[0];
    conversationId: Parameters<Ingest['ingestDetail']>[1];
    detail: Parameters<Ingest['ingestDetail']>[2]; indexFields: Parameters<Ingest['ingestDetail']>[3] };
type DeletedCall = Parameters<Ingest['ingestDeletedConversation']>;

export const GEMINI_ACCOUNT: Account = {
    id: '10000000-0000-4000-8000-000000000001', providerId: 'gemini', providerAccountId: '10000000001',
};
const OTHER_ACCOUNT: Account = {
    id: '10000000-0000-4000-8000-000000000002', providerId: 'gemini', providerAccountId: '10000000002',
};
export const DEFAULT_ACCOUNT: Account = {
    id: '10000000-0000-4000-8000-000000000003', providerId: 'gemini', providerAccountId: 'default',
};
export const CHATGPT_ACCOUNT: Account = {
    id: '10000000-0000-4000-8000-000000000004', providerId: 'chatgpt',
    providerAccountId: JSON.stringify(['user-1', 'workspace-1']),
};

type Hook = () => void | Promise<void>;
const initialAccounts = [GEMINI_ACCOUNT, OTHER_ACCOUNT, DEFAULT_ACCOUNT, CHATGPT_ACCOUNT];
export const ports = {
    accounts: new Map<string, Account>(),
    cooldowns: new Map<string, number>(),
    indexes: [] as IndexCall[],
    details: [] as DetailCall[],
    deletions: [] as DeletedCall[],
    lookups: [] as string[],
    notifications: [] as string[],
    detailDecision: { accepted: true, changed: true } as DetailIngestResult,
    indexError: null as Error | null,
    detailError: null as Error | null,
    deletionError: null as Error | null,
    beforeIndexCommit: undefined as Hook | undefined,
    beforeDetailCommit: undefined as Hook | undefined,
    beforeDeletionCommit: undefined as Hook | undefined,
    current: null as AccountContext | null,
    reset() {
        this.accounts = new Map(initialAccounts.map(account => [account.id, { ...account }]));
        this.cooldowns.clear();
        this.notifications.length = 0; this.indexes.length = 0; this.details.length = 0; this.deletions.length = 0; this.lookups.length = 0;
        this.detailDecision = { accepted: true, changed: true };
        this.indexError = null; this.detailError = null; this.deletionError = null;
        this.beforeIndexCommit = undefined; this.beforeDetailCommit = undefined;
        this.beforeDeletionCommit = undefined;
        this.current = { providerId: 'gemini', accountId: GEMINI_ACCOUNT.id, slot: 'u0' };
    },
};
ports.reset();

const ingestion: Pick<Ingest, 'ingestIndexes' | 'ingestDetail' | 'ingestDeletedConversation'> = {
    async ingestIndexes(accountId, items, page) {
        await ports.beforeIndexCommit?.();
        if (ports.indexError) throw ports.indexError;
        ports.indexes.push({ accountId, items, page });
        return { added: items.length, updated: 0 };
    },
    async ingestDetail(accountId, conversationId, detail, indexFields) {
        await ports.beforeDetailCommit?.();
        if (ports.detailError) throw ports.detailError;
        ports.details.push({ accountId, conversationId, detail, indexFields });
        if (!ports.detailDecision.accepted && ports.detailDecision.changed)
            throw new TypeError('Invalid mock admission: rejected candidate cannot be changed');
        return { ...ports.detailDecision };
    },
    async ingestDeletedConversation(accountId, conversationId) {
        await ports.beforeDeletionCommit?.();
        if (ports.deletionError) throw ports.deletionError;
        ports.deletions.push([accountId, conversationId]);
    },
};
const cooldownStorage: Pick<typeof import('../../src/l3a/storageService.js'), 'getSourceCooldown' | 'extendSourceCooldown'> = {
    async getSourceCooldown(accountId) { return ports.cooldowns.get(accountId) ?? 0; },
    async extendSourceCooldown(accountId, until) {
        const deadline = Math.max(ports.cooldowns.get(accountId) ?? 0, until);
        ports.cooldowns.set(accountId, deadline);
        return deadline;
    },
};
const accountRegistry: Pick<typeof import('../../src/runtime/api/accountRegistry.js'),
    'getAccount' | 'getOrCreateAccount' | 'listAccounts'> = {
    async getAccount(accountId) {
        ports.lookups.push(accountId);
        const account = ports.accounts.get(accountId);
        return account ? { ...account } : null;
    },
    async getOrCreateAccount(providerId, providerAccountId, email, displayName) {
        // Script one valid L2 fallback response: unknown source can be assigned real A.
        if (providerId === 'gemini' && providerAccountId === 'default') {
            const existingReal = [...ports.accounts.values()].filter(a =>
                a.providerId === providerId && a.providerAccountId !== 'default')
                .sort((a, b) => a.id.localeCompare(b.id))[0];
            if (existingReal) return { ...existingReal };
        }
        const found = [...ports.accounts.values()].find(a =>
            a.providerId === providerId && a.providerAccountId === providerAccountId);
        if (found) return { ...found };
        const created: Account = { id: crypto.randomUUID(), providerId, providerAccountId,
            ...(email ? { email } : {}), ...(displayName ? { displayName } : {}) };
        ports.accounts.set(created.id, created);
        return { ...created };
    },
    async listAccounts(providerId) {
        return [...ports.accounts.values()].filter(a => !providerId || providerId === a.providerId).map(a => ({ ...a }));
    },
};
const accountContext: Pick<typeof import('../../src/runtime/content/accountContext.js'),
    'resolveRequestAccount' | 'resolveCurrentAccount' | 'getAccountContext' | 'matchesCurrentAccount'
    | 'isCurrentAccount' | 'invalidateAccountContext' | 'setAccountChangedHandler'> = {
    async resolveRequestAccount(observation, slot) {
        if (observation === undefined || typeof slot !== 'string' || !/^u\d+$/.test(slot)) return null;
        if (observation !== null && (typeof observation !== 'object' || Array.isArray(observation))) return null;
        const source = observation === null
            ? { providerId: 'gemini', providerAccountId: 'default' }
            : observation as { providerId?: string; providerAccountId?: string };
        if (source.providerId !== 'gemini' || !source.providerAccountId) return null;
        const account = await accountRegistry.getOrCreateAccount(source.providerId, source.providerAccountId);
        return { providerId: account.providerId, accountId: account.id, slot };
    },
    async resolveCurrentAccount() { return ports.current ? { ...ports.current } : null; },
    getAccountContext() { return ports.current ? { ...ports.current } : null; },
    matchesCurrentAccount(observation) {
        const current = ports.current && ports.accounts.get(ports.current.accountId);
        return !!current && current.providerId === observation.providerId
            && current.providerAccountId === observation.providerAccountId;
    },
    isCurrentAccount(context) { return !!ports.current && context.accountId === ports.current.accountId
        && context.providerId === ports.current.providerId && context.slot === ports.current.slot; },
    invalidateAccountContext() { ports.current = null; },
    setAccountChangedHandler() {},
};

const keyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const readConversationKey: typeof import('../../src/l2/conversationKey.js').readConversationKey = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(k => k !== 'accountId' && k !== 'conversationId'))
        throw new TypeError('Invalid conversation key');
    const { accountId, conversationId } = value as ConversationKey;
    if (!keyPattern.test(accountId) || typeof conversationId !== 'string'
        || !conversationId || conversationId !== conversationId.trim())
        throw new TypeError('Invalid conversation key');
    return { accountId, conversationId };
};
/** Pure L2 helpers are also mocked; unit coverage asserts L1's use of the
 * declared v2 shape, not L2's implementation of an AST traversal or policy. */
type BlockNode = import('../../src/l2/content/blocks.js').BlockNode;
type InlineNode = import('../../src/l2/content/inline.js').InlineNode;
const assetReferencePort: Pick<typeof import('../../src/l2/content/assetReferences.js'), 'mapContentAssetReferences'> = {
    mapContentAssetReferences(blocks, resolve) {
        const inline = (node: InlineNode): InlineNode => {
            if (node.type === 'image') return { ...node, assetId: resolve(node.assetId, 'image', node.alt, node.title) };
            if ('children' in node) return { ...node, children: node.children.map(inline) };
            return node;
        };
        const mapBlock = (node: BlockNode): BlockNode => {
            if (node.type === 'image') return { ...node, assetId: resolve(node.assetId, 'image', node.alt) };
            if (node.type === 'file') return { ...node, assetId: resolve(node.assetId, 'file') };
            if (node.type === 'paragraph' || node.type === 'heading')
                return { ...node, children: node.children.map(inline) };
            if (node.type === 'quote') return { ...node, blocks: node.blocks.map(mapBlock) };
            if (node.type === 'list') return { ...node, items: node.items.map(item =>
                ({ ...item, blocks: item.blocks.map(mapBlock) })) };
            if (node.type === 'table') {
                const rows = (items: typeof node.rows) => items.map(row => ({ ...row,
                    cells: row.cells.map(cell => ({ ...cell, children: cell.children.map(inline) })) }));
                return { ...node, rows: rows(node.rows), ...(node.headerRows ? { headerRows: rows(node.headerRows) } : {}),
                    ...(node.caption ? { caption: node.caption.map(inline) } : {}) };
            }
            return node;
        };
        return blocks.map(mapBlock);
    },
};
const sourceUriPort: Pick<typeof import('../../src/l2/sourceUri.js'), 'isDurableSourceUri'> = {
    isDurableSourceUri(value): value is string {
        if (typeof value !== 'string' || !value || value.trim() !== value || /^(?:data|blob):/i.test(value)) return false;
        try {
            const url = new URL(value, 'https://source-locator.invalid/');
            return ![...url.searchParams.keys()].some(k => /^(?:x-goog-.*|x-amz-.*|signature|sig|expires|policy|key-pair-id|access_token|auth_token|token)$/i.test(k));
        } catch { return !value.includes('://'); }
    },
};
const accountIdentityPort: Pick<typeof import('../../src/l2/accountRegistry.js'),
    'readAccountParameters' | 'isAccountId' | 'readAccount' | 'DEFAULT_ACCOUNT_KEY'> = {
    DEFAULT_ACCOUNT_KEY: 'default',
    isAccountId(value): value is string { return typeof value === 'string' && keyPattern.test(value); },
    readAccountParameters(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid account');
        const { providerId, providerAccountId, email, displayName } = value as Partial<Account>;
        if (typeof providerId !== 'string' || !providerId || typeof providerAccountId !== 'string' || !providerAccountId)
            throw new TypeError('Invalid account parameters');
        return { providerId, providerAccountId, ...(email ? { email } : {}), ...(displayName ? { displayName } : {}) };
    },
    readAccount(value) {
        if (!value || typeof value !== 'object') throw new TypeError('Invalid account');
        const account = value as Account;
        if (!accountIdentityPort.isAccountId(account.id)) throw new TypeError('Invalid local account UUID');
        return { id: account.id, ...accountIdentityPort.readAccountParameters(account) };
    },
};

/** These cross-layer mocks isolate the L1 dependency boundary. */
const indexComparisonPort: Pick<typeof import('../../src/l2/conversationIndex.js'),
    'indexActivityTime' | 'compareConversationIndexes'> = {
    indexActivityTime: index => index.updatedAt,
    compareConversationIndexes(a, b) {
        if (a.updatedAt === undefined) return b.updatedAt === undefined ? 0 : 1;
        return b.updatedAt === undefined ? -1 : b.updatedAt - a.updatedAt;
    },
};
type Loader = { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const loader = require('node:module') as Loader;
let installed = false;

/** Install only at the L1 import boundary. The unit runner also rejects
 * accidental direct runtime imports by its own unit files. */
export function installL1V2Mocks(): void {
    if (installed) return;
    installed = true;
    const originalLoad = loader._load;
    loader._load = (request, parent, isMain) => {
        const parentPath = parent?.filename?.replace(/\\/g, '/') ?? '';
        // The unit file (including its helpers) may import L2 *types* but not
        // execute a live external module. Type-only imports are erased by TS.
        if (parentPath.includes('/tests/')
            && ['l2', 'l3a', 'l3b', 'l4', 'runtime', 'application', 'ui']
                .some(layer => request.includes('/src/' + layer + '/')))
            throw new Error('L1 unit test directly loaded external implementation: ' + request);
        if (parentPath.includes('/src/l1/') || parentPath.includes('/src/shared/')) {
            if (request.endsWith('/l2/ingestion.js')) return ingestion;
            if (request.endsWith('/l3a/storageService.js')) return cooldownStorage;
            if (request.endsWith('/runtime/api/domainIngestion.js')) return ingestion;
            if (request.endsWith('/runtime/api/domainChanges.js')) return { notifyDomainChanged: (id: string) => { ports.notifications.push(id); } };
            if (request.endsWith('/runtime/api/accountRegistry.js')) return accountRegistry;
            if (request.endsWith('/runtime/content/accountContext.js')) return accountContext;
            if (request.endsWith('/runtime/content/cleanupRegistry.js')) return { registerCleanup: () => () => {} };
            if (request.endsWith('/l2/conversationKey.js')) return {
                readConversationKey,
                conversationKey: (accountId: string, conversationId: string) =>
                    readConversationKey({ accountId, conversationId }),
                sameConversationKey: (a: ConversationKey, b: ConversationKey) =>
                    a.accountId === b.accountId && a.conversationId === b.conversationId,
            };
            if (request.endsWith('/l2/content/assetReferences.js')) return assetReferencePort;
            if (request.endsWith('/l2/sourceUri.js')) return sourceUriPort;
            if (request.endsWith('/l2/accountRegistry.js')) return accountIdentityPort;
            if (request.endsWith('/runtime/devMode.js')) return { isDevMode: () => false };
            if (request.endsWith('/l2/titleAuthority.js')) return {};
            if (request.endsWith('/l2/conversationIndex.js')) return indexComparisonPort;
            if (/\/(?:l2|l3a|l3b|l4|runtime|application|ui)\//.test(request) && !request.endsWith('.d.ts'))
                throw new Error('Unmocked external dependency in L1 unit test: ' + request + ' from ' + parentPath);
        }
        return Reflect.apply(originalLoad, loader, [request, parent, isMain]);
    };
}
