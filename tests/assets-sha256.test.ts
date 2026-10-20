/**
 * tests/assets-sha256.test.ts
 * Tier 1 tests for the Web Crypto SHA-256 adapter
 * (src/core/export/assets/sha256.ts).
 *
 * The handwritten compression implementation was replaced by
 * crypto.subtle.digest('SHA-256', ...); the project owns only the
 * bytes-to-lowercase-hex adapter. Node's crypto module is the independent
 * oracle for digest equality.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');

const { sha256Hex } = require('../src/core/export/assets/sha256.js');
const { decodeDataUrlAsset } = require('../src/core/export/assets/dataUrl.js');

function oracle(bytes: Uint8Array): string {
    return nodeCrypto.createHash('sha256').update(bytes).digest('hex');
}

test('known SHA-256 vectors: empty input and short ASCII', async () => {
    assert.strictEqual(
        await sha256Hex(new Uint8Array(0)),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    assert.strictEqual(
        await sha256Hex(Buffer.from('abc', 'utf8')),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
});

test('output is always lowercase 64-char hex', async () => {
    for (const bytes of [
        new Uint8Array(0),
        Buffer.from('hello world', 'utf8'),
        new Uint8Array([0x00, 0xff, 0x00, 0xff]),
    ]) {
        const hex = await sha256Hex(bytes);
        assert.match(hex, /^[0-9a-f]{64}$/, `digest must be lowercase 64-char hex`);
    }
});

test('binary bytes containing 0x00 and 0xff match the oracle', async () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x13, 0x00, 0xfe, 0xff, 0x00, 0x42]);
    assert.strictEqual(await sha256Hex(bytes), oracle(bytes));
});

test('multi-block input (> 64 bytes) matches the oracle', async () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    assert.strictEqual(await sha256Hex(bytes), oracle(bytes));
});

test('offset views digest exactly the view bytes', async () => {
    const full = new Uint8Array([9, 9, 0x00, 0xff, 0x42, 9, 9]);
    const view = full.subarray(2, 5);
    assert.strictEqual(view.byteOffset, 2);
    assert.strictEqual(await sha256Hex(view), oracle(new Uint8Array([0x00, 0xff, 0x42])));
});

test('data: URL asset digest/storageRef are byte-identical to the old implementation', async () => {
    // 1x1 transparent PNG; digest recorded from the pre-migration implementation.
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const expected = 'c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77';
    const bytes = Buffer.from(pngB64, 'base64');
    assert.strictEqual(oracle(bytes), expected, 'oracle agrees with the recorded fixture');
    const decoded: any = await decodeDataUrlAsset(`data:image/png;base64,${pngB64}`);
    assert.ok(decoded.ok);
    assert.strictEqual(decoded.sha256, expected);
    assert.strictEqual(decoded.storageRef, `assets/sha256/c4/14/${expected}.png`);
});

test('production primitive is Web Crypto, not a handwritten round implementation', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'core', 'export', 'assets', 'sha256.ts'),
        'utf8',
    );
    assert.ok(src.includes("crypto.subtle.digest('SHA-256'"), 'must call crypto.subtle.digest("SHA-256", ...)');
    assert.ok(!src.includes('0x428a2f98'), 'round constants must be gone');
    assert.ok(!/rotr|compression round/i.test(src), 'compression-round code must be gone');
});

test('no crypto npm dependency is introduced', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    assert.ok(
        !Object.keys(deps).some((name) => /crypto|sha|hash/i.test(name)),
        'no crypto-related npm dependency may be added',
    );
});
