import { organizationsGen } from './fixtures/providers/claudeOrganizations.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { observeClaudeAccount } from '../src/l1/client/claude/accountObservation.js';

test('Claude account observation validates organization JSON before caching typed data', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const foreign = '22222222-2222-4222-8222-222222222222';
    const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const savedFetch = globalThis.fetch;
    const savedNow = Date.now;
    let now = 1_700_000_000_000;
    let cookie = `lastActiveOrg=${id}`;
    let payload: unknown = organizationsGen('CL_ACCOUNT_MIXED_ROWS_01');
    let status = 200, calls = 0;
    try {
        Object.defineProperty(globalThis, 'document', { configurable: true, value: { get cookie() { return cookie; } } });
        Date.now = () => now;
        globalThis.fetch = async (url, init) => {
            assert.equal(url, '/api/organizations');
            assert.equal(init?.credentials, 'include');
            calls++;
            return new Response(JSON.stringify(payload), { status });
        };
        assert.deepEqual(await observeClaudeAccount(), {
            providerId: 'claude', providerAccountId: id, displayName: 'Team A',
        });
        payload = organizationsGen('CL_ACCOUNT_CACHED_CHANGE_01');
        assert.equal((await observeClaudeAccount())?.displayName, 'Team A');
        assert.equal(calls, 1, 'verified data is cached');

        cookie = `lastActiveOrg=${foreign}`;
        assert.equal(await observeClaudeAccount(), null, 'new cookie cannot reuse old account');
        cookie = `lastActiveOrg=${id}`;

        now += 30_001;
        payload = organizationsGen('CL_ACCOUNT_NUMBER_NAME_01');
        assert.deepEqual(await observeClaudeAccount(), { providerId: 'claude', providerAccountId: id });
        now += 30_001;
        payload = organizationsGen('CL_ACCOUNT_BLANK_NAME_01');
        assert.deepEqual(await observeClaudeAccount(), { providerId: 'claude', providerAccountId: id });

        now += 30_001;
        payload = organizationsGen('CL_ACCOUNT_INVALID_ENVELOPE_01');
        assert.equal(await observeClaudeAccount(), null, 'invalid responses do not create accounts');
        now += 30_001;
        payload = organizationsGen('CL_ACCOUNT_HTTP_FAILURE_01');
        status = 403;
        assert.equal(await observeClaudeAccount(), null, 'HTTP failure clears cached organizations');
        assert.equal(calls, 5);
    } finally {
        Date.now = savedNow;
        globalThis.fetch = savedFetch;
        if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
        else Reflect.deleteProperty(globalThis, 'document');
    }
});
