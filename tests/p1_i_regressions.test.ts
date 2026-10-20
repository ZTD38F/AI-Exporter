/**
 * tests/p1_i_regressions.test.ts
 * I 组「协议层与 provider 契约收尾」P1-075~080, P1-084, P1-088/089 回归测试。
 */
import type { GeminiLiveSaveTriggerPayload } from '../src/core/protocol/events.js';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const Proto = require('../src/core/protocol/protocol.js');
const { ProviderRegistryClass } = require('../src/core/provider/providerRegistry.js');
const { GeminiProvider } = require('../src/core/provider/gemini/geminiProvider.js');

function fakeProvider(id: string, opts: { matchesUrl?: (u: string) => boolean; hostPatterns?: string[] } = {}) {
    const p: any = { id, name: id, hostPatterns: opts.hostPatterns || [] };
    if (opts.matchesUrl) p.matchesUrl = opts.matchesUrl;
    return p;
}

// ---------------------------------------------------------------- P1-075
test('P1-075 - second DELETION_ANCHOR requires the c_ prefix (anchored discipline)', () => {
    // Unquoted GzXR5e followed by a BARE hex token (no c_) must NOT match:
    // this is exactly the false-positive the old (?:c_)? allowed.
    const decoy = 'GzXR5e something happened deadbeef00112233 nearby';
    assert.strictEqual(decoy.match(Proto.DELETION_ANCHORS[1]), null);

    // Unquoted GzXR5e followed by a real c_-prefixed id still matches (fallback kept).
    const real = '...GzXR5e...c_feedface12345678...';
    const m = real.match(Proto.DELETION_ANCHORS[1]);
    assert.ok(m, 'unquoted anchor must still extract c_-prefixed ids');
    assert.strictEqual(m![1], 'feedface12345678');

    // Quoted form unchanged.
    const quoted = `[["wrb.fr","GzXR5e","c_aabbccdd11223344",null]]`;
    const m0 = quoted.match(Proto.DELETION_ANCHORS[0]);
    assert.ok(m0);
    assert.strictEqual(m0![1], 'aabbccdd11223344');
});

// ---------------------------------------------------------------- P1-077
test('P1-077 - typed self-mounts, no as-any escape hatches', () => {
    assert.strictEqual(Proto.GeminiProtocol, Proto, 'self mount intact');
    assert.strictEqual(Proto.default, Proto, 'default mount intact');
    assert.strictEqual(Proto.CrossWorldEvents, Proto.EVENTS, 'events mount intact');
    // Phase 1c: the globalThis mount was intentionally removed — protocol now
    // resolves via static import (or the __setModuleOverride test seam).
    assert.strictEqual((globalThis as any).GeminiProtocol, undefined, 'globalThis mount must stay gone');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/core/protocol/protocol.ts'), 'utf8');
    assert.ok(!/^\s*\/\/\s*@ts-ignore/m.test(src), '@ts-ignore directive must be gone');
    const codeOnly = src.replace(/\/\/.*$/gm, '');
    assert.ok(!codeOnly.includes('as any'), 'as any casts must be gone from protocol.ts');
});

// ------------------------------------------------------------- P1-078/079/080
test('P1-078 - duplicate registration of a DIFFERENT instance rejects replacement', () => {
    const registry = new ProviderRegistryClass();
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
    try {
        const first = fakeProvider('dup');
        const second = fakeProvider('dup');
        registry.register(first);
        // Same instance re-registered: silent no-op, no warning.
        registry.register(first);
        assert.strictEqual(warnings.length, 0, 'same-instance re-register must stay silent');
        // Multi-provider AI Exporter intentionally requires explicit unregister
        // rather than silently replacing an existing registered provider.
        assert.throws(() => registry.register(second), /already registered/);
        assert.strictEqual(warnings.length, 0, 'strict rejection emits no warning');
        assert.strictEqual(registry.get('dup'), first);
    } finally {
        console.warn = origWarn;
    }
});

test('P1-079 - setDefaultProviderId rejects unregistered ids', () => {
    const registry = new ProviderRegistryClass();
    assert.throws(() => registry.setDefaultProviderId('ghost'), /unregistered id "ghost"/);
    registry.register(fakeProvider('real'));
    registry.setDefaultProviderId('real');
    assert.strictEqual(registry.getDefault()?.id, 'real');
});

