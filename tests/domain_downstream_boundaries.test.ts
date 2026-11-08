import { fixtureKey } from './helpers/domainFixture.js';
import { useIndexStorage } from './helpers/indexStorage.js';
useIndexStorage();
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { putExportRecord } from '../src/l3a/storageService.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { readConversation } from '../src/l2/readConversation.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { contentComposer } from '../src/l3b/compose/composeContent.js';
import { makeConversationIndex } from './helpers/conversationIndexFixture.js';

const index = makeConversationIndex({ key: fixtureKey('review123'), title: 'Review fixture', titleSource: 'provider', updatedAt: 1700000000000 });

test('malformed delivery history cannot contaminate the independently validated Domain snapshot', async () => {
    await ingestDetail(index.key.accountId, index.key.conversationId, { quality: { status: 'complete' }, assets: [], messages: [] },
        { title: index.title, titleSource: index.titleSource, updatedAt: index.updatedAt });
    const original = await readConversation(index.key);
    for (const record of [null, [], 1, { chatTime: { toString: null } }, { messageCount: 'many' }, { status: {} }, { hasFailedAssets: 'yes' }, { chatTime: Infinity }]) {
        await putExportRecord(index.key, record as never);
        assert.deepEqual(await readConversation(index.key), original);
    }
});

test('validated tables compose across header rowspans without changing Domain data', () => {
    const input = validateParserDomain({ index, detail: { key: index.key, quality: { status: 'complete' }, assets: [], messages: [{ role: 'assistant', content: [{ type: 'table', headerRows: [{ cells: [{ children: [], rowSpan: 2 }] }], rows: [{ cells: [{ children: [], colSpan: 2 }] }, { cells: [] }] }] }] } });
    const original = JSON.stringify(input);
    const blocks = contentComposer(new Map(), id => ({ id, label: id }))(input.detail.messages[0].content);
    assert.equal(JSON.stringify(input), original);
    const table = blocks[0];
    assert.equal(table.type, 'table');
    if (table.type !== 'table') throw new Error('Expected table');
    assert.deepEqual(table.columnAlignments, ['default', 'default', 'default']);
    assert.equal(table.rows[0][0].column, 1);
    assert.equal(table.rows[0][0].colSpan, 2);
    assert.deepEqual(table.rows[1], []);
});
