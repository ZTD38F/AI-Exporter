import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { A, key } from './helpers/v2ConversationFixture.js';
import { putExportRecord, listExportRecords } from '../src/l3a/storageService.js';
useIndexStorage();
test('concurrent export writes preserve both records', async () => {
    const first = { status: 'ok' as const, format: 'markdown' as const, exportedAt: 1 };
    const second = { status: 'partial' as const, format: 'html' as const, exportedAt: 2 };
    await Promise.all([putExportRecord(key('first'), first), putExportRecord(key('second'), second)]);
    assert.deepEqual(await listExportRecords(A), { first, second });
});
