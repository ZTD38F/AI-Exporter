import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_UUID } from './helpers/accountIds.js';
import { readAccount, readAccountParameters, readAccountRegistry } from '../src/l2/accountRegistry.js';
import { conversationKey, readConversationKey } from '../src/l2/conversationKey.js';
import { mergeConversationIndex, restoreConversationIndex } from '../src/l2/conversationIndex.js';
import { makeConversationIndex } from './helpers/conversationIndexFixture.js';

const key = { accountId: ACCOUNT_UUID, conversationId: 'p1-check' };

test('L2 key decoding validates unknown fields before creating a typed identity', () => {
    const raw = { ...key };
    assert.deepEqual(readConversationKey(raw), key);
    assert.deepEqual(raw, key, 'restoring a key must not mutate source input');
    assert.deepEqual(conversationKey(key.accountId, key.conversationId), key);

    const rejected: readonly unknown[] = [
        undefined, null, 0, '', [], {}, Object.create(null),
        { conversationId: key.conversationId },
        { accountId: key.accountId },
        { accountId: 12, conversationId: key.conversationId },
        { accountId: key.accountId, conversationId: 12 },
        { accountId: 'invalid-uuid', conversationId: key.conversationId },
        { ...key, conversationId: '' },
        { ...key, conversationId: ' surrounding ' },
        { ...key, extra: true },
    ];
    for (const value of rejected) {
        assert.throws(() => readConversationKey(value), /Invalid conversation key/);
    }
});

test('L2 index recovery narrows source metadata with exact optional field semantics', () => {
    const raw = { key, title: 'User title', titleSource: 'user', createdAt: 0, updatedAt: -2, activityAt: 8 };
    const before = structuredClone(raw);
    const index = restoreConversationIndex(raw);
    assert.deepEqual(index, raw);
    assert.deepEqual(raw, before);

    const empty = restoreConversationIndex({ key, title: undefined, titleSource: undefined,
        createdAt: undefined, updatedAt: undefined, activityAt: undefined });
    assert.deepEqual(empty, { key }, 'undefined optional fields remain absent in Domain');
    assert.equal(Object.hasOwn(empty, 'createdAt'), false);
    assert.equal(Object.hasOwn(empty, 'title'), false);

    const rejected: readonly unknown[] = [
        undefined, null, 42, [], {}, { key: 'not-a-key' },
        { key, unexpectedField: 1 },
        { key, title: 'Unpaired' },
        { key, titleSource: 'provider' },
        { key, title: '' , titleSource: 'provider' },
        { key, title: ' padded ', titleSource: 'provider' },
        { key, title: 42, titleSource: 'provider' },
        { key, title: 'Valid', titleSource: 'rpc' },
        { key, createdAt: null }, { key, createdAt: NaN },
        { key, updatedAt: 1.5 }, { key, updatedAt: Infinity },
        { key, activityAt: '8' }, { key, activityAt: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const value of rejected) assert.throws(() => restoreConversationIndex(value), TypeError);
});

test('L2 index merging derives coupled title fields and timestamps without non-null assertions', () => {
    const initial = makeConversationIndex({ key, title: 'Provider title', titleSource: 'provider',
        createdAt: 20, updatedAt: 100 });
    const newer = makeConversationIndex({ key, title: 'User title', titleSource: 'user',
        createdAt: 10, updatedAt: 80, activityAt: 120 });
    const result = mergeConversationIndex(initial, newer);
    assert.deepEqual(result, { key, title: 'User title', titleSource: 'user',
        createdAt: 10, updatedAt: 100, activityAt: 120 });

    const empty = mergeConversationIndex(restoreConversationIndex({ key }),
        restoreConversationIndex({ key, createdAt: 10 }));
    assert.deepEqual(empty, { key, createdAt: 10 }, 'absent titles never create undefined title provenance');
});

test('L2 account decoding checks raw object shape and required fields before constructing Account', () => {
    const verified = { id: ACCOUNT_UUID, providerId: 'gemini', providerAccountId: 'gaia-id',
        email: 'person@example.test', displayName: 'Person' };
    const before = structuredClone(verified);
    assert.deepEqual(readAccount(verified), verified);
    const { id: _accountId, ...parameters } = verified;
    assert.deepEqual(readAccountParameters(parameters), parameters);
    assert.deepEqual(verified, before);

    assert.deepEqual(readAccount({ ...verified, providerAccountId: 'default' }), {
        id: ACCOUNT_UUID, providerId: 'gemini', providerAccountId: 'default',
    }, 'default-account display information is not persisted');
    assert.deepEqual(readAccountRegistry([verified]), [verified]);

    const rejected: readonly unknown[] = [
        undefined, null, 42, false, '', [], {},
        { providerId: 'gemini', providerAccountId: 'id', extra: true },
        { providerId: 1, providerAccountId: 'id' },
        { providerId: 'gemini', providerAccountId: 1 },
        { providerId: ' gemini ', providerAccountId: 'id' },
        { providerId: 'gemini', providerAccountId: 'id', email: null },
        { providerId: 'gemini', providerAccountId: 'id', displayName: ' padded ' },
    ];
    for (const value of rejected) assert.throws(() => readAccountParameters(value), TypeError);
    assert.throws(() => readAccount({ ...verified, id: 'invalid-uuid' }), /Invalid local account UUID/);
    assert.throws(() => readAccountRegistry([verified, verified]), /Duplicate account identity/);
});
