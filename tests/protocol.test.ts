// protocol.test.js — protocol anti-corruption layer contract tests (Phase 1).
// Pins the single source of truth: RPC names, token patterns, BL fallback,
// sliding-window limits, deletion anchors, and the _reqid convention.

import test from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import Proto from '../src/core/protocol/protocol.js';


test('protocol - RPC endpoint names are centralized and match known values', () => {
    assert.strictEqual(Proto.WRB, 'wrb.fr');
    assert.strictEqual(Proto.RPCS.LIST, 'MaZiqc');
    assert.strictEqual(Proto.RPCS.DETAIL, 'hNvQHb');
    assert.strictEqual(Proto.RPCS.LEGACY_LIST, 'b7Lged');
    assert.strictEqual(Proto.RPCS.DELETE, 'GzXR5e');
    assert.strictEqual(Proto.RPCS.GEMS, 'CNgdBe');
});

test('protocol - token keys and extraction patterns are single-sourced', () => {
    assert.strictEqual(Proto.TOKENS.AT, 'SNlM0e');
    assert.strictEqual(Proto.TOKENS.BL, 'cfb2h');

    const html = '<script>var x = {"SNlM0e": "ATToken123456789", "bl": "boq_assistant-bard-web-server_20260901.00_p1"};</script>';
    assert.strictEqual(html.match(Proto.TOKEN_PATTERNS.atFromScript)![1], 'ATToken123456789');
    assert.strictEqual(html.match(Proto.TOKEN_PATTERNS.blKeyFromScript)![1], 'boq_assistant-bard-web-server_20260901.00_p1');
    assert.strictEqual(html.match(Proto.TOKEN_PATTERNS.boqBuildFromScript)![0], 'boq_assistant-bard-web-server_20260901.00_p1');

    const htmlDoc = '<html><head><script>"cfb2h":"boq_assistant-bard-web-server_20260901.00_p1","bl":"boq_assistant-bard-web-server_20260901.00_p1"</script></head></html>';
    assert.strictEqual(htmlDoc.match(Proto.TOKEN_PATTERNS.blCfb2hFromHtml)![1], 'boq_assistant-bard-web-server_20260901.00_p1');
    assert.strictEqual(htmlDoc.match(Proto.TOKEN_PATTERNS.blAssistantFromHtml)![1], 'boq_assistant-bard-web-server_20260901.00_p1');

});

test('protocol - BL_FALLBACK is the single hardcoded build label and token literals are removed from client', () => {
    assert.ok(Proto.BL_FALLBACK.startsWith('boq_assistant-bard-web-server_'));
    assert.strictEqual(typeof Proto.BL_FALLBACK, 'string');
    // The old duplicated literals must stay gone from consumers.
    for (const f of ['src/core/api/geminiClient.ts', 'src/content/bootstrap.ts']) {

        const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        assert.ok(!code.includes('boq_assistant-bard-web-server_2026'), `${f} must not hardcode the build label`);
    }
    const clientCode = fs.readFileSync(path.join(__dirname, '..', 'src/core/api/geminiClient.js'), 'utf8');
    assert.ok(!clientCode.includes('"SNlM0e"'), 'geminiClient.js must not hardcode "SNlM0e"');
    assert.ok(!clientCode.includes('"cfb2h"'), 'geminiClient.js must not hardcode "cfb2h"');
});

test('protocol - LIMITS constants unify the sliding-window checks', () => {
    assert.strictEqual(Proto.LIMITS.SLIDING_WINDOW, 500);
    assert.strictEqual(Proto.LIMITS.SERVER_LIMIT_TEXT, '600条');
});

test('protocol - deletion anchors match the GzXR5e-anchored id and reject decoys', () => {
    const REAL = 'deadbeef00112233';
    const DECOY = 'aabbccdd11223344';

    // Anchored payload: id directly after the delete-RPC name.
    const anchored = `f.req=[["${DECOY}"],["GzXR5e","c_${REAL}"]]`;
    const m1 = anchored.match(Proto.DELETION_ANCHORS[0]);
    assert.strictEqual(m1![1], REAL, 'anchor 1 must extract the id following the delete-RPC name');

    // Quoted-payload shape (response body form).
    const quoted = `)]}'\n\n[["wrb.fr","GzXR5e","c_feedface12345678",null]]`;
    const m2 = quoted.match(Proto.DELETION_ANCHORS[0]) || quoted.match(Proto.DELETION_ANCHORS[1]);
    assert.strictEqual(m2![1], 'feedface12345678', 'anchored extraction must work on the response shape');


    // A hex token with no delete-RPC anchor must never match.
    const noAnchor = 'f.req=[["MaZiqc","aabbccdd11223344"]]';
    assert.strictEqual(noAnchor.match(Proto.DELETION_ANCHORS[0]), null);
    assert.strictEqual(noAnchor.match(Proto.DELETION_ANCHORS[1]), null);
});

test('protocol - reqid generator increments (frontend fingerprint convention)', () => {
    const next = Proto.createReqidGenerator();
    const a = Number(next());
    const b = Number(next());
    const c = Number(next());
    assert.ok(a >= 100000 && a < 1000000, 'reqid starts from a random 6-digit base');
    assert.strictEqual(b, a + 1, 'reqid must increment by 1, not re-randomize');
    assert.strictEqual(c, a + 2, 'reqid must keep incrementing');
});
