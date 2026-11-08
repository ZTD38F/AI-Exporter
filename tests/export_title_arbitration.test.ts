import test from 'node:test';
import assert from 'node:assert/strict';
import { indexFixture } from './helpers/indexFixture.js';
import { mergeConversationIndex } from '../src/l2/conversationIndex.js';

test('authoritative online title replaces Takeout title without erasing import history or mutating inputs', () => {
    const old = indexFixture({ id: 'chat', title: 'Imported title', titleSource: 'takeout', hasTakeoutImport: true });
    const incoming = indexFixture({ id: 'chat', title: 'Online rename', titleSource: 'rpc', hasTakeoutImport: false });
    const merged = mergeConversationIndex(old, incoming);
    assert.equal(merged.title, 'Online rename');
    assert.equal(merged.titleSource, 'provider');
    assert.equal(Reflect.get(merged ?? {}, 'hasTakeoutImport'), undefined);
    assert.equal(Object.hasOwn(merged, 'titles'), false);
    assert.equal(old.title, 'Imported title');
    assert.equal(Reflect.get(old ?? {}, 'hasTakeoutImport'), undefined);
    assert.equal(incoming.title, 'Online rename');
    assert.equal(Reflect.get(incoming ?? {}, 'hasTakeoutImport'), undefined);
});
