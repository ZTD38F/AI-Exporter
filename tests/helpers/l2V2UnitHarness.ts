import Module from 'node:module';
import { resetIndexCoverageSessions } from '../../src/l2/indexCoverage.js';
import type { Account } from '../../src/l2/accountRegistry.js';
import type { ConversationKey } from '../../src/l2/conversationKey.js';
import type { DomainConversationIndex } from '../../src/l2/conversationIndex.js';
import type { DomainConversationDetail } from '../../src/l2/conversationDetail.js';
import type { StreamCoverage } from '../../src/l2/streamCoverage.js';

/**
 * L2 boundary fixture: run REAL L2 admission/coverage/account decisions, with
 * L3a replaced by precisely typed frozen-v2 ports. This is not an
 * IndexedDB simulator: callbacks receive scripted old facts and capture L2's
 * decisions; actual transaction/rollback semantics stay in L3a integration.
 */
export const ACCOUNT: Account = {
    id: '10000000-0000-4000-8000-000000000001',
    providerId: 'gemini',
    providerAccountId: 'source-account',
};
export const DEFAULT_ACCOUNT: Account = {
    id: '10000000-0000-4000-8000-000000000002',
    providerId: 'gemini',
    providerAccountId: 'default',
};

export const accounts = new Map<string, Account>();
export const indexes = new Map<string, DomainConversationIndex>();
export const details = new Map<string, DomainConversationDetail>();
const coverage = new Map<string, StreamCoverage>();
export const calls = {
    indexUpdates: [] as ConversationKey[][],
    detailUpdates: [] as ConversationKey[],
    coverageUpdates: [] as Array<{ accountId: string; streamId: string }>,
    deletions: [] as ConversationKey[],
    insertions: [] as Account[],
    accountWrites: [] as Account[],
};
let writeError: Error | undefined;
const address = (key: ConversationKey) => JSON.stringify([key.accountId, key.conversationId]);
const coverageAddress = (accountId: string, streamId: string) => JSON.stringify([accountId, streamId]);

export function resetL2UnitPorts(): void {
    accounts.clear();
    accounts.set(ACCOUNT.id, { ...ACCOUNT });
    accounts.set(DEFAULT_ACCOUNT.id, { ...DEFAULT_ACCOUNT });
    indexes.clear();
    details.clear();
    coverage.clear();
    for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key].length = 0;
    writeError = undefined;
    resetIndexCoverageSessions();
}
export function rejectNextWrite(error: Error): void { writeError = error; }
function checkWrite(): void {
    const error = writeError;
    writeError = undefined;
    if (error) throw error;
}
export function indexFor(conversationId: string, accountId = ACCOUNT.id): DomainConversationIndex | undefined {
    return indexes.get(address({ accountId, conversationId }));
}
export function detailFor(conversationId: string, accountId = ACCOUNT.id): DomainConversationDetail | undefined {
    return details.get(address({ accountId, conversationId }));
}
export function coverageFor(streamId: string, accountId = ACCOUNT.id): StreamCoverage | undefined {
    return coverage.get(coverageAddress(accountId, streamId));
}

const getAccount: typeof import('../../src/l3a/storageService.js').getAccount =
    async accountId => accounts.get(accountId) ?? null;

const updateIndexesAtomically: typeof import('../../src/l3a/storageService.js').updateIndexesAtomically =
    async (keys, decide) => {
        checkWrite();
        calls.indexUpdates.push([...keys]);
        const updates = decide(keys.map(key => indexes.get(address(key)) ?? null));
        for (const value of updates) indexes.set(address(value.key), value);
    };

const updateConversationAtomically: typeof import('../../src/l3a/storageService.js').updateConversationAtomically =
    async (key, decide) => {
        checkWrite();
        calls.detailUpdates.push({ ...key });
        const decision = decide(indexes.get(address(key)) ?? null, details.get(address(key)) ?? null);
        if (decision.index) indexes.set(address(decision.index.key), decision.index);
        if (decision.detail) details.set(address(decision.detail.key), decision.detail);
        return decision.result;
    };

const updateCoverageAtomically: typeof import('../../src/l3a/storageService.js').updateCoverageAtomically =
    async (accountId, streamId, decide) => {
        checkWrite();
        calls.coverageUpdates.push({ accountId, streamId });
        const location = coverageAddress(accountId, streamId);
        const decision = decide(coverage.get(location) ?? null);
        if (decision.next !== undefined) coverage.set(location, decision.next);
        return decision.result;
    };
const getCoverage: typeof import('../../src/l3a/storageService.js').getCoverage =
    async (accountId, streamId) => coverage.get(coverageAddress(accountId, streamId)) ?? null;
const deleteStoredConversation: typeof import('../../src/l3a/storageService.js').deleteStoredConversation =
    async key => { checkWrite(); calls.deletions.push({ ...key }); };
const insertAccountIfAbsent: typeof import('../../src/l3a/storageService.js').insertAccountIfAbsent =
    async account => {
        checkWrite();
        calls.insertions.push({ ...account });
        return account;
    };
const putAccount: typeof import('../../src/l3a/storageService.js').putAccount =
    async account => { checkWrite(); calls.accountWrites.push({ ...account }); };
const admitAccountAtomically: typeof import('../../src/l3a/storageService.js').admitAccountAtomically =
    async (providerId, decide) => {
        checkWrite();
        const current = [...accounts.values()].filter(account => account.providerId === providerId);
        const result = decide(current);
        const old = accounts.get(result.id);
        if (!old) calls.insertions.push({ ...result });
        else if (JSON.stringify(old) !== JSON.stringify(result)) calls.accountWrites.push({ ...result });
        accounts.set(result.id, { ...result });
        return result;
    };

const storage = {
    getAccount, getCoverage, updateCoverageAtomically, updateIndexesAtomically, updateConversationAtomically,
    deleteStoredConversation, insertAccountIfAbsent, admitAccountAtomically, putAccount,
} satisfies Partial<typeof import('../../src/l3a/storageService.js')>;

type Loader = { _load(request: string, parent?: NodeModule | null, isMain?: boolean): unknown };
const loader = Module as unknown as Loader;
const originalLoad = loader._load;
let ingestion!: typeof import('../../src/l2/ingestion.js');
let admission!: typeof import('../../src/l2/accountAdmission.js');
let coverageAdmission!: typeof import('../../src/l2/coverageAdmission.js');

loader._load = (request, parent, isMain) => {
    const caller = parent?.filename.replace(/\\/g, '/') ?? '';
    if (caller.includes('/src/l2/')) {
        if (request === '../l3a/storageService.js') return storage;
        if (['../l1/', '../l3a/', '../l3b/', '../l4/', '../application/', '../runtime/', '../ui/', '../migration/'].some(part => request.includes(part)))
            throw new Error('Unmocked L2 external-v2 runtime dependency: ' + request);
    }
    return originalLoad.call(loader, request, parent, isMain);
};
try {
    ingestion = require('../../src/l2/ingestion.js') as typeof import('../../src/l2/ingestion.js');
    admission = require('../../src/l2/accountAdmission.js') as typeof import('../../src/l2/accountAdmission.js');
    coverageAdmission = require('../../src/l2/coverageAdmission.js') as typeof import('../../src/l2/coverageAdmission.js');
} finally {
    loader._load = originalLoad;
}

export const { ingestIndexes, ingestDetail, ingestDeletedConversation } = ingestion;
export const { getOrCreateAccount } = admission;
export const { recordPageCoverage } = coverageAdmission;
resetL2UnitPorts();
