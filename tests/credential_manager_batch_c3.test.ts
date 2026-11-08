export {};
import type { TestContext } from 'node:test';
const test = require('node:test');
const assert = require('node:assert');

function bustRequireCache(p: string) {
    try {
        delete require.cache[require.resolve(p)];
    } catch { /* ignore */ }
}

function getFreshCredManager() {
    bustRequireCache('../src/l1/client/gemini/api/credStorage.js');
    bustRequireCache('../src/l1/client/gemini/api/credentialManager.js');
    return require('../src/l1/client/gemini/api/credentialManager.js');
}

function makeMockStorage(initialData: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = JSON.parse(JSON.stringify(initialData));
    return {
        data,
        get: async (keys: string[]) => {
            const out: Record<string, unknown> = {};
            for (const k of keys) {
                if (k in data) out[k] = data[k];
            }
            return out;
        },
        set: async (items: Record<string, unknown>) => {
            Object.assign(data, JSON.parse(JSON.stringify(items)));
        },
        remove: async (keys: string[]) => {
            for (const k of keys) {
                delete data[k];
            }
        }
    };
}

test('1. BL extraction precedence and cache: HTML sources only', (t: TestContext) => {
    const credManager = getFreshCredManager();
    const globals = globalThis as Record<string, unknown>;
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    t.after(() => {
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else delete globals.document;
    });

    // Both blCfb2hFromHtml and blAssistantFromHtml present: blCfb2hFromHtml wins
    const docBoth = {
        documentElement: {
            innerHTML: 'start "cfb2h":"bl_primary" middle "bl":"boq_assistant-secondary" end'
        }
    };
    globals.document = docBoth;
    assert.strictEqual(credManager.getBlFromPage(), 'bl_primary', 'blCfb2hFromHtml should take highest precedence');

    // Only blAssistantFromHtml present ("bl":"boq_assistant...")
    const docAssistant = {
        documentElement: {
            innerHTML: 'prefix "bl":"boq_assistant-bard-web-server_2026" suffix'
        }
    };
    globals.document = docAssistant;
    assert.strictEqual(credManager.getBlFromPage(), 'boq_assistant-bard-web-server_2026', 'blAssistantFromHtml should be used when primary pattern absent');

    // A writerless legacy global must not supply BL credentials.
    globals.document = { documentElement: { innerHTML: '<div>no bl tokens here</div>' } };
    assert.strictEqual(credManager.getBlFromPage(), null, 'unmatched HTML must not supply a BL token');
});

