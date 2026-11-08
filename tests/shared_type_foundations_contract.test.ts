import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Account } from '../src/l2/accountRegistry.js';
import type { DomainMessage, DomainCitation, DomainAsset } from '../src/l2/conversationDetail.js';
import type { ConversationKey } from '../src/l2/conversationKey.js';
import type { ExportRequest, ExportResult, ExportProgress, ExportRecord } from '../src/application/export/types.js';
import type { ScanResult, ScanProgress } from '../src/application/sync/scanController.js';
import type { TakeoutParseResult } from '../src/l1/imports/takeout/importTakeout.js';
import type { DirectoryHandle } from '../src/runtime/capabilities/directoryHandle.js';
import { ConversationViewState } from '../src/ui/options/state/conversationsStore.js';
import * as Directory from '../src/runtime/capabilities/dirHandleController.js';
import { runExport } from '../src/ui/options/controllers/exportController.js';
import { startSync } from '../src/ui/options/controllers/syncController.js';
import { handleTakeoutImport } from '../src/ui/options/controllers/takeoutController.js';
import { sendToGeminiTab } from '../src/runtime/capabilities/tabService.js';
import type { compileDocumentPdf } from '../src/l4/format/pdf/compileDocumentPdf.js';
import { STEPS, type TourStep } from '../src/ui/guidance/tourSteps.js';
import { mount } from './helpers/uiPortHarness.js';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type SharedTypeFoundationContracts = [
    Assert<Equal<DomainMessage['citations'], DomainCitation[] | undefined>>,
    Assert<Equal<DomainAsset['sourceUri'], string | undefined>>,
    Assert<Equal<Account['email'], string | undefined>>,
    Assert<Equal<ConversationViewState['accounts'], Account[]>>,
    Assert<Equal<ReturnType<ConversationViewState['keys']>, ConversationKey[]>>,
    Assert<Equal<ConversationViewState['records'], Record<string, ExportRecord>>>,
    Assert<Equal<Parameters<typeof runExport>[0], ExportRequest>>,
    Assert<Equal<Awaited<ReturnType<typeof runExport>>, ExportResult>>,
    Assert<Equal<Parameters<NonNullable<NonNullable<Parameters<typeof runExport>[1]>['onProgress']>>[0], ExportProgress>>,
    Assert<Equal<Awaited<ReturnType<typeof Directory.requestDirHandle>>, DirectoryHandle>>,
    Assert<Equal<Awaited<ReturnType<typeof Directory.restoreSavedDirHandle>>, DirectoryHandle | null>>,
    Assert<Equal<Parameters<typeof Directory.setDirHandle>[0], DirectoryHandle | null>>,
    Assert<Equal<Awaited<ReturnType<typeof startSync>>, ScanResult>>,
    Assert<Equal<Parameters<NonNullable<Parameters<typeof startSync>[1]['onProgress']>>[0], ScanProgress>>,
    Assert<Equal<Awaited<ReturnType<typeof handleTakeoutImport>>, TakeoutParseResult>>,
    Assert<Equal<typeof STEPS, TourStep[]>>,
    Assert<Equal<Parameters<typeof sendToGeminiTab>[0], unknown>>,
    Assert<Equal<Awaited<ReturnType<typeof sendToGeminiTab>>, unknown>>,
    Assert<Equal<number extends DomainCitation['url'] ? true : false, false>>,
    Assert<Equal<string extends DomainMessage['role'] ? true : false, false>>,
    Assert<Equal<Awaited<ReturnType<typeof compileDocumentPdf>> extends ExportResult ? true : false, false>>
];
function currentContracts(request: ExportRequest, progress: ExportProgress): void {
    // @ts-expect-error ZIP is automatic packaging, not a second UI pipeline preference.
    request.useZip = true;
    // @ts-expect-error UI cannot turn current/total into another persisted business session.
    progress.sessionId = 'persisted';
    Directory.setDirHandle(null);
}
void currentContracts;

test('current completion result distinguishes failed exports and exposes retry without a durable session banner', async () => {
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true }); try {
        for (const failExport of [false, true]) {
            const page = await browser.newPage(); await mount(page, 'options', { failExport });
            await page.locator('#btnSelectAll').click(); await page.locator('#btnExport').click(); await page.waitForFunction(() => document.body.dataset.busy !== 'true');
            const status = await page.locator('#status').textContent() ?? '';
            if (failExport) assert.match(status, /failed: 1/);
            else assert.doesNotMatch(status, /failed:/);
            assert.equal(await page.locator('#btnRetryFailed').isVisible(), failExport);
            assert.equal(await page.locator('#exportSessionBanner, #btnResumeExport').count(), 0);
            await page.close();
        }
    } finally { await browser.close(); }
});
