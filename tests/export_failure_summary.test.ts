import test from 'node:test';
import assert from 'node:assert/strict';
import { ExportIssueCollector } from '../src/ui/options/state/exportIssues.js';
import { copyExportFailures, failureGroupLabel } from '../src/ui/options/views/exportFailures.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { exportSummary } from '../src/ui/shared/exportSummary.js';
import type { OperationIssue } from '../src/shared/errors/operationError.js';

const accountId = fixtureAccount('gemini').id;
const key = (conversationId: string) => ({ accountId, conversationId });

test('429 termination names the cooldown and manual retry instead of ordinary cancellation', () => {
    const summary = exportSummary({ exported: 2, skipped: 0, partial: 0, failed: [], aborted: true,
        rateLimitedUntil: Date.now() + 3600000 });
    assert.match(summary, /429.*export stopped.*cooling down.*Retry manually/);
    assert.equal(summary.split('\n')[0], 'Successfully downloaded: 2');
    assert.equal(summary.split('\n').length, 2);
    assert.doesNotMatch(summary, /Skipped:|Conversation export failed:/);
    assert.doesNotMatch(summary, /Cancelled/);
});

test('100 HTTP failures with different IDs and messages aggregate by actual cause and status', () => {
    const collector = new ExportIssueCollector();
    for (let i = 0; i < 100; i++) collector.add({ key: key(String(i)), stage: 'export', code: 'EXPORT_FAILED',
        severity: 'error', message: `HTTP 403 conversation ${i}`, issue: { code: 'SOURCE_HTTP_ERROR', httpStatus: 403, message: `HTTP 403 conversation ${i}` } });
    const groups = collector.groups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].conversations.length, 100);
    assert.equal(groups[0].occurrences, 100);
    assert.match(failureGroupLabel(groups[0]), /Platform access restricted.*403/);
    const copied = copyExportFailures(groups);
    assert.equal(copied.split('HTTP 403 conversation 0').length - 1, 1);
    assert.match(copied, new RegExp(`${accountId}/99`));
});

test('different HTTP statuses remain separate, without guessing from message text', () => {
    const collector = new ExportIssueCollector();
    for (const status of [401, 403, 404, 429, 500]) collector.add({ key: key(String(status)), stage: 'source_refresh',
        code: 'SOURCE_REFRESH_FAILED', severity: 'warning', message: 'request failed',
        issue: { code: 'SOURCE_HTTP_ERROR', message: 'request failed', httpStatus: status } });
    collector.add({ key: key('unknown'), stage: 'export', code: 'EXPORT_FAILED', message: 'HTTP 429 login expired CORS offline disk full' });
    assert.equal(collector.groups().length, 6);
    assert.equal(collector.groups()[5].category, 'UNKNOWN_ERROR');
    assert.equal(collector.groups()[5].httpStatus, undefined);
    assert.match(failureGroupLabel(collector.groups()[5]), /Unknown error/);
});

test('partial export warnings count occurrences and distinct account-scoped conversations', () => {
    const collector = new ExportIssueCollector();
    for (let i = 0; i < 2; i++) collector.add({ key: key('a'), stage: 'resource', code: 'RESOURCE_PROCESSING_FAILED', severity: 'warning', message: `asset ${i}` });
    collector.add({ key: { ...key('a'), accountId: fixtureAccount('claude').id }, stage: 'resource', code: 'RESOURCE_PROCESSING_FAILED', severity: 'warning', message: 'asset 3' });
    assert.equal(collector.groups().length, 1);
    assert.equal(collector.groups()[0].conversations.length, 2);
    assert.equal(collector.groups()[0].occurrences, 3);
    assert.equal(collector.groups()[0].severity, 'warning');
    assert.equal(JSON.parse(JSON.stringify(collector))[0].occurrences, 3);
});

