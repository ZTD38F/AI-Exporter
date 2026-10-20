export {};
const test = require('node:test');
const assert = require('node:assert');

const { payloadToMs, extractInnerPayload } = require('../src/core/api/parser/payload.js');
const { resolveDetailTitle } = require('../src/core/utils/titleUtils.js');

test('payloadToMs - converts JSPB timestamp representations to milliseconds', () => {
    // 1. [seconds, nanos] tuple
    assert.strictEqual(payloadToMs([1700000000, 500000000]), 1700000000500);
    assert.strictEqual(payloadToMs([1700000000, 0]), 1700000000000);
    assert.strictEqual(payloadToMs([1700000000]), 1700000000000);

    // 2. [milliseconds] tuple (> 1e11)
    assert.strictEqual(payloadToMs([1700000000000]), 1700000000000);

    // 3. Numeric seconds (> 1e9, <= 1e11)
    assert.strictEqual(payloadToMs(1700000000), 1700000000000);

    // 4. Numeric milliseconds (> 1e11)
    assert.strictEqual(payloadToMs(1700000000123), 1700000000123);

    // 5. Invalid / falsy inputs
    assert.strictEqual(payloadToMs(null), null);
    assert.strictEqual(payloadToMs(undefined), null);
    assert.strictEqual(payloadToMs(0), null);
    assert.strictEqual(payloadToMs("1700000000"), null);
    assert.strictEqual(payloadToMs([100]), null);
});

test('extractInnerPayload - standard WRB matching', () => {
    const mockTop = [
        ["wrb.fr", "MaZiqc", JSON.stringify([null, [["c_123", "Title 1"]]])],
        ["wrb.fr", "otherRpc", "{}"]
    ];

    const res = extractInnerPayload(mockTop, {
        wrb: "wrb.fr",
        rpcId: "MaZiqc"
    });

    assert.strictEqual(res.isStandardWrb, true);
    assert.strictEqual(res.bardError, null);
    assert.ok(res.inner);
    assert.strictEqual(res.inner[1][0][0], "c_123");
});

test('extractInnerPayload - supports array of target RPC IDs', () => {
    const mockTop = [
        ["wrb.fr", "hXcbkd", JSON.stringify([null, [["c_legacy", "Legacy Title"]]])]
    ];

    const res = extractInnerPayload(mockTop, {
        wrb: "wrb.fr",
        rpcId: ["MaZiqc", "hXcbkd"]
    });

    assert.strictEqual(res.isStandardWrb, true);
    assert.ok(res.inner);
    assert.strictEqual(res.inner[1][0][0], "c_legacy");
});

test('extractInnerPayload - heuristic fallback scanning', () => {
    const innerData = [["turn1"]];
    const mockTop = [
        ["unknown_prefix", "unknown_rpc", JSON.stringify(innerData)]
    ];

    const res = extractInnerPayload(mockTop, {
        wrb: "wrb.fr",
        rpcId: "hNvQHb",
        heuristicFilter: (s: string) => s.startsWith("[[")
    });

    assert.strictEqual(res.isStandardWrb, false);
    assert.strictEqual(res.bardError, null);
    assert.deepStrictEqual(res.inner, innerData);
});

test('extractInnerPayload - BardErrorInfo extraction', () => {
    const mockTop = [
        ["wrb.fr", "error_rpc", null, null, null, ["generic", "BardErrorInfo: quota exceeded"]]
    ];

    const res = extractInnerPayload(mockTop, {
        wrb: "wrb.fr",
        rpcId: "MaZiqc"
    });

    assert.strictEqual(res.inner, null);
    assert.strictEqual(res.innerStr, null);
    assert.ok(res.bardError);
    assert.ok(res.bardError.includes("BardErrorInfo"));
});

test('resolveDetailTitle - sniffs valid user prompt', () => {
    const messages = [
        { role: 'user', content: 'Quantum computing and superconducting qubits in 2026\nSecond line' },
        { role: 'model', content: 'Here is a detailed explanation...' }
    ];

    const result = resolveDetailTitle(messages, 'c_12345');
    assert.ok(result);
    assert.strictEqual(result.source, 'sniff');
    assert.strictEqual(result.title, 'Quantum computing and superconducting qubits in 2026 Second');
});

test('resolveDetailTitle - returns null for empty, placeholder, or generic user messages', () => {
    // 1. Empty or non-array
    assert.strictEqual(resolveDetailTitle(null, 'c_123'), null);
    assert.strictEqual(resolveDetailTitle([], 'c_123'), null);

    // 2. Only generic brand / placeholder
    assert.strictEqual(resolveDetailTitle([{ role: 'user', content: 'Gemini' }], 'c_123'), null);
    assert.strictEqual(resolveDetailTitle([{ role: 'user', content: 'Untitled' }], 'c_123'), null);
    assert.strictEqual(resolveDetailTitle([{ role: 'user', content: ' ' }], 'c_123'), null);

    // 3. Only model message
    assert.strictEqual(resolveDetailTitle([{ role: 'model', content: 'Hello user' }], 'c_123'), null);
});
