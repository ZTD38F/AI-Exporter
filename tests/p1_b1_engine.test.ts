export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

// ---------- P1-011: per-chat error isolation ----------
test('p1_b1 - P1-011: per-chat body wrapped in try/catch', () => {
    const src = SRC('core/engine/export/exportOrchestrator.ts');
    assert.ok(src.includes('failedChats.push({ id: failId'), 'failed chat recorded');
});

test('p1_b1 - P1-011: Promise.all has scheduler-level guard', () => {
    const src = SRC('core/engine/export/exportOrchestrator.ts');
    assert.ok(/try\s*\{\s*await Promise\.all\(exportWorkers\)/.test(src), 'Promise.all wrapped in try/catch');
});

// ---------- P1-013: awaited finalize ----------
test('p1_b1 - P1-013: finalizeChatExport calls are awaited', () => {
    const src = SRC('core/engine/export/exportOrchestrator.ts');
    const unawaited = (src.match(/(?<!await )finalizeChatExport\(chat\.id\)/g) || []).length;
    assert.strictEqual(unawaited, 0, 'all finalizeChatExport(chat.id) calls must be awaited');
});

// ---------- P1-014: persist-first ----------
test('p1_b1 - P1-014: storage write happens before in-memory bookkeeping', () => {
    const src = SRC('core/engine/export/sessionRecovery.ts');
    const writeIdx = src.indexOf('saveExportRecord');
    const memIdx = src.indexOf('finalizedChatsSet.add(targetNid)');
    assert.ok(writeIdx !== -1 && memIdx !== -1, 'both sections present');
    assert.ok(writeIdx < memIdx, 'storage write must come before in-memory mutation');
    assert.ok(src.includes('throw e;'), 'failure propagates instead of being swallowed');
});

// ---------- P1-015: serialized session status ----------
test('p1_b1 - P1-015: updateSessionStatus serialized via chain', () => {
    const src = SRC('core/engine/export/sessionRecovery.ts');
    assert.ok(src.includes('sessionStatusWriteChain'), 'write chain exists');
});

// ---------- P1-016: attachment consumer safety net ----------
test('p1_b1 - P1-016: tasks carry __assetMeta', () => {
    const src = SRC('core/engine/export/exportOrchestrator.ts');
    assert.ok(src.includes('__assetMeta'), 'metadata attached to tasks');
});

test('p1_b1 - P1-016: consumer catch decrements pending and records failure', () => {
    const src = SRC('core/engine/export/exportOrchestrator.ts');
    assert.ok(/const meta = \(task as any\)\?\.__assetMeta/.test(src), 'consumer reads metadata');
    assert.ok(src.includes('pendingAssetsPerChat.set(meta.nid, left)'), 'pending count decremented on throw');
    assert.ok(src.includes('failedAttachments.push({'), 'failure recorded');
});