test('P1-080 - explicit matchesUrl=false is never overruled by hostPatterns', () => {
    const registry = new ProviderRegistryClass();
    registry.register(fakeProvider('strict', {
        matchesUrl: () => false, // explicit refusal...
        hostPatterns: ['https://example.com/*'], // ...with a broad pattern that must NOT win
    }));
    registry.register(fakeProvider('legacy', {
        hostPatterns: ['https://legacy.example.net/*'], // no matchesUrl at all
    }));
    assert.strictEqual(
        registry.findByUrl('https://example.com/page'), undefined,
        'explicit refusal must not fall back to hostPatterns'
    );
    assert.strictEqual(
        registry.findByUrl('https://legacy.example.net/x')?.id, 'legacy',
        'pattern-only providers still resolve via hostPatterns'
    );
});

// ------------------------------------------------------------- P1-081/082 (fixed by #356, locked here; Phase E: dormant)


// ---------------------------------------------------------------- P1-084
test('P1-084 - live-save trigger payload is an explicit contract', () => {
    // Type-level lock (checked by tsc): only cid/reason/mockMode are legal.
    const payload: GeminiLiveSaveTriggerPayload = { cid: 'c_1', reason: 'turn_complete', mockMode: true };
    // messageBridge-style destructuring forwards a well-typed options bag.
    function fakeExecuteLiveSave(cid: string, reason: string, options: { mockMode?: boolean }): boolean {
        return !!cid && reason === 'turn_complete' && options.mockMode === true;
    }
    const { cid, reason, ...options } = payload;
    assert.ok(fakeExecuteLiveSave(cid, reason || 'turn_complete', options));
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/core/protocol/events.ts'), 'utf8');
    assert.ok(!/^\s*\[key: string\]: any;/m.test(src), 'index signature must be gone from the payload');
});

// ---------------------------------------------------------------- P1-085




// ---------------------------------------------------------------- P1-086


// ---------------------------------------------------------------- P1-087


// ---------------------------------------------------------------- P1-088
test('P1-088 - checkReadiness never passes the slot id off as the account name', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/core/provider/gemini/geminiProvider.ts'), 'utf8');
    assert.ok(!src.includes('accountName: slot'), 'slot id must not masquerade as accountName');
    // Runtime: stub credential resolution to force the ready:true branch.
    const credMgr = require('../src/core/api/client/credentialManager.js').default;
    const orig = credMgr.resolveCred;
    credMgr.resolveCred = async () => ({ sid: 's', at: 'a', bl: 'b', accountSlot: 'u0' });
    try {
        const readiness = await new GeminiProvider().checkReadiness({ accountSlot: 'u0' });
        assert.strictEqual(readiness.ready, true);
        assert.strictEqual(readiness.accountSlot, 'u0');
        assert.ok(
            readiness.accountName === undefined || readiness.accountName === null,
            `accountName must be absent/null, got: ${readiness.accountName}`
        );
    } finally {
        credMgr.resolveCred = orig;
    }
});

// ---------------------------------------------------------------- P1-089
test('P1-089 - gemini hostPatterns cover everything matchesUrl accepts', () => {
    const gemini = new GeminiProvider();
    assert.ok(gemini.matchesUrl('https://gemini.google.com/app'), 'gemini host matches');
    assert.ok(gemini.matchesUrl('https://bard.google.com/app'), 'legacy bard host matches');
    for (const host of ['https://gemini.google.com/', 'https://bard.google.com/']) {
        const registry = new ProviderRegistryClass();
        registry.register(gemini);
        assert.strictEqual(registry.findByUrl(host)?.id, 'gemini', `findByUrl resolves ${host}`);
    }
    assert.ok(
        (gemini.hostPatterns as string[]).includes('https://bard.google.com/*'),
        'hostPatterns must include the bard pattern'
    );
    assert.ok(!gemini.matchesUrl('https://chatgpt.com'), 'unrelated host still refused');
});

// ------------------------------------------------------------- P1-043/044 (Phase E: dormant — no pagination walk left)



