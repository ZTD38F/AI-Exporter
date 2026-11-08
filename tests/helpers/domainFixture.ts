import type { Account } from '../../src/l2/accountRegistry.js';
import type { ConversationKey } from '../../src/l2/conversationKey.js';
import type { TrustedDomain } from '../../src/l2/runtimeValidation.js';
import type { Diagnostic } from '../../src/shared/diagnostics/diagnostic.js';
import type { LegacyResourceHints } from './recordFixture/resourceHints.js';
import type { ResourceAcquisitionHints } from '../../src/l1/resources/resourceAcquisition.js';
import type { QualityEvidence } from '../../src/l1/parsers/qualityEvidence.js';

/** Test setup for already-bound historical facts, never an L1 parser contract. */
export interface DomainFixture {
    account: Account;
    conversation: TrustedDomain;
    diagnostics: Diagnostic[];
    resourceHints: LegacyResourceHints;
    acquisitionHints: ResourceAcquisitionHints;
    sourceVersion?: number;
    evidence?: QualityEvidence;
}
const providers = new Map<string, Account>();
export function fixtureAccount(providerId = 'gemini', id?: string): Account {
    const known = providers.get(providerId);
    if (known && !id) return { ...known };
    const suffix = providerId === 'gemini' ? 1 : providerId === 'chatgpt' ? 4 : ({ custom: 5, future: 6, other: 7, example: 8, neutral: 9, openai: 10, independent: 11 }[providerId] ?? (100 + [...providerId].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1000000000, 0)));
    const account = { id: id ?? `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`, providerId, providerAccountId: providerId === 'gemini' ? '10000000001' : 'fixture-user' };
    if (!id) providers.set(providerId, account);
    return account;
}
export function fixtureKey(conversationId = 'fixture', providerId = 'gemini'): ConversationKey {
    return { accountId: fixtureAccount(providerId).id, conversationId };
}
export function fixtureAccountFor<T extends { index: { key: ConversationKey } }>(conversation: T): Account {
    const accountId = conversation.index.key.accountId;
    for (const provider of ['gemini', 'chatgpt', 'other', 'future', 'neutral', 'custom', 'openai', 'example', 'independent']) fixtureAccount(provider);
    const account = [...providers.values()].find(item => item.id === accountId);
    if (account) return { ...account };
    if (['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003'].includes(accountId)) return fixtureAccount('gemini', accountId);
    throw new Error(`Undeclared fixture Account ${accountId}`);
}
/** Explicitly create a distinct account-owned test snapshot. */
export function bindFixture<T extends DomainFixture>(value: T, account: Account | string): T {
    const result = structuredClone(value);
    result.account = typeof account === 'string' ? fixtureAccount(value.account.providerId, account) : account;
    result.conversation.index.key.accountId = result.account.id;
    result.conversation.detail.key = { ...result.conversation.index.key };
    return result;
}
