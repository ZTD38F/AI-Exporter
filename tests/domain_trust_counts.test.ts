import { admitFixture } from './helpers/admitFixture.js';
import { fixtureKey, fixtureAccount } from './helpers/domainFixture.js';
import { useIndexStorage } from './helpers/indexStorage.js';
useIndexStorage();
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateParserDomain, restoreDomainSnapshot } from '../src/l2/runtimeValidation.js';
import { storageIdentity } from './helpers/admitFixture.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { readFixture } from './helpers/admitFixture.js';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';

test('large provider-neutral graphs preserve complete/partial/unknown coverage and real resource bytes', async () => {
    for (const status of ['complete', 'partial', 'unknown'] as const) {
        const builder: DomainConversationWithDetail = { index: { key: fixtureKey(String(`large-${status}`), 'future-provider'),   titleSource: "derived",   title: 'Independent large graph' }, detail: { key: fixtureKey(String(`large-${status}`), 'future-provider'), quality: { status }, assets: [{ id: 'bytes', kind: 'file', sourceUri: 'opaque:original' }], messages: Array.from({ length: 1000 }, (_, index) => ({ id: `message-${index}`, role: 'unknown',
                content: [{ type: 'unknown', sourceType: 'future-block', text: `Preserved ${index}` }], attachmentIds: ['bytes'] })) } };
        const trusted = validateParserDomain(builder);
        assert.equal(restoreDomainSnapshot(trusted).detail.messages.length, 1000);

        const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
        const resources = createSourceResourceContext();
        const retained = bytes.slice();
        resources.retain(builder.index.key, 'bytes', async () => ({ bytes: retained.slice() }));
        await admitFixture(fixtureAccount('future-provider').id, { account: fixtureAccount('future-provider'), conversation: trusted, resourceHints: {}, acquisitionHints: {}, diagnostics: [] });
        bytes[0] = 99;
        const read = await readFixture(storageIdentity('future-provider', fixtureAccount('future-provider').id, builder.index.key.conversationId));
        assert.ok(read); const recoveredBytes = (await resources.acquire(read.conversation.index.key, read.conversation.detail.assets[0])).bytes;
        assert.ok(recoveredBytes); assert.deepEqual([...recoveredBytes], [0, 1, 2, 253, 254, 255]);
        assert.equal(read.conversation.detail.quality.status, status);
        assert.equal(read.conversation.detail.messages[999].content[0].type, 'unknown');
        assert.equal(Object.getOwnPropertySymbols(read.conversation).length, 0);
        resources.release();
        await assert.rejects(resources.acquire(read.conversation.index.key, read.conversation.detail.assets[0]), /released/);
        assert.ok(!JSON.stringify(read.conversation).includes('dataBase64'));
    }
});

