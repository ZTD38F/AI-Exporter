import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExportRequest, ExportResult } from '../src/application/export/types.js';
import { A, B, assertUiNodeIsolation, exportPort, installUiV2Mocks, mockRunExport } from './helpers/uiV2Mocks.js';

// Only load UI code after replacing the Application/Runtime/L1/Storage modules
// with their v2 public ports. No Application Export engine is executed here.
installUiV2Mocks();
const { runExport: uiExport } = require('../src/ui/options/controllers/exportController.js') as
    typeof import('../src/ui/options/controllers/exportController.js');
const { startSync } = require('../src/ui/options/controllers/syncController.js') as
    typeof import('../src/ui/options/controllers/syncController.js');
const { handleTakeoutImport } = require('../src/ui/options/controllers/takeoutController.js') as
    typeof import('../src/ui/options/controllers/takeoutController.js');
const { errorText } = require('../src/ui/shared/settings.js') as
    typeof import('../src/ui/shared/settings.js');
assertUiNodeIsolation();

const key = (conversationId: string) => ({ accountId: A, conversationId });
const request: ExportRequest = {
    keys: [key('first'), key('second')], format: 'markdown', delivery: 'browserDownload',
    includeAssets: true, skipUnchanged: false,
};
test.beforeEach(() => exportPort.reset());

test('exportController forwards the frozen v2 request and progress port unchanged', async () => {
    const seen: unknown[] = [];
    const signal = new AbortController().signal;
    const result = await uiExport(request, { signal, onProgress: progress => seen.push(progress) });
    assert.equal(uiExport, mockRunExport);
    assert.deepEqual(exportPort.calls, [{ request, signal }]);
    assert.deepEqual(seen, [
        { current: 1, total: 2, key: key('first') },
        { current: 2, total: 2, key: key('second') },
    ]);
    assert.deepEqual(result, { exported: 2, skipped: 0, partial: 0, failed: [], aborted: false });
});

test('exportController passes final partial/failure facts and errors from mocked Application', async () => {
    const final: ExportResult = { exported: 1, partial: 1, skipped: 0, failed: [key('second')], aborted: false };
    exportPort.result = final;
    assert.strictEqual(await uiExport(request), final);
    const failure = new Error('Delivery failed');
    exportPort.error = failure;
    await assert.rejects(uiExport(request), error => error === failure);
});

test('syncController aborts after resolving source but before launching the mocked Scan', async () => {
    const controller = new AbortController();
    let scans = 0;
    const operation = startSync(A, { signal: controller.signal, onTarget: async () => controller.abort() }, {
        resolveScanTarget: async () => A,
        scanAll: async () => { scans++; throw Error('Unexpected Scan'); },
    });
    await assert.rejects(operation, { name: 'AbortError' });
    assert.equal(scans, 0);
});

test('syncController uses the verified source, ScanRequest and committed v2 progress', async () => {
    const seen: unknown[] = [];
    const signal = new AbortController().signal;
    const result = await startSync(B, { signal, forceFull: true,
        onTarget: async id => { seen.push(['target', id]); },
        onProgress: progress => { seen.push(progress); } }, {
        resolveScanTarget: async preferred => { assert.equal(preferred, B); return A; },
        scanAll: async (scanRequest, options) => {
            seen.push(scanRequest);
            assert.strictEqual(options?.signal, signal);
            options?.onProgress?.({ pagesFetched: 2, conversationsFetched: 151 });
            return { status: 'partial_limit', reason: 'max_pages', pagesFetched: 2, conversationsFetched: 151 };
        },
    });
    assert.deepEqual(seen, [['target', A], { accountId: A, forceFull: true },
        { pagesFetched: 2, conversationsFetched: 151 }]);
    assert.equal(result.reason, 'max_pages');
});

test('syncController passes source resolution errors through without starting a Scan', async () => {
    const failure = new Error('Receiving end does not exist');
    let scans = 0;
    await assert.rejects(startSync(A, { signal: new AbortController().signal, onTarget: async () => {} }, {
        resolveScanTarget: async () => { throw failure; },
        scanAll: async () => { scans++; throw Error('Unexpected Scan'); },
    }), error => error === failure);
    assert.equal(scans, 0);
    assert.equal(errorText(failure), 'Operation failed. Please retry; details are available in the logs or diagnostic report.');
    assert.equal(failure.message, 'Receiving end does not exist', 'the diagnostic error stays intact');
});

test('native picker cancellation is readable and never exposes the browser API exception', () => {
    assert.equal(errorText(new DOMException("Failed to execute 'showDirectoryPicker' on 'Window': The user aborted a request.", 'AbortError')),
        'Operation cancelled. You can try again.');
});

test('takeoutController uses v2 Account/Settings/Import mocks with selected Account UUID', async () => {
    const file = new File(['fixture'], 'takeout.zip');
    const seen: unknown[] = [];
    const account = { id: A, providerId: 'gemini', providerAccountId: 'fixture' };
    const result = await handleTakeoutImport(file, A, {
        onTarget: async id => { seen.push(['target', id]); },
        onProgress: value => { seen.push(['progress', value]); },
    }, {
        listAccounts: async () => [account],
        getAccount: async id => { assert.equal(id, A); return account; },
        getOrCreateAccount: async () => { throw Error('Unexpected account creation'); },
        updateSettings: async patch => { seen.push(['settings', patch]); },
        importTakeout: async (actual, id, progress) => {
            assert.strictEqual(actual, file);
            assert.equal(id, A);
            progress?.(100);
            return { imported: 1, status: 'ok' as const };
        },
    });
    assert.deepEqual(seen, [['target', A], ['settings', { takeoutPromptCompleted: true }], ['progress', 100]]);
    assert.deepEqual(result, { imported: 1, status: 'ok' });
});
