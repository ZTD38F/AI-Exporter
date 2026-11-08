import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { putAccount, getAccount, listAccounts, listIndexes } from '../src/l3a/storageService.js';
import { ingestIndexes } from '../src/l2/ingestion.js';
import { handleTakeoutImport } from '../src/ui/options/controllers/takeoutController.js';
import { updateSettings } from '../src/application/settings/index.js';
import { ConversationViewState } from '../src/ui/options/state/conversationsStore.js';
useIndexStorage({ seedAccounts: false });
const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002';
async function accounts(){for(const id of [A,B])await putAccount({id,providerId:'gemini',providerAccountId:id});}
const never=async()=>{throw Error('Unexpected account creation');};
test('Takeout imports through ingestion once; UI rereads canonical metadata including concurrent commits and provider title authority',async()=>{
    await accounts();await ingestIndexes(A,[{conversationId:'online',fields:{title:'Provider title',titleSource:'provider'}}]);const view=new ConversationViewState();let imports=0;
    const result=await handleTakeoutImport(new File(['fixture'],'Takeout.zip'),A,{onTarget:async id=>{view.selectAccount(id);}},{getAccount,listAccounts,getOrCreateAccount:never,updateSettings,importTakeout:async(_file,id)=>{
        imports++;await Promise.all(['online','imported','concurrent'].map(conversationId=>ingestIndexes(id,[{conversationId,fields:{title:`Imported ${conversationId}`,titleSource:'derived'}}])));return{imported:1,status:'ok' as const};
    }});await view.refresh();assert.equal(imports,1);assert.equal(result.imported,1);assert.deepEqual(view.indexes.map(x=>x.key.conversationId).sort(),['concurrent','imported','online']);assert.equal(view.indexes.find(x=>x.key.conversationId==='online')?.title,'Provider title');assert.deepEqual(view.indexes,await listIndexes(A));
});
test('an import remains scoped to its captured target even when the view switches accounts',async()=>{
    await accounts();const view=new ConversationViewState();view.selectAccount(A);
    await handleTakeoutImport(new File(['fixture'],'Takeout.zip'),A,{onTarget:async id=>{assert.equal(id,A);}},{getAccount,listAccounts,getOrCreateAccount:never,updateSettings,importTakeout:async(_f,id)=>{
        view.selectAccount(B);await view.refresh();assert.equal(id,A);await ingestIndexes(id,[{conversationId:'imported',fields:{title:'Imported',titleSource:'derived'}}]);return{imported:1,status:'ok' as const};
    }});assert.equal(view.accountId,B);assert.deepEqual(view.indexes,[]);assert.equal((await listIndexes(A)).length,1);assert.deepEqual(await listIndexes(B),[]);
});
for(const initial of [null,B])test(`without any accounts Takeout selects Gemini default from ${initial??'empty selection'}`,async()=>{
    const fallback={id:'10000000-0000-4000-8000-000000000003',providerId:'gemini',providerAccountId:'default'};let selected=initial,importedInto='';
    await handleTakeoutImport(new File(['fixture'],'Takeout.zip'),initial,{onTarget:async id=>{selected=id;}},{listAccounts:async()=>[],getAccount:never,getOrCreateAccount:async(providerId,identity)=>{assert.equal(providerId,'gemini');assert.equal(identity,'default');return fallback;},updateSettings,importTakeout:async(_f,id)=>{importedInto=id;return{imported:0,status:'ok' as const};}});
    assert.equal(selected,fallback.id);assert.equal(importedInto,fallback.id);
});
