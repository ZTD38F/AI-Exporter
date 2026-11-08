import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { listExportRecords, putIndexes } from '../src/l3a/storageService.js';
import { ensureUpgraded } from '../src/migration/upgradeV1.js';
import { ConversationViewState } from '../src/ui/options/state/conversationsStore.js';
const accountId='10000000-0000-4000-8000-000000000001';
const rec=(exportedAt:number)=>({exportedAt,status:'ok' as const,format:'markdown' as const});
const account={id:accountId,providerId:'gemini',providerAccountId:'10000000001'};
async function seedLegacyAccount(){
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('gemini_exporter_domain',1);request.onupgradeneeded=()=>request.result.createObjectStore('accounts',{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('accounts','readwrite');tx.objectStore('accounts').put(account);tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}

test('legacy record aliases normalize once through migration; current reads remain canonical',async()=>{
    const env=indexStorage({[`exported_${accountId}`]:{xyz789:rec(200),c_xyz789:rec(100)}});try{await seedLegacyAccount();await ensureUpgraded();const writes=env.writes();assert.deepEqual(await listExportRecords(accountId),{xyz789:rec(200)});assert.deepEqual(await listExportRecords(accountId),{xyz789:rec(200)});assert.equal(env.writes(),writes);}finally{env.restore();}
});
test('alias-only historical records have no implicit fallback before upgrade and become readable after the one-time owner runs',async()=>{
    const env=indexStorage({[`exported_${accountId}`]:{c_abc123:rec(300)}});try{await seedLegacyAccount();assert.deepEqual(await listExportRecords(accountId),{});await ensureUpgraded();assert.deepEqual(await listExportRecords(accountId),{abc123:rec(300)});}finally{env.restore();}
});
test('ConversationViewState reads only canonical records without another in-memory alias-normalization policy',async()=>{
    const env=indexStorage({[`exported_${accountId}`]:{c_abc123:rec(300)}});try{await seedLegacyAccount();await ensureUpgraded();await putIndexes([{key:{accountId,conversationId:'abc123'},title:'Canonical',titleSource:'provider'}]);const view=new ConversationViewState();view.selectAccount(accountId);await view.refresh();assert.deepEqual(Object.keys(view.records),['abc123']);assert.equal(view.records.c_abc123,undefined);view.filter='has_record';assert.deepEqual(view.visible().map(x=>x.key.conversationId),['abc123']);}finally{env.restore();}
});
