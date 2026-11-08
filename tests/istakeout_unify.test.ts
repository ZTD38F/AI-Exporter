import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { ingestIndexes } from '../src/l2/ingestion.js';
import { listIndexes, putAccount } from '../src/l3a/storageService.js';
import { ConversationViewState } from '../src/ui/options/state/conversationsStore.js';
useIndexStorage({ seedAccounts: false });
const accountId = '10000000-0000-4000-8000-000000000001';
async function seed() {
    await putAccount({id:accountId, providerId:'gemini', providerAccountId:'fixture'});
    for (const conversationId of ['mixed', 'takeout', 'active', 'stale']) await ingestIndexes(accountId, [{conversationId,fields:{title:conversationId,titleSource:conversationId === 'active' ? 'provider' : 'derived'}}]);
    await ingestIndexes(accountId,[{conversationId:'mixed',fields:{title:'Authoritative title',titleSource:'provider'}}]);
}
test('UI retains imported conversations after a provider title update and a list page omits them', async () => {
    await seed(); const view = new ConversationViewState(); view.selectAccount(accountId); await view.refresh();
    await ingestIndexes(accountId,[{conversationId:'active',fields:{title:'Online active',titleSource:'provider'}}]);
    await view.refresh();
    assert.deepEqual(new Set(view.indexes.map(x=>x.key.conversationId)),new Set(['mixed','takeout','active','stale']));
    assert.equal(view.indexes.find(x=>x.key.conversationId==='mixed')?.title,'Authoritative title');
    assert.equal(view.indexes.find(x=>x.key.conversationId==='takeout')?.titleSource,'derived');
});
test('persistent admission never treats absence from a provider page as verified deletion', async () => {
    await seed(); await ingestIndexes(accountId,[{conversationId:'active',fields:{title:'Online active',titleSource:'provider'}}]);
    assert.deepEqual(new Set((await listIndexes(accountId)).map(x=>x.key.conversationId)),new Set(['mixed','takeout','active','stale']));
});
test('Domain Index exposes title provenance without transient import flags', async () => {
    await seed(); for (const row of await listIndexes(accountId)) {
        assert.equal('hasTakeoutImport' in row,false); assert.equal('isTakeoutOnly' in row,false);
    }
});
