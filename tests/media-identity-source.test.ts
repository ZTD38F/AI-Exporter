import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaSources, mediaPrompt, mediaTime } from './helpers/mediaSourceFixture.js';
test('real RPC turns expose only source-authored event time/prompt and single-image position', () => {
    const { online, offline } = mediaSources();
    const onlineImage = online.conversation.detail.assets[0];
    const offlineImage = offline.conversation.detail.assets.find(a => a.generation?.prompt === mediaPrompt)!;
    assert.equal(onlineImage.generation?.time, mediaTime + 123);
    assert.equal(onlineImage.generation?.prompt, mediaPrompt);
    assert.equal(onlineImage.generation?.providerRequestId, 'r_request-9');
    assert.equal(onlineImage.generation?.imageCount, 1);
    assert.equal(onlineImage.generation?.imageOrdinal, 0);
    assert.notEqual(onlineImage.generation?.generationOrdinal, offlineImage.generation?.generationOrdinal);
    assert.notEqual(onlineImage.id, offlineImage.id);
    assert.notEqual(onlineImage.sourceUri, offlineImage.sourceUri);
    for (const options of [{ noTime: true }, { noPrompt: true }]) {
        const image = mediaSources(options).online.conversation.detail.assets[0];
        assert.equal(options.noTime ? image.generation?.time : image.generation?.prompt, undefined);
    }
    for (const image of mediaSources({ multi: true }).online.conversation.detail.assets) assert.equal(image.generation?.imageOrdinal, undefined, 'a traversal index is not a stable source ordinal');
});

