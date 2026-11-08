import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { getOrCreateAccount } from '../src/l2/accountAdmission.js';
import { findAccount, readAccount, readAccountRegistry, readAccountParameters } from '../src/l2/accountRegistry.js';
import { getAccount, listAccounts, putAccount } from '../src/l3a/storageService.js';

test('L2 AccountRegistry stores one UUID per provider identity, including concurrent discovery', async () => {
    const env = indexStorage({}, { seedAccounts: false });
    try {
        const identities = await Promise.all(Array.from({ length: 8 },
            () => getOrCreateAccount('gemini', 'source-account')));
        assert.equal(new Set(identities.map(account => account.id)).size, 1);
        const persisted = await getAccount(identities[0].id);
        assert.deepEqual(persisted, identities[0]);
        assert.deepEqual(await listAccounts(), [persisted]);
    } finally { env.restore(); }
});

test('L2 AccountRegistry isolates providers and remote identities, not emails', async () => {
    const env = indexStorage({}, { seedAccounts: false });
    try {
        const a = await getOrCreateAccount('gemini', 'first', 'shared@example.com');
        const b = await getOrCreateAccount('gemini', 'second', 'shared@example.com');
        const c = await getOrCreateAccount('chatgpt', 'first', 'shared@example.com');
        assert.equal(new Set([a.id, b.id, c.id]).size, 3);
        assert.equal((await getOrCreateAccount('gemini', 'first')).id, a.id);
        assert.deepEqual((await listAccounts()).map(account => account.id).sort(), [a.id, b.id, c.id].sort());
    } finally { env.restore(); }
});

test('L2 AccountRegistry updates display fields without changing identity or erasing missing fields', async () => {
    const env = indexStorage({}, { seedAccounts: false });
    try {
        const initial = await getOrCreateAccount('gemini', 'first', 'old@example.com', 'Original');
        const updated = await getOrCreateAccount('gemini', 'first', 'new@example.com');
        assert.equal(updated.id, initial.id);
        assert.equal(updated.email, 'new@example.com');
        assert.equal(updated.displayName, 'Original');
        assert.deepEqual(await getAccount(initial.id), updated);
        const unchanged = await getOrCreateAccount('gemini', 'first');
        assert.deepEqual(unchanged, updated);
        assert.deepEqual(await getAccount(initial.id), updated);
    } finally { env.restore(); }
});

test('L2 promotes the sole default to verified identity in place without losing its UUID', async () => {
    const env = indexStorage({}, { seedAccounts: false });
    try {
        const fallback = await getOrCreateAccount('gemini', 'default', 'borrowed@example.com', 'Unknown');
        assert.equal(fallback.providerAccountId, 'default');
        assert.equal(Object.hasOwn(fallback, 'email'), false);
        assert.equal(Object.hasOwn(fallback, 'displayName'), false);
        const verified = await getOrCreateAccount('gemini', 'verified', 'verified@example.com');
        assert.equal(verified.id, fallback.id);
        assert.equal(verified.providerAccountId, 'verified');
        assert.equal(verified.email, 'verified@example.com');
        assert.deepEqual(await getAccount(fallback.id), verified);
        assert.deepEqual(await getOrCreateAccount('gemini', 'default', 'other@example.com'), verified);
        const otherProvider = await getOrCreateAccount('chatgpt', 'default');
        assert.notEqual(otherProvider.id, verified.id);
        assert.equal((await listAccounts()).length, 2);
    } finally { env.restore(); }
});

test('L2 keeps distinct verified identities and routes unknown data to a stable real account', async () => {
    const env = indexStorage({}, { seedAccounts: false });
    try {
        const b = await getOrCreateAccount('gemini', 'gaia-b');
        const a = await getOrCreateAccount('gemini', 'gaia-a');
        assert.notEqual(a.id, b.id);
        const expected = [a, b].sort((x, y) => x.id.localeCompare(y.id))[0];
        const unknown = await Promise.all(Array.from({ length: 12 }, () => getOrCreateAccount('gemini', 'default')));
        assert.ok(unknown.every(account => account.id === expected.id));
        assert.equal((await listAccounts()).length, 2);
        assert.equal((await getOrCreateAccount('gemini', 'gaia-b')).id, b.id);
    } finally { env.restore(); }
});

test('L2 serializes concurrent default and real admissions without duplicate placeholders', async () => {
    const env = indexStorage({}, { seedAccounts: false });
    try {
        await Promise.all([
            getOrCreateAccount('gemini', 'default'),
            getOrCreateAccount('gemini', 'verified'),
            getOrCreateAccount('gemini', 'default'),
            getOrCreateAccount('gemini', 'verified'),
        ]);
        const saved = (await listAccounts()).filter(account => account.providerId === 'gemini');
        assert.equal(saved.length, 1);
        assert.equal(saved[0].providerAccountId, 'verified');
    } finally { env.restore(); }
});

test('L2 identity cannot be rewritten for a saved UUID; migration upsert can retain a new UUID', async () => {
    const env = indexStorage({}, { seedAccounts: false });
    try {
        const saved = await getOrCreateAccount('gemini', 'original');
        await assert.rejects(putAccount({ ...saved, providerAccountId: 'changed' }), /identity/i);
        await assert.rejects(putAccount({ ...saved, providerId: 'chatgpt' }), /identity/i);
        assert.deepEqual(await getAccount(saved.id), saved);
        const migrated = { id: '10000000-0000-4000-8000-000000000088',
            providerId: 'gemini', providerAccountId: 'migration' };
        await putAccount(migrated);
        assert.deepEqual(await getAccount(migrated.id), migrated);
    } finally { env.restore(); }
});

test('L2 Account validation rejects invalid identities and preserves existing records after failed writes', async () => {
    const env = indexStorage({}, { seedAccounts: false });
    try {
        const saved = await getOrCreateAccount('gemini', 'first');
        for (const invalid of [
            { providerId: '', providerAccountId: 'id' },
            { providerId: 'gemini', providerAccountId: '' },
            { providerId: ' gemini ', providerAccountId: 'id' },
            { providerId: 'gemini', providerAccountId: 'id', email: null },
        ]) assert.throws(() => readAccountParameters(invalid), TypeError);
        assert.throws(() => readAccount({ ...saved, id: 'not-a-uuid' }), TypeError);
        assert.throws(() => readAccountRegistry([saved, saved]), /Duplicate/);
        assert.equal(findAccount([saved], 'gemini', 'other'), null);
        env.fail('accounts');
        await assert.rejects(getOrCreateAccount('gemini', 'first', 'new@example.com'), /write failed/);
        env.fail();
        assert.deepEqual(await getAccount(saved.id), saved);
        assert.equal((await getOrCreateAccount('gemini', 'first', 'new@example.com')).email, 'new@example.com');
    } finally { env.restore(); }
});