test('2. AT extraction precedence: __gemExporterExtractAt -> cache -> _WIZ_global_data -> WIZ_global_data -> script scan -> full HTML -> empty', (t: TestContext) => {
    const credManager = getFreshCredManager();
    const P = require('../src/l1/protocol/gemini/protocol.js').default;
    const globals = globalThis as Record<string, unknown>;
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    t.after(() => {
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else delete globals.document;
    });

    // A. __gemExporterExtractAt wins over everything
    const origExtractAt = (globalThis as Record<string, unknown>).__gemExporterExtractAt;
    try {
        (globalThis as Record<string, unknown>).__gemExporterExtractAt = () => 'at_from_extract_fn';
        assert.strictEqual(credManager.getAtFromPage(), 'at_from_extract_fn', '__gemExporterExtractAt should be highest priority');
    } finally {
        delete (globalThis as Record<string, unknown>).__gemExporterExtractAt;
    }

    // B. _WIZ_global_data wins over WIZ_global_data and scripts
    const origWiz = (globalThis as Record<string, unknown>)._WIZ_global_data;
    const origWiz2 = (globalThis as Record<string, unknown>).WIZ_global_data;
    try {
        (globalThis as Record<string, unknown>)._WIZ_global_data = { [P.TOKENS.AT]: 'at_wiz_1' };
        (globalThis as Record<string, unknown>).WIZ_global_data = { [P.TOKENS.AT]: 'at_wiz_2' };
        const doc = {
            documentElement: { innerHTML: '<html>"SNlM0e":"at_in_html"</html>' }
        };
        globals.document = doc;
        assert.strictEqual(credManager.getAtFromPage(), 'at_wiz_1', '_WIZ_global_data wins over WIZ_global_data');
    } finally {
        delete (globalThis as Record<string, unknown>)._WIZ_global_data;
        delete (globalThis as Record<string, unknown>).WIZ_global_data;
    }

    // C. WIZ_global_data wins over scripts
    try {
        (globalThis as Record<string, unknown>).WIZ_global_data = { [P.TOKENS.AT]: 'at_wiz_plain' };
        const doc = {
            documentElement: { innerHTML: '<html>"SNlM0e":"at_in_html_script"</html>' },
            querySelectorAll: () => [{ textContent: '"SNlM0e":"at_in_script_query"' }]
        };
        globals.document = doc;
        assert.strictEqual(credManager.getAtFromPage(), 'at_wiz_plain', 'WIZ_global_data wins over scripts');
    } finally {
        delete (globalThis as Record<string, unknown>).WIZ_global_data;
    }

    // D. script scan wins over full HTML scan
    const docScript = {
        documentElement: { innerHTML: '<html>"SNlM0e":"at_in_html_tail"</html>' },
        querySelectorAll: () => [{ textContent: 'var a = 1; "SNlM0e":"at_from_query_script";' }]
    };
    globals.document = docScript;
    assert.strictEqual(credManager.getAtFromPage(), 'at_from_query_script', 'querySelectorAll scripts wins over HTML regex');

    // E. full HTML scan when no scripts matched
    const docHtml = {
        documentElement: { innerHTML: '<div>content with "SNlM0e":"at_full_html" in body</div>' },
        querySelectorAll: () => []
    };
    globals.document = docHtml;
    assert.strictEqual(credManager.getAtFromPage(), 'at_full_html', 'full HTML scan fallback');

    // F. empty fallback
    const docNone = {
        documentElement: { innerHTML: '<div>plain text</div>' },
        querySelectorAll: () => []
    };
    globals.document = docNone;
    assert.strictEqual(credManager.getAtFromPage(), '', 'returns empty string when no AT tokens found');
});

test('External Wiz globals reject malformed token values before cache admission', (t: TestContext) => {
    const globals = globalThis as Record<string, unknown>;
    const names = ['document', '__gemExporterExtractAt', '_WIZ_global_data', 'WIZ_global_data'];
    const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
    t.after(() => names.forEach((name, i) => {
        if (previous[i]) Object.defineProperty(globalThis, name, previous[i]);
        else delete globals[name];
    }));

    const P = require('../src/l1/protocol/gemini/protocol.js').default;
    const manager = getFreshCredManager();
    delete globals.__gemExporterExtractAt;
    globals.document = { documentElement: { innerHTML: '<div>no AT token</div>' }, querySelectorAll: () => [] };
    globals._WIZ_global_data = { [P.TOKENS.AT]: 123 };
    globals.WIZ_global_data = { [P.TOKENS.AT]: ['invalid'] };
    assert.equal(manager.getAtFromPage(), '', 'malformed external Wiz values must not be cached as credentials');

    globals.WIZ_global_data = { [P.TOKENS.AT]: 'validated-at' };
    assert.equal(manager.getAtFromPage(), 'validated-at', 'the first valid fallback token is still accepted');
});

test('3. Slot detection: explicit path -> pathname -> u0 to default -> catch to default', () => {
    const credManager = getFreshCredManager();

    // explicit path
    assert.strictEqual(credManager.detectSlot('https://gemini.google.com/u/2/app'), 'u2', 'detects u2 from explicit url');
    assert.strictEqual(credManager.detectSlot('/u/3/app'), 'u3', 'detects u3 from pathname');

    // u0 maps to default
    assert.strictEqual(credManager.detectSlot('/u/0/app'), 'default', 'u0 maps to default');
    assert.strictEqual(credManager.detectSlot('https://gemini.google.com/u/0/'), 'default', 'u0 maps to default');

    // default path without slot
    assert.strictEqual(credManager.detectSlot('/app'), 'default', 'path without /u/N/ maps to default');

    // fallback when invalid/empty
    assert.strictEqual(credManager.detectSlot(''), 'default', 'empty path falls back to default');
    assert.strictEqual(credManager.detectSlot(null), 'default', 'null path falls back to default');
});

