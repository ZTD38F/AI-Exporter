import { fixtureKey } from './helpers/domainFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectConversationDetail } from '../src/l2/conversationDetail.js';
import type { DomainConversationDetail } from '../src/l2/conversationDetail.js';

function snapshot(status: DomainConversationDetail['quality']['status'], count: number, savedAt?: number): DomainConversationDetail {
    return { key: fixtureKey(), ...(savedAt !== undefined ? { savedAt } : {}), quality: { status }, assets: [], messages: Array.from({ length: count }, () => ({ role: 'user' as const, content: [] })) };
}

test('L2 accepts a shorter complete snapshot and never prefers message count', () => {
    const old = snapshot('complete', 10, 10), next = snapshot('complete', 2, 20);
    assert.equal(selectConversationDetail(old, next), next);
});
test('L2 preserves complete content against incomplete captures', () => {
    const old = snapshot('complete', 2, 10);
    for (const status of ['partial', 'unknown'] as const) assert.equal(selectConversationDetail(old, snapshot(status, 10, 20)), old);
});
test('L2 replaces two incomplete snapshots in admission order, including shorter snapshots', () => {
    const old = snapshot('unknown', 10), next = snapshot('partial', 2);
    assert.equal(selectConversationDetail(old, next), next);
});
test('L2 preserves a known source version against older or unversioned replacements', () => {
    const old = snapshot('unknown', 2, 20), stale = snapshot('unknown', 10, 10);
    assert.equal(selectConversationDetail(old, stale), old);
    const unversioned = snapshot('unknown', 1);
    assert.equal(selectConversationDetail(old, unversioned), old);
    assert.equal(selectConversationDetail(unversioned, old), old);
    assert.equal(selectConversationDetail(undefined, stale), stale);
});
