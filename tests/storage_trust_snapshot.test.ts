import test from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../src/l3a/storageService.js';
import { useStorageUnitEnvironment } from './helpers/l3aStorageUnitEnvironment.js';
import { fixtureKey } from './helpers/domainFixture.js';
import type { ConversationIndex } from '../src/l2/conversationIndex.js';
import type { ConversationDetail } from '../src/l2/conversationDetail.js';

useStorageUnitEnvironment();

test('Storage persists detached v2 Index and Detail facts without transforming their content', async () => {
    const key = fixtureKey('copy');
    // L2's v2 schemas are type-only contracts. No L2 validator or admission code runs here.
    const index = { key, title: 'Original', titleSource: 'provider' } satisfies ConversationIndex;
    const detail = {
        key, quality: { status: 'complete' },
        messages: [{ role: 'user', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Body' }] }] }],
        assets: [{ id: 'asset', kind: 'file', sourceUri: 'opaque:original' }],
    } satisfies ConversationDetail;
    await storage.updateConversationAtomically(key, () => ({ index, detail, result: undefined }));

    index.title = 'Changed';
    detail.assets[0].sourceUri = 'changed';
    const read = await storage.getDetail(key);
    assert.ok(read);
    assert.equal((await storage.getIndex(key))?.title, 'Original');
    assert.equal(read.assets[0].sourceUri, 'opaque:original');
    read.assets.length = 0;
    assert.equal((await storage.getDetail(key))?.assets.length, 1);
});