test('4. Valid map load from storage', async () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const mock = makeMockStorage({
        gemini_credentials_map: {
            s1: { sid: 's1', at: 'at1', bl: 'bl1', accountSlot: 'default', lastUsed: 1000 },
            s2: { sid: 's2', at: 'at2', bl: 'bl2', accountSlot: 'u1', lastUsed: 2000 }
        }
    });
    (globalThis as Record<string, unknown>).chrome = { storage: { session: mock, local: mock } };
    try {
        const credManager = getFreshCredManager();
        const first = await credManager.resolveCred('s1');
        const second = await credManager.resolveCred('s2');
        assert.strictEqual(first.sid, 's1');
        assert.strictEqual(first.at, 'at1');
        assert.strictEqual(second.accountSlot, 'u1');
        assert.strictEqual(second.lastUsed, 2000);
        assert.strictEqual(Object.keys(mock.data.gemini_credentials_map as object).length, 2);
    } finally {
        (globalThis as Record<string, unknown>).chrome = origChrome;
    }
});

test('C3 review: array-shaped credential map is rejected, never selected or rewritten', async (t: TestContext) => {
    const globals = globalThis as Record<string, unknown>;
    const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    t.after(() => {
        if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
        else delete globals.chrome;
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else delete globals.document;
    });

    const malformed = [{ sid: 'array_sid', at: 'array_at', bl: 'array_bl', accountSlot: 'default' }];
    const mock = makeMockStorage({ gemini_credentials_map: malformed });
    globals.chrome = { storage: { session: mock, local: mock } };
    delete globals.document;

    const manager = getFreshCredManager();
    const resolved = await manager.resolveCred('default');
    assert.notStrictEqual(resolved.sid, 'array_sid', 'positional credentials are not selected');
    assert.strictEqual(resolved.at, '', 'tokens from malformed array map are never reused');
    assert.deepStrictEqual(mock.data.gemini_credentials_map, malformed, 'invalid stored data is not rewritten');
});

test('8. Newest same-slot credential selected by lastUsed ordering', async () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const mock = makeMockStorage({
        gemini_credentials_map: {
            old_cred: { sid: 'old_cred', at: 'at_old', bl: 'bl_common', accountSlot: 'default', lastUsed: 100 },
            mid_cred: { sid: 'mid_cred', at: 'at_mid', bl: 'bl_common', accountSlot: 'default', lastUsed: 500 },
            new_cred: { sid: 'new_cred', at: 'at_new', bl: 'bl_common', accountSlot: 'default', lastUsed: 999 }
        }
    });
    (globalThis as Record<string, unknown>).chrome = { storage: { session: mock, local: mock } };
    try {
        const credManager = getFreshCredManager();
        const resolved = await credManager.resolveCred('default');
        assert.strictEqual(resolved.sid, 'new_cred', 'most recently used credential in slot should be selected');
        assert.strictEqual(resolved.at, 'at_new');
    } finally {
        (globalThis as Record<string, unknown>).chrome = origChrome;
    }
});

test('9. Explicit target SID selection', async () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const mock = makeMockStorage({
        gemini_credentials_map: {
            cred_a: { sid: 'cred_a', at: 'at_a', bl: 'bl_a', accountSlot: 'default', lastUsed: 1000 },
            cred_b: { sid: 'cred_b', at: 'at_b', bl: 'bl_b', accountSlot: 'default', lastUsed: 500 }
        }
    });
    (globalThis as Record<string, unknown>).chrome = { storage: { session: mock, local: mock } };
    try {
        const credManager = getFreshCredManager();
        // Request explicit cred_b even though cred_a is newer
        const resolved = await credManager.resolveCred('cred_b');
        assert.strictEqual(resolved.sid, 'cred_b', 'explicit SID must win');
        assert.strictEqual(resolved.at, 'at_b');
    } finally {
        (globalThis as Record<string, unknown>).chrome = origChrome;
    }
});

