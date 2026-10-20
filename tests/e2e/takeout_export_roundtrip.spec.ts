import { test, expect } from './fixtures';
import * as fs from 'fs';
import * as path from 'path';

const JSZip = require(path.resolve(__dirname, '../../lib/jszip.min.js'));
const takeoutFixture = path.resolve(__dirname, '../fixtures/gemini_takeout_clean.zip');

/**
 * Browser-level regression for the complete offline Takeout -> Workbench -> ZIP
 * roundtrip. Unlike isolated parser tests, this exercises the actual file input,
 * local storage, selection flow, browser download and exported attachment links.
 * No Google session, Google API requests, or personal data is required.
 */
test('imports six legacy Gemini chats and exports every chat with reachable offline assets', async ({ context, extensionId }) => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
  await page.waitForLoadState('domcontentloaded');

  // DOM readiness alone precedes asynchronous workbench/storage initialization.
  // Wait for the rendered selection statistic before interacting with bound handlers.
  await expect(page.locator('#selectedStat')).not.toBeEmpty({ timeout: 20_000 });
  await page.locator('#btnImportTakeout').click();
  await expect(page.locator('#takeoutImportModal')).toBeVisible();
  await page.locator('#takeoutFileInput').setInputFiles(takeoutFixture);
  await expect(page.locator('#list .item')).toHaveCount(6, { timeout: 30_000 });
  await expect.poll(() => page.evaluate(async () => {
    const state = await chrome.storage.local.get('has_imported_takeout');
    return state.has_imported_takeout === true;
  })).toBe(true);

  await page.selectOption('#format', 'markdown');
  await page.locator('#includeAssets').check();
  await page.locator('#includeZip').check();
  await page.locator('#btnSelectAll').click();
  await expect(page.locator('#list input[type="checkbox"]:checked')).toHaveCount(6);

  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('#btnExport').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/i);
  const exportedZip = await JSZip.loadAsync(fs.readFileSync((await download.path())!));

  const names: string[] = Object.keys(exportedZip.files);
  const chatFiles = names.filter(name => /^gemini_export\/[^/]+\.md$/i.test(name));
  const attachedDocs = names.filter(name => /^gemini_export\/files\/[^/]+\.md$/i.test(name));
  const exportedImages = names.filter(name => /^gemini_export\/assets\/[^/]+\.png$/i.test(name));
  expect(chatFiles, 'Every imported conversation must have exactly one top-level markdown').toHaveLength(6);
  expect(attachedDocs, 'The fixture has one Markdown document attachment').toHaveLength(1);
  expect(exportedImages, 'The fixture has one recovered offline image').toHaveLength(1);

  let checkedRelativeLinks = 0;
  for (const chatFile of chatFiles) {
    const markdown: string = await exportedZip.file(chatFile).async('text');
    expect(markdown.length, `${chatFile} must not be empty`).toBeGreaterThan(100);
    for (const match of markdown.matchAll(/!?\[[^\]]*\]\((?:(?:\.\/)?(?:assets|files))\/([^)]+)\)/g)) {
      const href = match[0].slice(match[0].indexOf('(') + 1, -1).split(' "')[0];
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(chatFile), href));
      expect(exportedZip.file(target), `Broken local attachment reference: ${target}`).toBeTruthy();
      checkedRelativeLinks++;
    }
  }
  expect(checkedRelativeLinks, 'Fixture attachment links must be exercised').toBeGreaterThanOrEqual(2);

  await expect(page.locator('#list .item')).toHaveCount(6);
  const exportedState = await page.evaluate(async () => {
    const state = await chrome.storage.local.get('exportedIds');
    return Object.keys(state.exportedIds || {}).length;
  });
  expect(exportedState).toBe(6);
  await page.close();
});

test('does not mark a missing online-only conversation as exported when Gemini is closed', async ({ context, extensionId }) => {
  test.setTimeout(45_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(async () => {
    await chrome.storage.local.set({
      gemini_conversations: [{ id: 'missing-online-only-test', title: 'Not cached anywhere', timestamp: 1700000000000 }],
      exportedIds: {},
      has_completed_tour: true,
    });
    if (typeof window.__workbenchLoadStore === 'function') {
      await window.__workbenchLoadStore(true);
    }
  });
  await expect(page.locator('#list .item')).toHaveCount(1);
  await page.selectOption('#format', 'markdown');
  await page.locator('#btnSelectAll').click();
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await page.locator('#btnExport').click();
  const download = await downloadPromise;
  const exportedZip = await JSZip.loadAsync(fs.readFileSync((await download.path())!));
  const archivePaths: string[] = Object.keys(exportedZip.files);
  expect(archivePaths.filter(name => /^gemini_export\/[^/]+\.md$/i.test(name))).toHaveLength(0);
  const failuresPath = archivePaths.find(name => name.endsWith('/_export_errors.json'));
  expect(failuresPath, 'A missing chat must be represented as an explicit failure').toBeTruthy();
  const failures = JSON.parse(await exportedZip.file(failuresPath!).async('text'));
  expect(failures.summary.total).toBe(1);
  expect(failures.summary.landed).toBe(0);
  expect(failures.summary.failed).toBe(1);
  expect(failures.failedChats[0].id).toBe('missing-online-only-test');
  const saved = await page.evaluate(async () => {
    const data = await chrome.storage.local.get('exportedIds');
    return data.exportedIds || {};
  });
  expect((saved as Record<string, unknown>)['missing-online-only-test']).toBeUndefined();
  await page.close();
});
