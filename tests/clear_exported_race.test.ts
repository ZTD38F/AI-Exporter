import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBObjectStore } from 'fake-indexeddb';
import { useIndexStorage } from './helpers/indexStorage.js';
import { putAccount, putExportRecord, listExportRecords } from '../src/l3a/storageService.js';
import { clearLocalExportRecords } from '../src/application/localCleanup.js';
import { ConversationViewState } from '../src/ui/options/state/conversationsStore.js';
import { ingestIndexes } from '../src/l2/ingestion.js';
useIndexStorage({ seedAccounts: false });const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002';
const record={exportedAt:200,format:'markdown' as const,status:'ok' as const,chatTime:100};
async function seed(){await putAccount({id:A,providerId:'gemini',providerAccountId:'fixture'});for(const conversationId of ['a','b'])await putExportRecord({accountId:A,conversationId},record);}
test('P1-3: clearing records uses the current Application cleanup, and a refresh rereads committed records',async()=>{
    await seed();const view=new ConversationViewState();view.selectAccount(A);await view.refresh();assert.equal(Object.keys(view.records).length,2);await clearLocalExportRecords(A);await view.refresh();assert.deepEqual(view.records,{});assert.deepEqual(await listExportRecords(A),{});
});
test('real IndexedDB serialization preserves a new record admitted while the old record deletion is in flight',async()=>{
    await seed();const original=IDBObjectStore.prototype.delete;let pending:Promise<void>|undefined;
    IDBObjectStore.prototype.delete=function(key){const result=original.call(this,key);if(this.name==='exportRecords'&&!pending)pending=putExportRecord({accountId:A,conversationId:'new'},record);return result;};
    try{await clearLocalExportRecords(A);assert.ok(pending,'the race must run inside the physical delete path');await pending;assert.deepEqual(Object.keys(await listExportRecords(A)),['new']);}finally{IDBObjectStore.prototype.delete=original;}
});
test('clearing one UUID removes its records without touching another account',async()=>{
    await seed();await putExportRecord({accountId:B,conversationId:'a'},record);await clearLocalExportRecords(A);assert.deepEqual(await listExportRecords(A),{});assert.deepEqual(await listExportRecords(B),{a:record});
});
test('record cleanup keeps explicit selection; refreshing unexported records never auto-selects conversations',async()=>{
    await seed();await ingestIndexes(A,['a','b'].map(conversationId=>({conversationId,fields:{title:conversationId,titleSource:'provider' as const}})));const view=new ConversationViewState();view.selectAccount(A);await view.refresh();assert.equal(view.selected.size,0);
    await clearLocalExportRecords(A);await view.refresh();assert.equal(view.selected.size,0);view.selectVisible();assert.equal(view.selected.size,2);await view.refresh();assert.equal(view.selected.size,2);
});
