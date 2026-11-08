/** Real released runtime/profile upgrade. Fixtures enter through UI and RPC,
 * never through storage seeds or replacements of production modules. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { migrationFacts, assertPersistedBaseline, upgradeOutcome } from './upgrade_baseline.mjs';
import { NativeExportFailure } from './upgrade_failures.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('../lib/jszip.min.js');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const OLD_SHA = 'b79ed42a1dc080094fd78ca991f69d1a04f5b7e19fe3c20f45a5aec57b0f83cf';
const argv = process.argv.slice(2);
const arg = name => argv[argv.indexOf(name) + 1];
if (!argv.includes('--old-zip') || !argv.includes('--candidate-zip') || !argv.includes('--output-dir')) {
  console.error('Usage: npm run test:upgrade -- --old-zip <official-v1.7.0.zip> --candidate-zip <release.zip> --output-dir <new-directory>');
  process.exit(1);
}
const output = path.resolve(arg('--output-dir'));
// Fail closed: an existing profile/baseline must never be overwritten.
await fs.mkdir(output);
const installed = path.join(output, 'installed');
const profile = path.join(output, 'profile');
const report = { status: 'failed', fixtureTransport: true, stages: [], packages: {}, checks: [] };
let context;
let extensionId;
let revision = 0;
let activityTimestamp = 0;
let baselineProfileSha;
let offline = false;
let failDetail = false;
const failedId = 'aa44444444444444';
const accounts = ['u0', 'u1'];
const ids = slot => [`${slot === 'u0' ? 'aa' : 'bb'}11111111111111`, `${slot === 'u0' ? 'aa' : 'bb'}22222222222222`];
const takeoutId = slot => `${slot === 'u0' ? 'aa' : 'bb'}33333333333333`;
const prompt = (slot, index) => `Upgrade ${slot} question ${index}: explain conservation and boundary conditions.`;
const response = (slot, index) => `Upgrade ${slot} answer ${index}. The complete middle paragraph preserves the measured boundary condition.\n\n**Exact code follows:**\n\n\`\`\`python\nvalue = ${index} ** 2\nprint(value)\n\`\`\`\n\nEnergy is $E = mc^2$. Final ${slot} sentence ${index}.`;
const turns = (slot, id) => Array.from({ length: id === ids(slot)[0] && revision ? 4 : 3 }, (_, index) => [
  ['c_' + id, 'r_' + id + '_' + index], 'turn_' + index, [[prompt(slot, index)]], [[['rc_' + index, [response(slot, index)]]]]
]).reverse();
const rpc = (id, value) => ['wrb.fr', id, JSON.stringify(value)];
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const accountShell = slot => `<script>window._WIZ_global_data={SNlM0e:'upgrade_${slot}',cfb2h:'upgrade_fixture'}</script><button aria-label="Google Account: Upgrade ${slot} (${slot}@upgrade.example)">Account</button>`;

async function install(zipPath, name) {
  const bytes = await fs.readFile(zipPath);
  if (name === 'old') assert.equal(sha(bytes), OLD_SHA, 'Old ZIP is not the verified official v1.7.0 asset');
  const archive = await JSZip.loadAsync(bytes);
  const manifest = JSON.parse(await archive.file('manifest.json').async('string'));
  if (name === 'old') assert.equal(manifest.version, '1.7.0');
  else {
    const version = manifest.version.split('.').map(Number);
    assert.ok(version.length === 3 && version.every(Number.isInteger)
      && (version[0] > 1 || version[0] === 1 && (version[1] > 7 || version[1] === 7 && version[2] > 0)),
    'Candidate must be a forward upgrade');
  }
  report.packages[name] = { path: path.resolve(zipPath), sha256: sha(bytes), version: manifest.version };
  if (name === 'candidate') await fs.rm(installed, { recursive: true });
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue;
    const target = path.resolve(installed, entry.name);
    assert.ok(target.startsWith(installed + path.sep), 'Unsafe package entry');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await entry.async('nodebuffer'));
  }
}

async function launch() {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, chromiumSandbox: true,
    acceptDownloads: true, args: ['--headless=new', `--disable-extensions-except=${installed}`,
      `--load-extension=${installed}`, '--enable-unsafe-extension-debugging'] });
  // Only the deterministic Gemini route below may serve web responses in the upgrade test.
  await context.route(/^https?:\/\//, route => route.abort('blockedbyclient'));
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  // The native loadUnpacked update preserves the existing extension ID and
  // profile. Replacing files alone can leave the old MV3 worker code cached.
  // No uninstall/remove/clear command is issued anywhere in this harness.
  if (report.packages.candidate) {
    const reloaded = context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    const cdp = await context.browser().newBrowserCDPSession();
    const updated = await cdp.send('Extensions.loadUnpacked', { path: installed });
    assert.equal(updated.id, extensionId, 'Native update changed extension ID');
    worker = await reloaded || context.serviceWorkers().at(-1);
    await cdp.detach();
  }
  const id = worker.url().split('/')[2];
  if (extensionId) assert.equal(id, extensionId, 'Extension ID changed across upgrade/restart');
  extensionId = id;
  report.extensionId = id;
  report.chromeVersion = context.browser().version();
  const activeVersion = await worker.evaluate(() => chrome.runtime.getManifest().version);
  assert.equal(activeVersion, report.packages.candidate?.version || report.packages.old.version, 'Wrong runtime active after native update');
  report.checks.push({ nativeInPlaceUpdate: !!report.packages.candidate, activeVersion, extensionId });
  await context.route('https://gemini.google.com/**', async route => {
    if (offline) return route.abort('internetdisconnected');
    const url = new URL(route.request().url());
    const slot = url.pathname.includes('/u/1/') ? 'u1' : 'u0';
    if (!url.pathname.includes('batchexecute')) return route.fulfill({ contentType: 'text/html', body: accountShell(slot) });
    const data = new URLSearchParams(route.request().postData() || '').get('f.req');
    const packets = [];
    for (const call of data ? JSON.parse(data).flat() : []) {
      const [method, encoded] = call;
      const params = JSON.parse(encoded);
      if (method === 'hNvQHb') {
        const id = params[0].replace(/^c_/, '');
        if (id === failedId && failDetail) return route.fulfill({ status: 500, body: 'Controlled upgrade detail failure' });
        if (!ids(slot).includes(id)) return route.fulfill({ status: 404, body: 'Offline Takeout record' });
        packets.push(rpc(method, [turns(slot, id), null, `Upgrade ${slot} ${id}`]));
      } else if (method === 'MaZiqc') {
        const pinned = params[2]?.[0] === 1;
        const rows = ids(slot).map((id, index) => ['c_' + id, `Upgrade ${slot} ${id}`, null, null, null,
          [index === 0 && revision ? activityTimestamp : 1700000300 - index * 100, 0]]);
        if (failDetail && slot === 'u0') rows.unshift(['c_' + failedId, 'Controlled upgrade detail failure', null, null, null, [1700000900, 0]]);
        packets.push(rpc(method, pinned ? [] : [null, rows, null]));
      }
    }
    await route.fulfill({ contentType: 'application/json', body: ")]}'\n\n" + JSON.stringify(packets) });
  });
}

async function options(slot) {
  const page = await context.newPage();
  page.on('dialog', dialog => dialog.accept());
  await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
  await page.waitForFunction(() => !!window.ConversationsStore);
  await expect(page.locator(`#accountSlotSelect option[value="${slot}"]`)).toBeAttached();
  if (await page.evaluate(() => window.ConversationsStore.getCurrentSlot()) !== slot) {
    await page.locator('#accountSlotSelect').selectOption(slot);
  }
  await page.waitForFunction(slot => window.ConversationsStore.getCurrentSlot() === slot, slot);
  return page;
}

async function connectAccount(slot) {
  const page = await context.newPage();
  const base = slot === 'u0' ? '' : '/u/1';
  const url = `https://gemini.google.com${base}/app`;
  // A restart closes the Gemini tabs. In the offline stage, supply only the
  // account shell so the real content bridge can run; every body/resource
  // request still reaches the context's disconnected route above.
  if (offline) await page.route(url, route => route.fulfill({ contentType: 'text/html', body: accountShell(slot) }), { times: 1 });
  await page.goto(url);
  // A native fetch passes through the real MAIN hook and credential bridge.
  await page.waitForTimeout(1000);
  if (!offline) await page.evaluate(async ({ base, slot }) => fetch(`${base}/_/BardChatUi/data/batchexecute?f.sid=upgrade_${slot}&at=fixture`, { method: 'POST' }), { base, slot });
  return page;
}

async function sync(page, slot) {
  const button = page.locator('#btnSyncAll, #btnDeepScan');
  await button.click();
  await expect(button).toBeEnabled({ timeout: 60000 });
  const state = await page.evaluate(slot => chrome.storage.local.get('gemini_scan_coverage' + (slot === 'u0' ? '' : '_' + slot)), slot);
  const coverage = Object.values(state)[0];
  // v1.7.0 predates the current coverage ledger; visible production rows are
  // asserted for both versions, the new ledger is asserted when present.
  if (coverage) assert.ok(['complete', 'up_to_date'].includes(coverage.lastStatus), 'Sync did not certify coverage');
  for (const id of ids(slot)) await expect(page.locator(`[data-chat-id="${id}"]`)).toBeVisible();
}

async function importTakeout(page, slot) {
  const zip = new JSZip();
  const blocks = [0, 1].map(index => `<div class="outer-cell"><div class="content-cell">Prompted Offline ${slot} question ${index}<br>Oct 1, 2026, 10:0${index}:00 AM UTC<br><p>Offline ${slot} answer ${index}: preserve the entire middle and final sentence.</p><img src="image.png"></div><a href="https://gemini.google.com/app/${takeoutId(slot)}">Chat</a></div>`);
  zip.file('Takeout/MyActivity.html', '<html><body>' + blocks.join('') + '</body></html>');
  zip.file('Takeout/image.png', image);
  const file = path.join(output, `takeout-${slot}.zip`);
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
  await page.locator('#takeoutFileInput').setInputFiles(file);
  await expect(page.locator(`[data-chat-id="${takeoutId(slot)}"]`)).toBeVisible({ timeout: 60000 });
}

async function exportZip(page, slot, format, label, selected = [...ids(slot), takeoutId(slot)], skip = false) {
  await page.locator('#format').selectOption(format);
  await page.locator('#skipExported').setChecked(skip);
  await page.locator('#btnSelectAll').check();
  await page.locator('#btnSelectAll').uncheck();
  for (const id of selected) await page.locator(`[data-chat-id="${id}"] input[type="checkbox"]`).check();
  const downloadPending = page.waitForEvent('download', { timeout: 120000 });
  const failurePending = page.locator('#exportFailureList').waitFor({ state: 'visible', timeout: 120000 })
    .then(async () => {
      const evidence = await page.evaluate(() => ({
        failedChats: window.DialogView.getLastFailedChats(),
        rows: [...document.querySelectorAll('#exportFailureList > div')].map(row => row.title),
      }));
      assert.ok(Array.isArray(evidence.failedChats), 'Missing failure UI model');
      assert.deepEqual(evidence.rows, evidence.failedChats.map(row =>
        `${row.id}: ${row.title || row.id || 'Untitled'}${row.error ? ` (${row.error})` : ''}`),
      'Failure UI does not match conversation evidence');
      throw new NativeExportFailure(evidence.failedChats);
    });
  await page.locator('#btnExport').click();
  const modal = page.locator('#btnModalContinueZip');
  if (await modal.isVisible()) await modal.click();
  const download = await Promise.race([downloadPending, failurePending]);
  assert.equal(await download.failure(), null);
  const file = path.join(output, `${label}-${slot}-${format}.zip`);
  await download.saveAs(file);
  const archive = await JSZip.loadAsync(await fs.readFile(file));
  const entries = {};
  for (const entry of Object.values(archive.files)) if (!entry.dir) entries[entry.name] = await entry.async('nodebuffer');
  report.checks.push({ export: path.basename(file), sha256: sha(await fs.readFile(file)), entries: Object.keys(entries) });
  return entries;
}

const normalize = text => text.normalize('NFKC').replace(/\s+/g, '');
function verifyMarkdown(entries, slot, count = 3, selected = [...ids(slot), takeoutId(slot)]) {
  for (const id of selected) {
    const matches = Object.keys(entries).filter(name => name.endsWith(`_${id.slice(-6)}.md`));
    const errors = Object.entries(entries).find(([name]) => name.endsWith('_export_errors.json'));
    assert.equal(matches.length, 1, `Missing/duplicate Markdown for ${id}; native errors: ${errors?.[1].toString() || 'none'}`);
    const text = normalize(entries[matches[0]].toString());
    if (id !== takeoutId(slot)) for (let index = 0; index < (id === ids(slot)[0] ? count : 3); index++) {
      for (const required of [prompt(slot, index), `Upgrade ${slot} answer ${index}.`,
        'The complete middle paragraph preserves the measured boundary condition.', `value = ${index} ** 2`,
        `Final ${slot} sentence ${index}.`]) assert.ok(text.includes(normalize(required)), `Missing authored content: ${required}`);
    }
    else for (let index = 0; index < 2; index++) assert.ok(text.includes(normalize(`Offline ${slot} question ${index}`)), 'Offline turn lost');
    const other = slot === 'u0' ? 'u1' : 'u0';
    assert.ok(!text.includes(`Upgrade${other}`) && !text.includes(`Offline${other}`), 'Cross-account content leak');
  }
}

async function snapshot(page, label) {
  const state = await page.evaluate(async () => {
    async function encode(value) {
      if (value instanceof Blob) value = await value.arrayBuffer();
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return { binarySnapshot: true, byteLength: bytes.length, sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('') };
      }
      if (value?.kind === 'directory' && typeof value.name === 'string') return { directoryHandleSnapshot: true, kind: value.kind, name: value.name };
      if (Array.isArray(value)) return Promise.all(value.map(encode));
      if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await encode(v)])));
      return value;
    }
    const databases = {};
    for (const info of await indexedDB.databases()) {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open(info.name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const stores = {}, keys = {};
      for (const name of db.objectStoreNames) {
        const rows = await new Promise((resolve, reject) => { const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        stores[name] = await encode(rows);
        keys[name] = await new Promise((resolve, reject) => { const r = db.transaction(name).objectStore(name).getAllKeys(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      }
      databases[info.name] = { version: db.version, stores, keys }; db.close();
    }
    return { local: await encode(await chrome.storage.local.get(null)), databases };
  });
  const bytes = Buffer.from(JSON.stringify(state, null, 2));
  await fs.writeFile(path.join(output, `${label}.json`), bytes, { flag: 'wx' });
  report.checks.push({ snapshot: `${label}.json`, sha256: sha(bytes) });
  return state;
}

async function retained(before, after) {
  await assertPersistedBaseline(before, after);
  report.migratedCategories = ['accounts', 'indexes', 'exportRecords', 'settings', 'directoryHandle'];
}

async function stage(name, run) {
  console.log('Upgrade stage:', name);
  const entry = { name, status: 'running' }; report.stages.push(entry);
  try { const result = await run(); entry.status = result?.status || 'passed'; if (result?.reason) entry.reason = result.reason; }
  catch (error) {
    entry.status = 'failed'; entry.error = String(error.stack || error);
    console.error('Upgrade stage failed:', name, entry.error);
    throw error;
  } finally {
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
}

async function profileDigest(directory) {
  const entries = [];
  async function walk(current) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) entries.push([path.relative(directory, file), sha(await fs.readFile(file))]);
    }
  }
  await walk(directory);
  return sha(JSON.stringify(entries));
}

try {
  const baselineExports = {};
  let baseline;
  await stage('official 1.7.0 writes two accounts, online turns, Takeout, attachments and exported flags', async () => {
    await install(arg('--old-zip'), 'old'); await launch();
    for (const slot of accounts) {
      await connectAccount(slot);
      const page = await options(slot); await sync(page, slot); await importTakeout(page, slot);
      baselineExports[slot] = await exportZip(page, slot, 'markdown', 'old');
      verifyMarkdown(baselineExports[slot], slot);
      assert.ok(Object.values(baselineExports[slot]).some(bytes => sha(bytes) === sha(image)), 'Old runtime did not export source attachment bytes');
      await page.close();
    }
    const page = await options('u0'); baseline = await snapshot(page, 'baseline');
    migrationFacts(baseline); // Fail with an explicit unsupported-source diagnostic before installing candidate.
    await context.close(); context = null;
    await fs.cp(profile, path.join(output, 'baseline-profile'), { recursive: true });
    baselineProfileSha = await profileDigest(path.join(output, 'baseline-profile'));
    report.baselineProfileSha256 = baselineProfileSha;
    await fs.chmod(path.join(output, 'baseline.json'), 0o444);
  });
  await stage('same profile and extension ID forward upgrade, persisted metadata/flags and restart', async () => {
    await install(arg('--candidate-zip'), 'candidate'); await launch();
    const page = await options('u0'); await retained(baseline, await snapshot(page, 'after-upgrade')); await page.close();
    await context.close(); context = null; await launch();
    const reopened = await options('u0'); await retained(baseline, await snapshot(reopened, 'after-restart')); await reopened.close();
  });
  await stage('new activity, incremental export and account isolation after restart', async () => {
    offline = false;
    revision = 1;
    activityTimestamp = Math.floor(Date.now() / 1000) + 5;
    for (const slot of accounts) {
      await connectAccount(slot); const page = await options(slot); await sync(page, slot);
      const entries = await exportZip(page, slot, 'markdown', 'incremental', [ids(slot)[0]], true);
      verifyMarkdown(entries, slot, 4, [ids(slot)[0]]);
      assert.ok(!Object.keys(entries).some(name => name.endsWith(`_${ids(slot)[1].slice(-6)}.md`)), 'Unchanged conversation reexported');
      for (const format of ['html', 'pdf']) {
        await exportZip(page, slot, format, 'new-activity', ids(slot));
        execFileSync('python3', [path.join(scriptRoot, 'upgrade_content_check.py'),
          path.join(output, `new-activity-${slot}-${format}.zip`), slot, format,
          '--first-turn-count', '4'], { stdio: 'inherit' });
      }
      await page.close();
    }
    const page = await options('u0'); await snapshot(page, 'after-new-activity'); await page.close();
  }).catch(() => {});
  await stage('controlled acquisition failure is diagnosed and never marked exported', async () => {
    failDetail = true; const page = await options('u0'); await sync(page, 'u0');
    const before = await page.evaluate(() => chrome.storage.local.get('exportedIds'));
    await page.locator('#format').selectOption('markdown'); await page.locator('#skipExported').uncheck();
    await page.locator('#btnSelectAll').check();
  await page.locator('#btnSelectAll').uncheck();
    await page.locator(`[data-chat-id="${failedId}"] input[type="checkbox"]`).check();
    await page.locator('#btnExport').click();
    await expect(page.locator('#exportFailureList')).toBeVisible({ timeout: 90000 });
    const after = await page.evaluate(() => chrome.storage.local.get('exportedIds'));
    assert.notEqual(after.exportedIds?.[failedId]?.status, 'ok', 'Failed export falsely marked successful');
    for (const [id, record] of Object.entries(before.exportedIds)) assert.deepEqual(after.exportedIds[id], record, 'Failure corrupted another export record');
    await page.screenshot({ path: path.join(output, 'failure-diagnostic.png') });
    await snapshot(page, 'final'); await page.close();
  }).catch(() => {});
  assert.equal(await profileDigest(path.join(output, 'baseline-profile')), baselineProfileSha, 'Original baseline profile changed during testing');
  report.status = upgradeOutcome(report.stages);
  if (report.status === 'failed') process.exitCode = 1;
} catch (error) {
  report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;
} finally {
  if (context) await context.close();
  try { report.runnerCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* package identity is pinned by ZIP SHA */ }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Upgrade ${report.status}; evidence: ${output}`);
}
