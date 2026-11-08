import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalFixture, rpcFixture } from './helpers/nativeFixture.js';
import { mergeConversationPages } from '../src/l1/parsers/gemini/rpc/mergePages.js';

test('parser closes heuristic document identities and rejects malformed messages before Domain', () => {
    const parsed = historicalFixture({ id: 'quality', messages: [null as never,
        { role: 'model', content: 'Body', attachments: [{ type: 'doc', id: 'source-doc', contentMarkdown: 'Report', hasFabricatedText: true }] }] });
    assert.deepEqual(parsed.conversation.detail.quality, { status: 'partial' });
    assert.deepEqual(parsed.evidence, { rejectedTurns: 1, heuristicDocumentIds: [parsed.conversation.detail.assets[0].id] });
    assert.equal('hasFabricatedText' in parsed.conversation.detail.assets[0].document!, false);
    assert.equal(parsed.conversation.detail.quality.status, 'partial', 'L2 quality is independent of delivery records');
});

test('finished pagination clears pending coverage and remaps heuristic references on asset collisions', () => {
    const page = (body: string) => rpcFixture({ id: 'pages', messages: [{ id: body, role: 'model', content: body,
        attachments: [{ type: 'doc', id: 'report', contentMarkdown: body, hasFabricatedText: true }] }] });
    const first = page('new'), second = page('old');
    assert.equal(first.conversation.detail.assets[0].id, second.conversation.detail.assets[0].id);
    const merged = mergeConversationPages([first, second]);
    assert.deepEqual(merged.evidence?.heuristicDocumentIds, merged.conversation.detail.assets.map(a => a.id));
    assert.equal(merged.conversation.detail.quality.status, 'partial');
    const cleanFirst = rpcFixture({ id: 'pages', messages: [{ role: 'user', content: 'New' }] }, { nextPageToken: 'cursor' });
    const cleanLast = rpcFixture({ id: 'pages', messages: [{ role: 'user', content: 'Old' }] });
    assert.deepEqual(cleanFirst.conversation.detail.quality, { status: 'partial' });
    assert.deepEqual(mergeConversationPages([cleanFirst, cleanLast]).conversation.detail.quality, { status: 'unknown' });
    const stopped = mergeConversationPages([cleanFirst], 'token_loop');
    assert.deepEqual(stopped.conversation.detail.quality, { status: 'partial' });
    assert.equal(stopped.evidence?.truncation, 'token_loop');
    assert.deepEqual(mergeConversationPages([stopped, cleanLast]).conversation.detail.quality,
        { status: 'partial' }, 'only pending pagination may be cleared');
});

