// Cross-module Application/L2/L3a checks: no removed v1 session adapter or StorageService class.
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { fixtureKey } from './helpers/domainFixture.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import * as storage from '../src/l3a/storageService.js';
import { clearLocalExportRecords } from '../src/application/localCleanup.js';
import { shouldSkipExport } from '../src/application/export/runExport.js';
import type { ExportRecord, ExportRequest } from '../src/application/export/types.js';

const record: ExportRecord = { exportedAt: 300, chatTime: 100, format: 'markdown', status: 'ok' };
const request = (key: ReturnType<typeof fixtureKey>): ExportRequest => ({
    keys: [key], format: 'markdown', delivery: 'browserDownload',
    includeAssets: true, skipUnchanged: true,
});

test('v2 export record write failure does not fabricate an acknowledged delivery', async () => {
    const env = indexStorage();
    try {
        const key = fixtureKey('write_failure');
        env.fail('exportRecords');
        await assert.rejects(storage.putExportRecord(key, record), /write failed/);
        env.fail();
        assert.equal(await storage.getExportRecord(key), null);
        await storage.putExportRecord(key, record);
        assert.deepEqual(await storage.getExportRecord(key), record);
    } finally {
        env.restore();
    }
});

test('v2 export record persistence and cleanup never replace or delete L2 conversation facts', async () => {
    const env = indexStorage();
    try {
        const key = fixtureKey('stable-record');
        await ingestDetail(key.accountId, key.conversationId, {
            savedAt: 100, quality: { status: 'complete' }, assets: [],
            messages: [{ role: 'user', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Keep this body' }] }] }],
        }, { title: 'Retained conversation', titleSource: 'provider', updatedAt: 100 });
        const originalIndex = await storage.getIndex(key);
        const originalDetail = await storage.getDetail(key);
        await storage.putExportRecord(key, record);
        assert.equal(shouldSkipExport(await storage.getExportRecord(key), originalIndex?.updatedAt, request(key)), true);
        await clearLocalExportRecords(key.accountId);
        assert.equal(await storage.getExportRecord(key), null);
        assert.deepEqual(await storage.getIndex(key), originalIndex);
        assert.deepEqual(await storage.getDetail(key), originalDetail);
    } finally {
        env.restore();
    }
});