test('10. CRITICAL INVARIANT: NEVER borrow credentials from another account slot', async () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const mock = makeMockStorage({
        gemini_credentials_map: {
            cred_default: { sid: 'sid_default', at: 'secret_default_at', bl: 'bl_default', accountSlot: 'default' },
            cred_u1: { sid: 'sid_u1', at: 'secret_u1_at', bl: 'bl_u1', accountSlot: 'u1' }
        }
    });
    (globalThis as Record<string, unknown>).chrome = { storage: { session: mock, local: mock } };
    try {
        const credManager = getFreshCredManager();

        // Request credentials for slot 'u2' which has NO stored credentials
        const resolved = await credManager.resolveCred('u2');

        // MUST NOT borrow sid_default or sid_u1!
        assert.notStrictEqual(resolved.sid, 'sid_default', 'Must never borrow from default slot');
        assert.notStrictEqual(resolved.sid, 'sid_u1', 'Must never borrow from u1 slot');
        assert.notStrictEqual(resolved.at, 'secret_default_at', 'Must never leak tokens from default slot');
        assert.notStrictEqual(resolved.at, 'secret_u1_at', 'Must never leak tokens from u1 slot');
        assert.strictEqual(resolved.accountSlot, 'u2');
    } finally {
        (globalThis as Record<string, unknown>).chrome = origChrome;
    }
});

test('11. Page fallback only for matching slot', async () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const mock = makeMockStorage({
        gemini_credentials_map: {
            cred_default: { sid: 'sid_default', at: 'stored_token', bl: 'bl_default', accountSlot: 'default', lastUsed: 100 }
        }
    });
    (globalThis as Record<string, unknown>).chrome = { storage: { session: mock, local: mock } };
    const P = require('../src/l1/protocol/gemini/protocol.js').default;

    // Simulate page on slot 'default' with page AT token and mock document
    (globalThis as Record<string, unknown>).document = {
        documentElement: { innerHTML: 'page content' }
    };
    (globalThis as Record<string, unknown>)._WIZ_global_data = { [P.TOKENS.AT]: 'live_page_at' };
    try {
        const credManager = getFreshCredManager();

        // When requesting slot 'u3' while on default page (no stored creds for u3):
        // Must NOT attach default page's live_page_at to slot u3!
        const resolvedOtherSlot = await credManager.resolveCred('u3');
        assert.strictEqual(resolvedOtherSlot.accountSlot, 'u3');
        assert.strictEqual(resolvedOtherSlot.at, '', 'Page AT must not be attached to mismatched slot');

        // When page URL matches requested slot (e.g. simulate location on /u/3/app)
        (globalThis as Record<string, unknown>).location = { pathname: '/u/3/app' };
        const resolvedMatchedSlot = await credManager.resolveCred('u3');
        assert.strictEqual(resolvedMatchedSlot.accountSlot, 'u3');
        assert.strictEqual(resolvedMatchedSlot.at, 'live_page_at', 'Page AT attached when page slot matches requested slot');
    } finally {
        delete (globalThis as Record<string, unknown>).location;
        delete (globalThis as Record<string, unknown>)._WIZ_global_data;
        delete (globalThis as Record<string, unknown>).document;
        (globalThis as Record<string, unknown>).chrome = origChrome;
    }
});

test('12. Explicit overrides win over stored values', async () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const mock = makeMockStorage({
        gemini_credentials_map: {
            my_sid: { sid: 'my_sid', at: 'stored_at', bl: 'stored_bl', accountSlot: 'default' }
        }
    });
    (globalThis as Record<string, unknown>).chrome = { storage: { session: mock, local: mock } };
    try {
        const credManager = getFreshCredManager();
        const overrides = {
            at: 'override_at',
            bl: 'override_bl',
            accountSlot: 'override_slot'
        };
        const resolved = await credManager.resolveCred('my_sid', overrides);
        assert.strictEqual(resolved.sid, 'my_sid');
        assert.strictEqual(resolved.at, 'override_at', 'override.at must take precedence');
        assert.strictEqual(resolved.bl, 'override_bl', 'override.bl must take precedence');
        assert.strictEqual(resolved.accountSlot, 'override_slot', 'override.accountSlot must take precedence');
    } finally {
        (globalThis as Record<string, unknown>).chrome = origChrome;
    }
});