test('cancellation, confirmed empty source and ordinary informational diagnostics do not become errors', () => {
    const collector = new ExportIssueCollector();
    for (const code of ['EXPORT_CANCELLED', 'SOURCE_CONVERSATION_EMPTY']) collector.add({ stage: 'run', code, message: code });
    collector.add({ stage: 'pdf', code: 'TYPST_LOCAL_FONTS_RESOLVED', severity: 'info', message: 'resolved' });
    assert.deepEqual(collector.groups(), []);
});

test('attachment locator 404 is a source-unavailable warning in diagnostics and the final summary', () => {
    const issue: OperationIssue = { code: 'RESOURCE_LOCATOR_UNAVAILABLE', httpStatus: 404, message: 'HTTP 404' };
    const collector = new ExportIssueCollector();
    collector.add({ key: key('missing'), stage: 'resource', code: issue.code, severity: 'warning', message: issue.message, issue });
    assert.equal(collector.groups()[0].severity, 'warning');
    assert.match(failureGroupLabel(collector.groups()[0]), /Source attachment unavailable.*404/);
    const summary = exportSummary({ exported: 1, partial: 1, skipped: 0, failed: [], aborted: false,
        expiredConversations: 1, otherPartial: 0,
        attachmentIssues: [{ ...issue, resourceId: 'missing', name: 'report.md' }] }, true);
    assert.match(summary, /1 conversations contain unavailable source attachments \(1 attachments\)/);
    assert.doesNotMatch(summary, /Attachment download failed|retry later|Other incomplete/);
});

test('normal mode hides attachment warnings while retaining body failures and cooldown', () => {
    const result = { exported: 1, partial: 1, skipped: 2, failed: [key('body')], aborted: true,
        expiredConversations: 1, otherPartial: 1, rateLimitedUntil: Date.now() + 3600000,
        attachmentIssues: ['RESOURCE_SOURCE_EXPIRED', 'RESOURCE_ACCESS_RESTRICTED', 'RESOURCE_DOWNLOAD_FAILED',
            'RESOURCE_PROCESSING_FAILED', 'RESOURCE_UNAVAILABLE'].map(code => ({ resourceId: code, name: code, code })) };
    const normal = exportSummary(result, false);
    assert.doesNotMatch(normal, /attachments|Attachment|RESOURCE_/);
    assert.match(normal, /Other incomplete conversations: 1/);
    assert.match(normal, /Conversation export failed: 1/);
    assert.match(normal, /Skipped: 2/);
    assert.match(normal, /429/);
    const developer = exportSummary(result, true);
    assert.match(developer, /unavailable source attachments/);
    assert.match(developer, /Attachment download failed/);
    assert.match(developer, /Attachment processing failed/);
    assert.match(developer, /Access restricted/);
});

test('source termination metadata never becomes an export failure, even for legacy warning events', () => {
    const collector = new ExportIssueCollector();
    for (const code of ['SOURCE_TURN_UNKNOWN', 'SOURCE_TURN_UNFINISHED', 'SOURCE_TURN_INTERRUPTED',
        'SOURCE_TURN_HANDOFF', 'SOURCE_TURN_AWAITING_REPLY', 'SOURCE_TURN_TOOL_PENDING']) {
        collector.add({ key: key(code), stage: 'detail', code, severity: 'warning', message: 'Source state only' });
    }
    assert.deepEqual(collector.groups(), []);
    collector.add({ key: key('body'), stage: 'detail', code: 'DETAIL_NOT_COMPLETE', severity: 'warning', message: 'Missing ancestor' });
    collector.add({ key: key('file'), stage: 'resource', code: 'RESOURCE_DOWNLOAD_FAILED', severity: 'warning', message: 'Download failed' });
    collector.add({ key: key('delivery'), stage: 'export', code: 'EXPORT_FAILED', severity: 'error', message: 'Disk write failed',
        issue: { code: 'FILE_WRITE_FAILED', message: 'Disk write failed' } });
    assert.deepEqual(collector.groups().map(group => group.category), ['DETAIL_NOT_COMPLETE', 'RESOURCE_DOWNLOAD_FAILED', 'FILE_WRITE_FAILED']);
});
