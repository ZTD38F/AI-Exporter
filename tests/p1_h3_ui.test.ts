export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

// ---------- P1-118: CSS.escape ----------
test('p1_h3 - P1-118: listView escapes dynamic ids in selectors', () => {
    const src = SRC('ui/views/listView.ts');
    assert.ok(src.includes('CSS.escape'), 'updateItemExportStatus must use CSS.escape');
});

// ---------- P1-119: dirHandleController ----------
test('p1_h3 - P1-119: restore never calls requestPermission without a gesture', async () => {
    const dh = require('../src/ui/controllers/dirHandleController.js');
    let requested = false;
    const fakeHandle = {
        queryPermission: async () => 'prompt',
        requestPermission: async () => { requested = true; return 'granted'; },
        keys: async function* () {}
    };
    const ok = await dh.verifyDirPermission(fakeHandle);
    assert.strictEqual(ok, false, 'prompt permission is not granted');
    assert.strictEqual(requested, false, 'requestPermission must not fire without user activation');
});
test('p1_h3 - P1-119: stored handle is only dropped on confirmed NotFoundError', () => {
    const src = SRC('ui/controllers/dirHandleController.ts');
    assert.ok(src.includes('r.notFound'), 'restore must gate handle deletion on notFound');
    assert.ok(src.includes('userActivation'), 'requestPermission gated on user activation');
});

// ---------- P1-120/121/122: options UI glue ----------
test('p1_h3 - P1-120: takeout file input is reset after import', () => {
    const src = SRC('ui/options/modules/optionsTakeout.ts');
    assert.ok(src.includes('input.value = '), 'input must be cleared so the same zip can be re-picked');
});
test('p1_h3 - P1-121: loadStore failure reaches the UI log', () => {
    const src = SRC('ui/options/modules/optionsInit.ts');
    assert.ok(/loadStore error[\s\S]{0,400}log\(/.test(src), 'catch must call log()');
    assert.ok(src.includes("'error'"), 'logged at error level');
});
test('p1_h3 - P1-122: initWorkbench boot is catch-guarded on both paths', () => {
    const src = SRC('ui/options/options.ts');
    assert.ok(src.includes('startWorkbench'), 'guarded starter exists');
    assert.ok(src.includes(".catch("), 'startup promise has .catch');
    assert.ok(src.includes("addEventListener('DOMContentLoaded', startWorkbench)"), 'DOMContentLoaded path wrapped');
});

// ---------- P1-123: popup ----------
test('p1_h3 - P1-123: popup language switch re-applies i18n + toggle UI + count', () => {
    const src = SRC('ui/popup/popup.ts');
    assert.ok(src.includes('i18n.applyI18n()'), 'explicit applyI18n on language change');
    assert.ok(src.includes('applyLangToggleUI()'), 'toggle UI refreshed');
    assert.ok(src.includes('await updateCount()'), 'count refreshed');
});
test('p1_h3 - P1-123: export-current-page has a re-entrancy guard released in finally', () => {
    const src = SRC('ui/popup/popup.ts');
    assert.ok(src.includes('__exportingCurrentPage'), 'guard variable exists');
    assert.ok(/finally\s*\{\s*__releaseExportGuard\(\);/.test(src), 'guard released when the async callback ends');
});
test('p1_h3 - P1-123: popupExportBusy key exists in en and zh', () => {
    const en = require('../src/core/utils/locales/en.js');
    const zh = require('../src/core/utils/locales/zh.js');
    assert.ok(typeof en.popupExportBusy === 'string' && en.popupExportBusy.length > 0, 'en key present');
    assert.ok(typeof zh.popupExportBusy === 'string' && zh.popupExportBusy.length > 0, 'zh key present');
});

// ---------- P1-121: loadStoreFailed i18n key ----------
test('p1_h3 - P1-121: loadStoreFailed key exists in en and zh', () => {
    const en = require('../src/core/utils/locales/en.js');
    const zh = require('../src/core/utils/locales/zh.js');
    assert.ok(typeof en.loadStoreFailed === 'string' && en.loadStoreFailed.length > 0, 'en key present');
    assert.ok(typeof zh.loadStoreFailed === 'string' && zh.loadStoreFailed.length > 0, 'zh key present');
});

// ---------- Direct-write modal mutex (decisionMade guards the observer) ----------
test('p1_h3 - direct-write: decisionMade guards the modal observer', () => {
    const src = SRC('ui/options/modules/optionsExport.ts');
    assert.ok(src.includes('decisionMade'), 'decisionMade flag exists');
    assert.ok(/!decisionMade\)\s*settleDecision\(\)/.test(src), 'observer only settles when no decision was made (Esc/X)');
    const folderCb = src.indexOf('async () => {\n                        decisionMade = true;');
    assert.ok(folderCb !== -1, 'folder-choice callback sets decisionMade synchronously at the top');
    assert.ok(src.includes('await decisionPromise'), 'exportSelected waits for the user decision');
});