test('13. Resolve queue survives prior failure without deadlock', async () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    let failNextLoad = true;
    const mock = {
        get: async () => {
            if (failNextLoad) {
                failNextLoad = false;
                throw new Error('transient storage error');
            }
            return {
                gemini_credentials_map: {
                    healthy_sid: { sid: 'healthy_sid', at: 'healthy_at', bl: 'healthy_bl', accountSlot: 'default' }
                }
            };
        },
        set: async () => {},
        remove: async () => {}
    };
    (globalThis as Record<string, unknown>).chrome = { storage: { session: mock, local: mock } };
    try {
        const credManager = getFreshCredManager();

        // First call fails due to storage error (simulated)
        const call1 = credManager.resolveCred('healthy_sid');
        const res1 = await call1;
        assert.ok(res1, 'first call resolves even on storage error with fallback');

        // Subsequent call succeeds and loads healthy credentials
        const res2 = await credManager.resolveCred('healthy_sid');
        assert.strictEqual(res2.sid, 'healthy_sid');
        assert.strictEqual(res2.at, 'healthy_at');
    } finally {
        (globalThis as Record<string, unknown>).chrome = origChrome;
    }
});

test('14. Missing historical fields remain missing during load and credential resolution', async () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const mock = makeMockStorage({
        gemini_credentials_map: {
            hist_1: { sid: 'hist_1', at: 'tok_1' }
        }
    });
    (globalThis as Record<string, unknown>).chrome = { storage: { session: mock, local: mock } };
    try {
        const credManager = getFreshCredManager();
        const stored = (mock.data.gemini_credentials_map as Record<string, Record<string, unknown>>).hist_1;
        assert.ok(stored, 'entry must exist');
        assert.strictEqual(stored.sid, 'hist_1');
        assert.strictEqual(stored.at, 'tok_1');
        assert.strictEqual(stored.bl, undefined, 'bl must not be synthesized');
        assert.strictEqual(stored.accountSlot, undefined, 'accountSlot must not be synthesized');
        assert.strictEqual(stored.lastUsed, undefined, 'lastUsed must not be synthesized');

        // Reading a credential map must not write back invented metadata.
        const storedMap = mock.data.gemini_credentials_map as Record<string, Record<string, unknown>>;
        assert.strictEqual(storedMap.hist_1.bl, undefined);
        assert.strictEqual(storedMap.hist_1.accountSlot, undefined);
        assert.strictEqual(storedMap.hist_1.lastUsed, undefined);

        // resolveCred on hist_1 must preserve lack of accountSlot and not inject accountSlot: 'default'
        const resolved = await credManager.resolveCred('hist_1');
        assert.strictEqual(resolved.accountSlot, undefined, 'accountSlot must not be synthesized in resolved object');
        assert.strictEqual(resolved.sid, 'hist_1');
    } finally {
        (globalThis as Record<string, unknown>).chrome = origChrome;
    }
});

test('15. Extension metadata remains intact during page BL writeback', async () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const mock = makeMockStorage({
        gemini_credentials_map: {
            ext_1: { sid: 'ext_1', at: 'tok_1', bl: 'ext_1_bl', customMeta: 'custom_123', flags: [1, 2, 3] },
            ext_2: { sid: 'ext_2', at: 'tok_2', accountSlot: 'default', customPluginData: { alpha: true } }
        }
    });
    (globalThis as Record<string, unknown>).chrome = { storage: { session: mock, local: mock } };
    try {
        const credManager = getFreshCredManager();
        (globalThis as Record<string, unknown>).document = {
            documentElement: { innerHTML: '<div>"cfb2h":"bl_backfill_123"</div>' }
        };
        const resolved = await credManager.resolveCred('ext_2');
        assert.strictEqual(resolved.sid, 'ext_2');
        assert.strictEqual(resolved.bl, 'bl_backfill_123');
        const updatedStored = mock.data.gemini_credentials_map as Record<string, Record<string, unknown>>;
        assert.strictEqual(updatedStored.ext_2.bl, 'bl_backfill_123', 'bl backfilled in storage');
        assert.deepStrictEqual(updatedStored.ext_2.customPluginData, { alpha: true }, 'extension data survives bl writeback');
        assert.strictEqual(updatedStored.ext_1.customMeta, 'custom_123', 'unrelated metadata remains unchanged');
        assert.deepStrictEqual(updatedStored.ext_1.flags, [1, 2, 3], 'unrelated array metadata remains unchanged');
    } finally {
        delete (globalThis as Record<string, unknown>).document;
        (globalThis as Record<string, unknown>).chrome = origChrome;
    }
});

