/**
 * L4 JSON tests stub L2's frozen v2 Account/key services at the module boundary.
 * L4's real JSON implementation runs, but L2's implementation is never loaded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v2Account, v2Conversation, V2_SECOND_ACCOUNT_ID } from './helpers/l4V2Fixtures.js';
import type { Account } from '../src/l2/accountRegistry.js';

const Module = require('node:module');
const previousLoad = Module._load;
let accountReads = 0, keyCompares = 0;
const accountPort: Pick<typeof import('../src/l2/accountRegistry.js'), 'readAccount'> = {
    readAccount(value: unknown) { accountReads++; return value as Account; },
};
const keyPort: Pick<typeof import('../src/l2/conversationKey.js'), 'sameConversationKey'> = {
    sameConversationKey(left, right) {
        keyCompares++;
        return left.accountId === right.accountId && left.conversationId === right.conversationId;
    },
};
let serializer!: typeof import('../src/l4/format/json/serializeDomainJson.js').serializeDomainJson;
try {
    Module._load = function(this: unknown, request: string, parent: unknown, isMain: boolean) {
        if (request.endsWith('/l2/accountRegistry.js')) return accountPort;
        if (request.endsWith('/l2/conversationKey.js')) return keyPort;
        return previousLoad.call(this, request, parent, isMain);
    };
    serializer = require('../src/l4/format/json/serializeDomainJson.js').serializeDomainJson;
} finally {
    Module._load = previousLoad;
}

test('L4 serializes frozen v2 Domain/Account and Packaging resource bindings unchanged', () => {
    const conversation = v2Conversation('Portable archive', [
        { id: 'image', kind: 'image', name: 'photo.png', mediaType: 'image/png' },
        { id: 'file', kind: 'file', name: 'report.txt', mediaType: 'text/plain' },
    ]);
    const account = v2Account();
    const bindings = { image: 'assets/photo.png', file: 'files/report.txt' };
    const before = structuredClone(conversation);
    const archive = JSON.parse(serializer(conversation, account, bindings));
    assert.deepEqual(Object.keys(archive), ['format', 'version', 'account', 'conversation', 'resources']);
    assert.equal(archive.format, 'gemini-exporter-domain');
    assert.equal(archive.version, 1);
    assert.deepEqual(archive.account, account);
    assert.deepEqual(archive.conversation, conversation);
    assert.deepEqual(archive.resources, bindings);
    assert.deepEqual(conversation, before);
    assert.ok(accountReads > 0 && keyCompares > 0, 'L4 called mocked L2 v2 services');
});
test('L4 JSON rejects account and Detail identity mismatch using the mocked v2 contracts', () => {
    const conversation = v2Conversation();
    assert.throws(() => serializer(conversation, v2Account('other', V2_SECOND_ACCOUNT_ID), {}), /mismatch/i);
    const mismatched = structuredClone(conversation);
    mismatched.detail.key.conversationId = 'different';
    assert.throws(() => serializer(mismatched, v2Account(), {}), /mismatch/i);
});
test('L4 JSON carries empty bindings and origin timestamps without L2 post-processing', () => {
    const conversation = v2Conversation();
    conversation.detail.savedAt = 0;
    conversation.index.updatedAt = 1000;
    const archive = JSON.parse(serializer(conversation, v2Account(), {}));
    assert.equal(archive.conversation.index.updatedAt, 1000);
    assert.equal(archive.conversation.detail.savedAt, 0);
    assert.deepEqual(archive.resources, {});
});
