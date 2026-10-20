/**
 * tests/canonical-contract.test.ts
 * Tier 1 contract tests for the canonical layer (F2a).
 *
 * Covers the integration doc section 3 exit gates for F2a:
 * positive + negative structural cases, unknown round-trip, message-order
 * round-trip, title non-regression, and resource/URL/size validation.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const canonical = require('../src/core/export/canonical/index.js');
const {
    validateBundle,
    resolveTitle,
    titleAuthorityRank,
    extractBlockText,
    classifyAssetAvailability,
    resolveAssetBytes,
    CANONICAL_TITLE_TIER_RANK,
} = canonical;

const fixtureDir = path.join(__dirname, 'fixtures', 'canonical');
const loadFixture = (name: string): any =>
    JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
const clone = (o: any): any => JSON.parse(JSON.stringify(o));
const errorsOf = (diags: any[]): any[] => diags.filter((d) => d.severity === 'error');

const rich = () => loadFixture('rich-conversation.json');
const unknownFx = () => loadFixture('unknown-roundtrip.json');

// ---------------------------------------------------------------- fixtures
test('all canonical fixtures validate with zero errors', () => {
    for (const name of ['rich-conversation.json', 'unknown-roundtrip.json']) {
        const diags = validateBundle(loadFixture(name));
        assert.deepStrictEqual(errorsOf(diags), [], `${name} should have no validation errors, got: ${JSON.stringify(diags)}`);
    }
});

test('versioned JSON schema resource is present and parses', () => {
    const schemaPath = path.join(__dirname, '..', 'src', 'core', 'export', 'canonical', 'resources', 'canonical-conversation-v1.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    assert.strictEqual(schema.title, 'Gemini Exporter Canonical Conversation Bundle v1');
    assert.ok(schema.$id || schema.$schema, 'schema carries an identifier');
});

test('representation independence: no thought block carries view state', () => {
    const walk = (o: any): void => {
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (o && typeof o === 'object') {
            assert.ok(!('initiallyCollapsed' in o), 'canonical data must not contain initiallyCollapsed');
            Object.values(o).forEach(walk);
        }
    };
    walk(rich());
});

test('validator rejects missing and duplicate message IDs', () => {
    const bundle = rich();
    bundle.conversation.messages.push(clone(bundle.conversation.messages[0]));
    assert.ok(errorsOf(validateBundle(bundle)).some((d: any) => d.code === 'MSG_DUP_ID'));
    for (const id of [undefined, '', 123]) {
        const invalid = rich();
        invalid.conversation.messages[0].id = id;
        assert.ok(errorsOf(validateBundle(invalid)).some((d: any) => d.code === 'MSG_BAD_ID'));
    }
});

// ---------------------------------------------------------- title authority
test('low-authority observation cannot downgrade a high-authority title', () => {
    let title = resolveTitle([{ value: 'RPC权威标题', source: 'rpc' }]);
    assert.ok(title);
    title = resolveTitle([title!, { value: 'sniff旧标题', source: 'sniff' }]);
    assert.strictEqual(title!.value, 'RPC权威标题');
    assert.strictEqual(title!.source, 'rpc');
});

test('higher-authority observation upgrades the title (no regression)', () => {
    let title = resolveTitle([{ value: 'Takeout旧标题', source: 'takeout' }]);
    assert.ok(title);
    title = resolveTitle([title!, { value: 'RPC新标题', source: 'rpc' }]);
    assert.strictEqual(title!.value, 'RPC新标题');
    assert.strictEqual(title!.source, 'rpc');
});

test('same-tier newer observation overwrites (repo setTitleBySource semantics)', () => {
    let title = resolveTitle([{ value: 'DOM旧标题', source: 'dom', observedAt: '2026-01-01T00:00:00Z' }]);
    assert.ok(title);
    title = resolveTitle([title!, { value: 'DOM新标题', source: 'dom', observedAt: '2026-02-01T00:00:00Z' }]);
    assert.strictEqual(title!.value, 'DOM新标题');
});

test('same-tier older observation can never overwrite a newer title', () => {
    let title = resolveTitle([{ value: 'DOM新标题', source: 'dom', observedAt: '2026-02-01T00:00:00Z' }]);
    assert.ok(title);
    title = resolveTitle([title!, { value: 'DOM旧标题', source: 'dom', observedAt: '2026-01-01T00:00:00Z' }]);
    assert.strictEqual(title!.value, 'DOM新标题');
});

test('same-tier: candidate with a timestamp beats one without', () => {
    const title = resolveTitle([
        { value: '无时间', source: 'dom' },
        { value: '有时间', source: 'dom', observedAt: '2026-03-01T00:00:00Z' },
    ]);
    assert.strictEqual(title!.value, '有时间');
});

test('same-tier: later insertion wins when both timestamps are missing', () => {
    const title = resolveTitle([
        { value: '先到', source: 'dom' },
        { value: '后到', source: 'dom' },
    ]);
    assert.strictEqual(title!.value, '后到');
});

test('same-tier: later insertion wins on equal timestamps', () => {
    const at = '2026-03-01T00:00:00Z';
    const title = resolveTitle([
        { value: '先到', source: 'dom', observedAt: at },
        { value: '后到', source: 'dom', observedAt: at },
    ]);
    assert.strictEqual(title!.value, '后到');
});

test('authority tier beats recency: newer sniff cannot beat older rpc', () => {
    let title = resolveTitle([{ value: 'RPC旧', source: 'rpc', observedAt: '2026-01-01T00:00:00Z' }]);
    assert.ok(title);
    title = resolveTitle([title!, { value: 'sniff新', source: 'sniff', observedAt: '2026-06-01T00:00:00Z' }]);
    assert.strictEqual(title!.value, 'RPC旧');
    assert.strictEqual(title!.source, 'rpc');
});

test('resolveTitle returns undefined when no candidate is usable', () => {
    assert.strictEqual(resolveTitle([]), undefined);
    assert.strictEqual(resolveTitle([{ value: '   ', source: 'dom' }]), undefined);
});

test('title tiers mirror the repo TITLE_TIER_RANK ladder', () => {
    assert.strictEqual(titleAuthorityRank('rpc'), 50);
    assert.strictEqual(titleAuthorityRank('api-detail'), 50);
    assert.strictEqual(titleAuthorityRank('dom'), 40);
    assert.strictEqual(titleAuthorityRank('takeout'), 30);
    assert.strictEqual(titleAuthorityRank('sniff'), 20);
    assert.strictEqual(titleAuthorityRank('legacy'), 10);
    assert.strictEqual(titleAuthorityRank('default'), 0);
    assert.ok(CANONICAL_TITLE_TIER_RANK.user > CANONICAL_TITLE_TIER_RANK.rpc, 'user title outranks auto-derived');
    assert.strictEqual(resolveTitle([
        { value: 'derived', source: 'derived' },
        { value: 'mine', source: 'user' },
    ])!.value, 'mine');
});

test('unknown source titles resolve to nothing (unknown stays unknown)', () => {
    assert.strictEqual(resolveTitle([]), undefined);
    assert.strictEqual(resolveTitle([{ value: '   ', source: 'rpc' }]), undefined);
});

// -------------------------------------------------------------- unknown
test('unknown block always yields readable fallback, never blank', () => {
    const block = unknownFx().conversation.messages[0].blocks[0];
    const text = extractBlockText(block);
    assert.ok(text && text.trim().length > 0, 'fallback text must be non-empty');
});

test('unknown blocks require non-empty sourceType and visible text', () => {
    for (const fields of [{ sourceType: '', text: 'visible' }, { sourceType: 'widget', text: '' }]) {
        const bundle = unknownFx();
        Object.assign(bundle.conversation.messages[0].blocks[0], fields);
        assert.ok(errorsOf(validateBundle(bundle)).length > 0);
    }
});

// ------------------------------------------------------- message order round-trip
test('message order survives archive round-trip identically', () => {
    const bundle = rich();
    const roundTripped = JSON.parse(JSON.stringify(bundle));
    assert.deepStrictEqual(
        roundTripped.conversation.messages.map((m: any) => m.id),
        bundle.conversation.messages.map((m: any) => m.id),
    );
    assert.deepStrictEqual(errorsOf(validateBundle(roundTripped)), []);
    assert.deepStrictEqual(roundTripped.conversation.messages.map((m: any) => m.id), ['u1', 'a1', 'u2', 'a2']);
});

// ------------------------------------------------------------------ assets
test('pseudo-available asset is flagged, never trusted from metadata', () => {
    const bundle = rich();
    bundle.assets.push({ id: 'asset-ghost', kind: 'image', status: 'available' });
    const diags = validateBundle(bundle);
    const pseudo = diags.filter((d: any) => d.code === 'PSEUDO_AVAILABLE');
    assert.strictEqual(pseudo.length, 1);
    assert.strictEqual(pseudo[0].severity, 'warning');
    // With proven bytes, the same asset is clean.
    const clean = validateBundle(bundle, { knownByteAssetIds: new Set(['asset-ghost']) });
    assert.ok(!clean.some((d: any) => d.code === 'PSEUDO_AVAILABLE'));
});

test('classifyAssetAvailability downgrades pseudo-available to missing', () => {
    const asset = { id: 'a', kind: 'image', status: 'available' } as any;
    const classified = classifyAssetAvailability(asset, false);
    assert.strictEqual(classified.effectiveStatus, 'missing');
    assert.strictEqual(classified.pseudoAvailable, true);
    assert.ok(classified.diagnostic);
    const ok = classifyAssetAvailability(asset, true);
    assert.strictEqual(ok.effectiveStatus, 'available');
    assert.strictEqual(ok.pseudoAvailable, false);
});

test('resolveAssetBytes returns real bytes or an explicit missing state', async () => {
    const asset = { id: 'a', kind: 'image', status: 'available', storageRef: 'assets/a.png' } as any;
    const bytes = new Uint8Array([1, 2, 3]);
    const got = await resolveAssetBytes(asset, { getBytes: async () => bytes });
    assert.strictEqual(got.bytes, bytes);
    assert.strictEqual(got.effectiveStatus, 'available');
    assert.deepStrictEqual(got.diagnostics, []);

    const missing = await resolveAssetBytes(asset, { getBytes: async () => null });
    assert.strictEqual(missing.bytes, null);
    assert.strictEqual(missing.effectiveStatus, 'missing');
    assert.ok(missing.diagnostics.some((d: any) => d.code === 'PSEUDO_AVAILABLE'));

    const failing = await resolveAssetBytes(asset, {
        getBytes: async () => { throw new Error('boom'); },
    });
    assert.strictEqual(failing.bytes, null);
    assert.ok(failing.diagnostics.some((d: any) => d.code === 'ASSET_FETCH_ERROR'));
});

test('missing asset without failureReason is diagnosed', () => {
    const bundle = rich();
    bundle.assets.push({ id: 'asset-lost', kind: 'file', status: 'missing' });
    const codes = validateBundle(bundle).map((d: any) => d.code);
    assert.ok(codes.includes('ASSET_NO_REASON'));
});

// ------------------------------------------------------------- URL / paths
test('malicious link protocols are rejected', () => {
    const bundle = rich();
    bundle.conversation.messages[0].blocks.push({
        id: 'evil', type: 'paragraph',
        children: [{ type: 'link', href: 'javascript:alert(1)', children: [{ type: 'text', text: 'x' }] }],
    });
    const codes = validateBundle(bundle).map((d: any) => d.code);
    assert.ok(codes.includes('URL_UNSAFE_PROTOCOL'), `expected URL_UNSAFE_PROTOCOL in ${codes}`);
});

test('unsafe storageRef paths are rejected', () => {
    const bundle = rich();
    bundle.assets[0].storageRef = '../../etc/passwd';
    const codes = validateBundle(bundle).map((d: any) => d.code);
    assert.ok(codes.includes('ASSET_UNSAFE_PATH'), `expected ASSET_UNSAFE_PATH in ${codes}`);
    bundle.assets[0].storageRef = '/abs/path.png';
    const codes2 = validateBundle(bundle).map((d: any) => d.code);
    assert.ok(codes2.includes('ASSET_UNSAFE_PATH'));
});

// ----------------------------------------------------------------- limits
test('schema version and key violations are errors', () => {
    const badVersion = clone(rich());
    badVersion.schemaVersion = 2;
    assert.ok(validateBundle(badVersion).some((d: any) => d.code === 'SCHEMA_VERSION'));
    const badKey = clone(rich());
    delete badKey.conversation.key.conversationId;
    assert.ok(validateBundle(badKey).some((d: any) => d.code === 'KEY_BAD'));
});

test('oversized strings are rejected by the size guard', () => {
    const bundle = rich();
    bundle.conversation.messages[0].blocks.push({
        id: 'big', type: 'paragraph',
        children: [{ type: 'text', text: 'x'.repeat(11 * 1024 * 1024) }],
    });
    assert.ok(validateBundle(bundle).some((d: any) => d.code === 'LIMIT_STRING'));
});

test('renderer-only keys leaking into canonical data are flagged', () => {
    const bundle = rich();
    (bundle.conversation.messages[0].blocks[0] as any).bubbleWidth = 320;
    const leak = validateBundle(bundle).filter((d: any) => d.code === 'RENDERER_KEY_LEAK');
    assert.strictEqual(leak.length, 1);
    assert.strictEqual(leak[0].severity, 'warning');
});

test('missing accountId warns (F1 owns the value, F2a must not invent it)', () => {
    const bundle = rich();
    delete bundle.conversation.key.accountId;
    const diags = validateBundle(bundle);
    assert.ok(diags.some((d: any) => d.code === 'ACCOUNT_ID_PENDING_F1'));
    assert.ok(!errorsOf(diags).some((d: any) => d.code === 'ACCOUNT_ID_PENDING_F1'), 'must be a warning, not an error');
});


test('conversation title and URL validate their final canonical values', () => {
    for (const title of ['', '   ', null, 123, { value: 'old' }]) {
        const bundle = rich();
        bundle.conversation.title = title;
        assert.ok(validateBundle(bundle).some((d: any) => d.code === 'TITLE_INVALID'));
    }
    for (const url of ['', null, 123, '/relative', 'https://', 'javascript:alert(1)']) {
        const bundle = rich();
        bundle.conversation.url = url;
        assert.ok(validateBundle(bundle).some((d: any) => d.severity === 'error' && d.path === 'conversation.url'));
    }
    const bundle = rich();
    bundle.conversation.title = 'Final title';
    bundle.conversation.url = 'https://gemini.google.com/app/example';
    assert.deepStrictEqual(validateBundle(bundle).filter((d: any) => d.severity === 'error'), []);
});

test('final document schema contains only reachable definitions and closed document fields', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/core/export/canonical/resources/canonical-conversation-v1.schema.json'), 'utf8'));
    const reachable = new Set<string>();
    const refs = (value: any): void => {
        if (!value || typeof value !== 'object') return;
        if (typeof value.$ref === 'string') {
            const name = value.$ref.replace('#/$defs/', '');
            assert.ok(schema.$defs[name], `schema reference resolves: ${name}`);
            if (!reachable.has(name)) { reachable.add(name); refs(schema.$defs[name]); }
        }
        Object.values(value).forEach(refs);
    };
    refs(schema.properties);
    assert.deepStrictEqual([...reachable].sort(), Object.keys(schema.$defs).sort(), 'no unused document definitions');
    const keys = (value: any) => Object.keys(value.properties).sort();
    assert.deepStrictEqual(keys(schema), ['assets', 'citations', 'conversation', 'schemaVersion']);
    for (const [name, fields] of Object.entries({
        Conversation: ['key', 'title', 'url', 'createdAt', 'updatedAt', 'messages'],
        MessageNode: ['id', 'role', 'author', 'createdAt', 'blocks', 'citationIds'],
        InlineMath: ['type', 'source'],
        MathBlock: ['id', 'type', 'source'],
        UnknownBlock: ['id', 'type', 'sourceType', 'text'],
    })) {
        assert.deepStrictEqual(keys(schema.$defs[name]), fields.sort(), `final ${name} document shape`);
        assert.strictEqual(schema.$defs[name].additionalProperties, false);
    }
});
