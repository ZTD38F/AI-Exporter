import { listFixture } from './helpers/listFixture.js';
import { indexFixture } from './helpers/indexFixture.js';
export {};

/**
 * tests/audit_reinforcement.test.ts
 *
 * Verification suite for architectural audit reinforcements:
 * 1. Two-Tier Storage atomic abort: IDB batch failure throws and blocks chrome.storage.local write.
 * 2. Takeout mediaIndex strict slot isolation: no global singleton clobber across account slots.
 * 3. Pagination getAllConversations token loop detection: circular nextPageToken triggers early safe termination.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// L2 admission rejects fat Index data before passive Storage receives a write decision.
test('L2 rejects fat metadata without changing stored indexes', async () => {
    const { indexStorage } = require('./helpers/indexStorage.js');
    const env = indexStorage();
    try {
        const { ingestIndexes } = require('../src/l2/ingestion.js');
        await assert.rejects(ingestIndexes('10000000-0000-4000-8000-000000000001', [{ conversationId: 'chat', fields: { title: 'Research', titleSource: 'provider', messages: [] } }]), /index schema/);
        assert.equal(env.writes(), 0);
    } finally { env.restore(); }
});

// V2 resources are task-scoped, keyed by Account UUID + conversation + asset.
test('task resource isolation prevents cross-account corruption and release preserves other accounts', async () => {
    const { createSourceResourceContext } = require('../src/l1/resources/sourceResources.js');
    const context = createSourceResourceContext();
    const first = { accountId: '10000000-0000-4000-8000-000000000001', conversationId: 'same_chat' };
    const second = { ...first, accountId: '10000000-0000-4000-8000-000000000002' };
    const asset = { id: 'same_asset', kind: 'image' };
    try {
        context.retain(first, asset.id, async () => ({ bytes: new Uint8Array([1]) }));
        context.retain(second, asset.id, async () => ({ bytes: new Uint8Array([2]) }));
        assert.deepStrictEqual((await context.acquire(first, asset)).bytes, new Uint8Array([1]));
        assert.deepStrictEqual((await context.acquire(second, asset)).bytes, new Uint8Array([2]));
        await assert.rejects(context.acquire({ ...first, conversationId: 'other_chat' }, asset), /locator/);
        context.releaseConversation(second);
        await assert.rejects(context.acquire(second, asset), /locator/);
        assert.deepStrictEqual((await context.acquire(first, asset)).bytes, new Uint8Array([1]));
    } finally { context.release(); }
    await assert.rejects(context.acquire(first, asset), /released/);
});

test('Gemini pagination detects token loops, retains committed rows and never certifies complete coverage', async () => {
    const { indexStorage } = require('./helpers/indexStorage.js');
    const { ACCOUNT_UUID } = require('./helpers/accountRuntime.js');
    const { sourceDetail, sourceList } = require('./helpers/l1SourceFixture.js');
    const { GeminiProvider } = require('../src/l1/client/gemini/geminiProvider.js');
    const { listIndexes, getCoverage } = require('../src/l3a/storageService.js');
    const env = indexStorage();
    let calls = 0;
    const provider = new GeminiProvider({
        getConversationList: async () => sourceList(`G_SOURCE_AUDIT_LOOP_PAGE_${++calls}`),
        getConversationDetail: async () => sourceDetail(),
    }, async () => 'u0');
    try {
        await assert.rejects(provider.listConversations({ accountId: ACCOUNT_UUID, streamId: 'recent' }), /loop/i);
        assert.equal(calls, 2);
        assert.equal((await listIndexes(ACCOUNT_UUID)).length, 2);
        assert.equal((await getCoverage(ACCOUNT_UUID, 'recent'))?.range ?? null, null);
    } finally { env.restore(); }
});