test('16. Numeric SID is preserved when resolving stored credentials', async () => {
    const origChrome = (globalThis as Record<string, unknown>).chrome;
    const mock = makeMockStorage({
        gemini_credentials_map: {
            '987654321': { sid: 987654321, at: 'numeric_at', bl: 'numeric_bl', accountSlot: 'default' }
        }
    });
    (globalThis as Record<string, unknown>).chrome = { storage: { session: mock, local: mock } };
    try {
        const credManager = getFreshCredManager();
        const bySid = await credManager.resolveCred('987654321');
        assert.strictEqual(bySid.sid, 987654321);
        assert.strictEqual(bySid.at, 'numeric_at');
        assert.strictEqual(bySid.bl, 'numeric_bl');
        const bySlot = await credManager.resolveCred('default');
        assert.strictEqual(bySlot.sid, 987654321);
        assert.strictEqual(bySlot.at, 'numeric_at');
        assert.deepStrictEqual(mock.data.gemini_credentials_map, {
            '987654321': { sid: 987654321, at: 'numeric_at', bl: 'numeric_bl', accountSlot: 'default' }
        });
    } finally {
        (globalThis as Record<string, unknown>).chrome = origChrome;
    }
});

test('C3 review: existing entries without SID are not repaired on either selection path', async () => {
    const glob = globalThis as Record<string, unknown>;
    const previous = glob.chrome;
    const entry = { at: 'kept_at', bl: 'kept_bl', lastUsed: '100', extension: { retained: true } };
    const mock = makeMockStorage({ gemini_credentials_map: { stored_key: entry } });
    glob.chrome = { storage: { session: mock, local: mock } };
    try {
        const manager = getFreshCredManager();
        for (const target of ['stored_key', 'default']) {
            const result = await manager.resolveCred(target);
            assert.strictEqual(Object.hasOwn(result, 'sid'), false);
            assert.strictEqual(Object.hasOwn(result, 'accountSlot'), false);
            assert.strictEqual(result.lastUsed, '100');
            assert.deepStrictEqual(result.extension, entry.extension);
        }
        assert.deepStrictEqual(mock.data.gemini_credentials_map, { stored_key: entry });
    } finally { glob.chrome = previous; }
});

test('C3 review: numeric SID HTTP diagnostics use the real SID contract', async () => {
    const glob = globalThis as Record<string, unknown>;
    const previousChrome = glob.chrome;
    const previousFetch = glob.fetch;
    const mock = makeMockStorage({ gemini_credentials_map: {
        '12345': { sid: 12345, at: 'diagnostic_at', bl: 'diagnostic_bl', accountSlot: 'default' }
    } });
    glob.chrome = { storage: { session: mock, local: mock } };
    glob.fetch = async () => new Response('diagnostic failure', { status: 418 });
    try {
        getFreshCredManager();
        bustRequireCache('../src/l1/client/gemini/geminiClient.js');
        const Client = require('../src/l1/client/gemini/geminiClient.js').GeminiAPIClient;
        await assert.rejects(new Client().getConversationList(null, '12345'), /sidLen:5/);
    } finally { glob.chrome = previousChrome; glob.fetch = previousFetch; }
});

test('email cannot route credentials even when a stored key matches it', async () => {
    const glob = globalThis as Record<string, unknown>;
    const previous = glob.chrome;
    const raw = { 'alice@example.com': { sid: 'session', at: 'token', bl: 'build', accountSlot: 'u0' } };
    const mock = makeMockStorage({ gemini_credentials_map: raw });
    glob.chrome = { storage: { session: mock, local: mock } };
    try {
        await assert.rejects(getFreshCredManager().resolveCred('alice@example.com'), /Email is not a credential routing identity/);
        assert.deepEqual(mock.data.gemini_credentials_map, raw);
    } finally { glob.chrome = previous; }
});
