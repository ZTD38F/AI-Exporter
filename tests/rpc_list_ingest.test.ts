import { geminiListPage, GEMINI_LIST_CAPTURE } from './fixtures/providers/geminiListCapture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { accountRuntime, ACCOUNT_UUID, ACCOUNT_OBSERVATION } from './helpers/accountRuntime.js';
import { ingestIndexes, ingestDeletedConversation } from '../src/l2/ingestion.js';
import { listIndexes, getIndex } from '../src/l3a/storageService.js';
import { init, handleWindowMessage } from '../src/l1/sniffer/gemini/messageBridge.js';
import { parseList } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { parseGeminiIndexObservation } from '../src/l1/parsers/gemini/parseIndexObservation.js';
const text = geminiListPage().responseBody;
const items = () => parseList(text).conversations.map(item => parseGeminiIndexObservation(item,'rpc-list'));
const capture = (): MessageEvent => ({origin:location.origin,source:window,data:{type:'GEMINI_NETWORK_BATCHEXECUTE',payload:{
    text,slot:'u2',requestAccountObservation:ACCOUNT_OBSERVATION,truncated:false,requestedAt:1,
    url:'https://gemini.google.com/_/BardChatUi/data/batchexecute',listRequest:{streamId:'recent',requestCursor:null}
}}}) as unknown as MessageEvent;

test('RPC bridge and active L2 admission persist identical current Index facts',async()=>{
    const env=indexStorage(),runtime=accountRuntime('u2');
    try {
        init(); await handleWindowMessage(capture());
        const passive=await listIndexes(ACCOUNT_UUID);
        assert.equal(passive.length,GEMINI_LIST_CAPTURE.firstPageRows);
        assert.equal(passive[0].title,GEMINI_LIST_CAPTURE.first.title); assert.equal(passive[0].updatedAt,GEMINI_LIST_CAPTURE.first.updatedAt);
        assert.equal(passive[0].titleSource,'provider');
        await ingestIndexes(ACCOUNT_UUID,items());
        assert.deepEqual(await listIndexes(ACCOUNT_UUID),passive);
        assert.deepEqual(Object.keys(passive[0]).sort(),['key','title','titleSource','updatedAt']);
    } finally {runtime.restore();env.restore();}
});
test('confirmed deletion leaves no tombstone; fresh source observation may recreate the Index',async()=>{
    const env=indexStorage();
    try {
        await ingestIndexes(ACCOUNT_UUID,items()); await ingestDeletedConversation(ACCOUNT_UUID,GEMINI_LIST_CAPTURE.first.id);
        assert.equal(await getIndex({accountId:ACCOUNT_UUID,conversationId:GEMINI_LIST_CAPTURE.first.id}),null);
        await ingestIndexes(ACCOUNT_UUID,items());
        assert.equal((await listIndexes(ACCOUNT_UUID))[0].title,GEMINI_LIST_CAPTURE.first.title);
        assert.deepEqual(env.local,{});
    } finally {env.restore();}
});
test('active and passive admissions propagate failed commits and retry through the same L2 owner',async()=>{
    const env=indexStorage(),runtime=accountRuntime('u2');
    try {
        init();env.fail('indexes');
        await assert.rejects(ingestIndexes(ACCOUNT_UUID,items()),/write failed/);
        await assert.rejects(handleWindowMessage(capture()),/write failed/);
        assert.deepEqual(await listIndexes(ACCOUNT_UUID),[]);
        env.fail();await handleWindowMessage(capture());
        assert.equal((await listIndexes(ACCOUNT_UUID)).length,GEMINI_LIST_CAPTURE.firstPageRows);
    } finally {runtime.restore();env.restore();}
});
test('duplicate and unchanged Index admissions use the atomic merge without retired receipts',async()=>{
    const env=indexStorage();
    try {
        assert.deepEqual(await ingestIndexes(ACCOUNT_UUID,[...items(),...items()]),
            {added:GEMINI_LIST_CAPTURE.firstPageRows,updated:0});
        const writes=env.writes();
        assert.deepEqual(await ingestIndexes(ACCOUNT_UUID,items()),{added:0,updated:0});
        assert.equal(env.writes(),writes);assert.equal((await listIndexes(ACCOUNT_UUID)).length,GEMINI_LIST_CAPTURE.firstPageRows);
    } finally {env.restore();}
});
