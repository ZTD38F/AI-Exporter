/**
 * P1-A 组回归测试 —— 2026-09-15 代码审查「凭证与跨 world 消息安全」(P1-001~P1-010)。
 *
 * 运行: node -r ./tests/ts_register.js --test tests/p1_a_regressions.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function readSrc(rel: string): string {
    return fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
}

// ---------------------------------------------------------------- P1-001
test('P1-001: credential postMessage carries an honest threat-model note (broadcast, not private)', () => {
    const src = readSrc('content/hookCredentials.ts');
    assert.ok(src.includes('broadcast, not a private channel'), 'missing honest broadcast note');
    assert.ok(src.includes('targetOrigin is locked'), 'missing targetOrigin note');
});

// ---------------------------------------------------------------- P1-002
test('P1-002: bl is never written to page-readable localStorage', () => {
    const src = readSrc('content/bootstrap.ts');
    assert.ok(!src.includes('__gemExporterBl'), 'localStorage __gemExporterBl write still present');
});

// ---------------------------------------------------------------- P1-003
test('P1-003: credential logs are dev-gated and carry lengths only', () => {
    const src = readSrc('content/bootstrap.ts');
    assert.ok(!src.includes('atFromPage.slice(0, 12)'), 'raw at prefix still logged');
    assert.ok(!src.includes("console.log('[Gemini Exporter] bl refreshed', blFromPage)"), 'raw bl value still logged');
    assert.ok(src.includes("'atLen', atFromPage.length"), 'expected length-only at log');
    assert.ok(src.includes("'blLen', blFromPage.length"), 'expected length-only bl log');
});

// ---------------------------------------------------------------- P1-004
test('P1-004: messageBridge states the real threat model (source===window does not authenticate)', () => {
    const src = readSrc('content/messageBridge.ts');
    assert.ok(src.includes('does NOT authenticate the sender'), 'missing honest threat-model note');
});

// ---------------------------------------------------------------- P1-005
test('P1-005: GEMINI_CREDENTIALS listener treats payload as untrusted; empty at never clobbers stored at', () => {
    const src = readSrc('content/bootstrap.ts');
    assert.ok(src.includes('treat the payload as'), 'missing untrusted-payload note');
    assert.ok(src.includes('at: p.at || old.at'), 'empty at could clobber the stored credential');
});

// ---------------------------------------------------------------- P1-006
test('P1-006: message router allowlists asset URLs before cookie-authenticated fetch', () => {
    const src = readSrc('content/messageRouter.ts');
    assert.ok(!src.includes('sid !== ownId'), 'sender.id check should be gone (non-threat)');
    assert.ok(src.includes('isAllowedAssetUrl'), 'URL allowlist helper missing');
    for (const action of ['getFileBlob', 'getImageBlob', 'downloadAssetDirect']) {
        const i = src.indexOf(`msg.action === '${action}'`);
        assert.ok(i >= 0, `handler for ${action} missing`);
        const block = src.slice(i, i + 700);
        assert.ok(block.includes('blocked: asset url not allowlisted'), `${action} not gated by URL allowlist`);
    }
});

// ---------------------------------------------------------------- P1-007
test('P1-007: error diagnostics carry credential lengths/presence only', () => {
    const src = readSrc('core/api/geminiClient.ts');
    assert.ok(!src.includes('bl:${cred.bl'), 'bl prefix still leaked into error text');
    assert.ok(!src.includes('sid:${cred.sid'), 'sid prefix still leaked into error text');
    assert.ok(src.includes('sidLen:'), 'expected sidLen in diagnostics');
    assert.ok(src.includes("hasBl:${cred.bl ? 'yes' : 'no'}"), 'expected hasBl presence flag');
});

// ---------------------------------------------------------------- P1-009
// (P1-008 sender.id check removed: chrome.runtime.onMessage is not reachable
// from web pages; the remaining cross-extension sender is a non-threat —
// a malicious extension installed on the machine is a bigger problem than
// anything a sender.id check stops.)
test('P1-009: reloadGeminiTab only reloads Gemini tabs', () => {
    const src = readSrc('background/background.ts');
    assert.ok(!src.includes('sid !== ownId'), 'P1-008 sender.id check should be gone');
    assert.ok(src.includes('not a gemini tab'), 'tab URL validation missing');
    assert.ok(src.includes("startsWith('https://gemini.google.com/')"), 'gemini URL prefix check missing');
});

// ---------------------------------------------------------------- P1-010（行为测试 + 可反向验证）
test('P1-010: self-healed bl is written back to storage (not memory-only)', async () => {
    const CredManager = require('../src/core/api/client/credentialManager.js').default;
    const resolveCred = CredManager.resolveCred;
    assert.ok(typeof resolveCred === 'function', 'resolveCred not exported');

    const setCalls: any[] = [];
    const stored: any = {
        gemini_credentials_map: {
            sid1: { sid: 'sid1', at: 'at-value', bl: '', accountSlot: 'default', lastUsed: 1 }
        }
    };
    (globalThis as any).chrome = {
        storage: {
            session: {
                get: async (keys: string[]) => {
                    const o: any = {};
                    for (const k of keys) o[k] = stored[k];
                    return o;
                },
                set: async (obj: any) => { Object.assign(stored, obj); setCalls.push(obj); }
            },
            local: { remove: async () => {} }
        }
    };
    (globalThis as any).document = {};
    (globalThis as any).__gemExporterBl = 'healed-bl-from-page';

    try {
        const cred = await resolveCred();
        assert.ok(setCalls.length > 0, 'healed bl was NOT persisted to storage (memory-only regression)');
        const persisted = setCalls[setCalls.length - 1].gemini_credentials_map;
        assert.ok(persisted && persisted.sid1 && persisted.sid1.bl === 'healed-bl-from-page',
            'persisted map does not contain the healed bl');
        assert.strictEqual(cred.bl, 'healed-bl-from-page');
    } finally {
        delete (globalThis as any).chrome;
        delete (globalThis as any).document;
        delete (globalThis as any).__gemExporterBl;
    }
});
