import { importTakeout } from '../src/l1/imports/takeout/importTakeout.js';
import { takeoutArchive } from './helpers/l1SourceFixture.js';
import { getDetail } from '../src/l3a/storageService.js';
import { decodeGeminiDetail } from '../src/l1/parsers/gemini/rpc/detailDecoder.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
import { deleteGen as geminiDeleteGen } from './fixtures/providers/geminiDelete.js';
import { requestGen as geminiListRequestGen } from './fixtures/providers/geminiListRequest.js';
import { deleteRequestGen as geminiDeleteRequestGen } from './fixtures/providers/geminiDeleteRequest.js';
// L1 regression locks. Other-layer scenarios remain in regression_lock_other_layers.test.ts
// and stay in ordinary repository discovery alongside this suite.
import { useIndexStorage } from './helpers/indexStorage.js';
import { accountRuntime, ACCOUNT_OBSERVATION, ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { listIndexes } from '../src/l3a/storageService.js';
import { createHookSandbox } from './helpers/hookSandbox.js';
import * as Extractors from '../src/l1/parsers/gemini/rpc/extractors.js';
import { isRealTitle } from '../src/l1/parsers/gemini/rpc/extractors.js';
import { extractImages } from './helpers/recordFixture/attachments.js';
import test from 'node:test';
import assert from 'node:assert/strict';
useIndexStorage();
test('hookCredentials - unrelated fetch and XHR traffic does not rescan account profiles', async () => {
    let scans = 0;
    const { posted, win, Xhr } = createHookSandbox(() => {
        scans++;
        return { gaiaId: '10000000001', email: 'alice@example.com' };
    });
    const initialScans = scans;
    assert.ok(initialScans > 0, 'startup discovery still runs independently of traffic');
    for (let i = 0; i < 20; i++) {
        await win.fetch(new Request(`https://gemini.google.com/assets/chunk-${i}.js`));
        const xhr = new Xhr();
        xhr.open('POST', 'https://gemini.google.com/telemetry');
        xhr.send('event=sample');
    }
    assert.equal(scans, initialScans, 'ordinary requests must add no account DOM scans');
    await win.fetch('https://gemini.google.com/batchexecute?at=token&f.sid=fetch-sid');
    assert.ok(scans > initialScans, 'batchexecute still refreshes the account');
    const afterFetch = scans;
    const xhr = new Xhr();
    xhr.open('POST', 'https://gemini.google.com/batchexecute?at=token&f.sid=xhr-sid');
    xhr.send();
    assert.ok(scans > afterFetch, 'batchexecute XHR still refreshes the account');
    const credentials = posted.filter(p => p.msg.type === 'GEMINI_CREDENTIALS');
    assert.deepEqual(credentials.map(p => p.msg.payload.sid), ['fetch-sid', 'xhr-sid']);
    for (const credential of credentials) {
        const observation = credential.msg.payload.accountObservation;
        assert.ok(observation && typeof observation === 'object' && 'providerAccountId' in observation);
        assert.equal(observation.providerAccountId, '10000000001');
    }
});

// ============================================================================
// Section 1: Behavioral Locks & End-to-End Export Finalize
// ============================================================================


test('p0-lock: deletion sniffing requires the exact request-bound acknowledgement and ignores decoys', async () => {
    const { posted, win } = createHookSandbox();
    const id = 'deadbeef00112233';
    const body = geminiDeleteRequestGen('G_REGRESSION_MIXED_DELETE_REQUEST_01');
    win.__nextResponseText = geminiDeleteGen('G_REGRESSION_LOCK_DELETE_RESPONSE_01');
    await win.fetch('https://gemini.google.com/u/0/batchexecute', { method: 'POST', body });
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    const deleted = posted.filter(p => p.msg.type === 'GEMINI_CONVERSATION_DELETED');
    assert.equal(deleted.length, 1); assert.equal(deleted[0].msg.payload.id, id);
    assert.equal(deleted[0].msg.payload.requestBody, body);
    assert.equal(deleted[0].msg.payload.responseText, win.__nextResponseText);
});
test('p0-lock: response-only ids, unacknowledged requests and unrelated hex values cannot authorize deletion', async () => {
    for (const [body, response] of [
        [geminiDeleteRequestGen('G_REGRESSION_DELETE_NO_ID_REQUEST_01'), geminiDeleteGen('G_REGRESSION_LOCK_DELETE_RESPONSE_02')],
        [geminiDeleteRequestGen('G_REGRESSION_DECOY_DELETE_REQUEST_01'), geminiDeleteGen('G_REGRESSION_EMPTY_DELETE_RESPONSE_01')],
        [geminiListRequestGen('G_REGRESSION_DECOY_LIST_REQUEST_01'), geminiListGen('G_REGRESSION_LOCK_DECOY_LIST_01')],
    ]) {
        const { posted, win } = createHookSandbox(); win.__nextResponseText = response;
        await win.fetch('https://gemini.google.com/u/0/batchexecute', { method: 'POST', body });
        await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
        assert.equal(posted.filter(p => p.msg.type === 'GEMINI_CONVERSATION_DELETED').length, 0);
    }
});

test('hookCredentials - broadcastBatchexecute filter only relays LIST and DETAIL payloads', async () => {
    // Drives the REAL filter inside hookCredentials (via the fetch-interception
    // sandbox), not a hand copy: batchexecute response text flows through the
    // actual broadcastBatchexecute, which only relays when the text mentions
    // the LIST or DETAIL RPC ids.
    const batchexecuteUrl = 'https://gemini.google.com/u/0/batchexecute';

    async function relayedTypesFor(responseText: string): Promise<string[]> {
        const { posted, win } = createHookSandbox();
        win.__nextResponseText = responseText;
        await win.fetch(batchexecuteUrl, { method: 'POST', body: geminiListRequestGen('G_HOOK_GENERIC_PROBE_REQUEST_01') });
        // The relay resolves in a few ms via the promise chain; 500ms is ample
        // margin without making negative cases (filtered out) slow.
        const deadline = Date.now() + 500;
        for (;;) {
            const types = posted.map((p: any) => p.msg.type);
            if (types.includes('GEMINI_NETWORK_BATCHEXECUTE') || Date.now() > deadline) return types;
            await new Promise(r => setTimeout(r, 10));
        }
    }
    async function wasRelayed(responseText: string): Promise<boolean> {
        return (await relayedTypesFor(responseText)).includes('GEMINI_NETWORK_BATCHEXECUTE');
    }

    const genericBatchexecute = geminiListGen('G_REGRESSION_GENERIC_DECOY_LIST_01');
    assert.strictEqual(await wasRelayed(genericBatchexecute), false, 'Generic wrb.fr response must be filtered out');

    const deleteBatchexecute = geminiDeleteGen('G_REGRESSION_LOCK_DELETE_RESPONSE_03');
    assert.strictEqual(await wasRelayed(deleteBatchexecute), false, 'Delete RPC response must not pass batchexecute broadcast');

    const listBatchexecute = geminiListGen('G_REGRESSION_LOCK_FILTER_LIST_01');
    assert.strictEqual(await wasRelayed(listBatchexecute), true, 'List RPC must pass filter');

    const detailBatchexecute = geminiDetailGen('G_REGRESSION_LOCK_FILTER_DETAIL_01');
    assert.strictEqual(await wasRelayed(detailBatchexecute), true, 'Detail RPC must pass filter');
});


test('hookCredentials - arbitrary Request-like objects are not treated as browser Requests', async () => {
    const { posted, win } = createHookSandbox();
    win.__nextResponseText = geminiListGen('G_REGRESSION_LOCK_REQUEST_LIST_01');

    // A standard browser Request object produces "[object Request]" from .toString().
    // The pre-refactor hook relied on (url || '').toString() and thus never recognized
    // Request instances as batchexecute or streaming endpoints.
    class MockRequest {
        url: string;
        body: any;
        constructor(url: string, init?: any) {
            this.url = url;
            this.body = init?.body;
        }
        toString() {
            return '[object Request]';
        }
    }

    const req = new MockRequest(
        'https://gemini.google.com/u/0/batchexecute?at=dummy_at&f.sid=dummy_sid',
        { body: geminiListRequestGen('G_HOOK_MALFORMED_LIST_REQUEST_01') }
    );

    await win.fetch(req as any, { method: 'POST', body: geminiListRequestGen('G_HOOK_MALFORMED_LIST_REQUEST_01') });
    await new Promise(r => setTimeout(r, 50));

    // Must not emit credentials, stream events, or relayed batchexecute payloads
    assert.strictEqual(posted.length, 0, 'Request object input must not be intercepted by (url || "").toString() logic');

    // In contrast, a direct string URL (or URL object) is recognized and intercepted
    await win.fetch('https://gemini.google.com/u/0/batchexecute?at=dummy_at&f.sid=dummy_sid', {
        method: 'POST',
        body: geminiListRequestGen('G_HOOK_MALFORMED_LIST_REQUEST_01')
    });
    await new Promise(r => setTimeout(r, 50));
    assert.ok(posted.length > 0, 'String URL must be recognized and intercepted');
    assert.ok(posted.some(p => p.msg.type === 'GEMINI_CREDENTIALS'), 'Credentials must be captured from string URL');
});


test('hookCredentials - real Request inputs preserve list cursor context', async () => {
    const { posted, win } = createHookSandbox();
    win.__nextResponseText = geminiListGen('G_REGRESSION_LOCK_CURSOR_LIST_01');
    const body = new URLSearchParams(geminiListRequestGen('G_HOOK_LIST_CURSOR_REQUEST_01'));
    await win.fetch(new Request('https://gemini.google.com/u/0/batchexecute', { method: 'POST', body }));
    await new Promise(r => setTimeout(r, 50));
    const relay = posted.find(p => p.msg.type === 'GEMINI_NETWORK_BATCHEXECUTE');
    assert.ok(relay);
    assert.deepEqual(JSON.parse(JSON.stringify(relay.msg.payload.listRequest)), { streamId: 'recent', requestCursor: 'cursor' });
    assert.equal(relay.msg.payload.truncated, false);
    assert.ok(typeof relay.msg.payload.requestedAt === 'number' && relay.msg.payload.requestedAt > 0);
});


test('hookCredentials - native fetch RequestInit body captures credentials', async () => {
    const { posted, win } = createHookSandbox();
    await win.fetch('https://gemini.google.com/u/0/batchexecute', {
        method: 'POST',
        body: geminiListRequestGen('G_HOOK_OVERRIDE_CREDENTIAL_REQUEST_01')
    });
    await new Promise(r => setTimeout(r, 20));

    const credentials = posted.filter(p => p.msg.type === 'GEMINI_CREDENTIALS');
    assert.equal(credentials.length, 1);
    assert.equal(credentials[0].msg.payload.at, 'override_at_token');
});


test('hookCredentials - credential token sources preserve URL, body, and encoded form precedence', async () => {
    const { posted, win } = createHookSandbox();
    const base = 'https://gemini.google.com/batchexecute?f.sid=token-sid';
    const cases: [string, string, string][] = [
        [base + '&at=url%20token', 'at=body_token', 'url token'],
        [base, 'request=1&at=body_token', 'body_token'],
        [base, 'a%74=form+token', 'form token'],
        [base, 'at=form+token', 'form token'],
        [base, 'at=literal%2Btoken', 'literal+token'],
        [base, 'at=literal%25token', 'literal%token'],
        [base, 'format=wrong&at=right', 'right'],
    ];
    for (const [url, body, expected] of cases) {
        posted.length = 0;
        await win.fetch(url, { method: 'POST', body });
        const credentials = posted.filter(p => p.msg.type === 'GEMINI_CREDENTIALS');
        assert.equal(credentials.length, 1);
        assert.equal(credentials[0].msg.payload.at, expected);
    }
});


// ============================================================================
// Section 3: API Parser, Title Extraction & Deduplication
// ============================================================================


test('audit fix: robustFirstPayload preserves , null , and control characters inside user content strings', () => {
    const testContent = 'Special test message with , null , in code and [brackets]';
    const text = geminiDetailGen('G_REGRESSION_LOCK_PARSER_DETAIL_01');
    const parsed = decodeGeminiDetail(text, 'testid1234567890ab');
    assert.ok(parsed, 'Detail should be parsed successfully');
    assert.ok(parsed.messages && parsed.messages.length > 0, 'Messages should be extracted');
    assert.strictEqual(parsed.messages[0].content, testContent, 'Message content should not be altered by regex replacements');
});


test('P2 regression: robustFirstPayload retains all 601 entries in a large multiline payload', () => {
    const lines = [")]}'", '['];
    for (let i = 0; i < 600; i++) {
        lines.push(`  ["turn_${i}", "user query with [nested bracket] ${i}", "response_${i}"],`);
    }
    lines.push('  ["final_turn", "query", "answer"]');
    lines.push(']');
    const payload = lines.join('\n');

    const result = Extractors.robustFirstPayload(payload);

    assert.ok(Array.isArray(result), 'Payload must parse to array');
    assert.strictEqual(result.length, 601, 'Must extract all 601 items');
});


test('P2 regression: robustFirstPayload handles strings containing brackets without corrupting structure', () => {
    const jsonStr = geminiListGen('G_REGRESSION_BRACKET_TITLE_LIST_01');
    const res = Extractors.robustFirstPayload(jsonStr);
    assert.ok(Array.isArray(res));
    assert.strictEqual(res.length, 1);
    assert.ok(Array.isArray(res[0]));
    assert.strictEqual(res[0][0], 'wrb.fr');
    assert.strictEqual(res[0][1], 'MaZiqc');
});


test('audit fix: isRealTitle fallback filters invalid titles properly', () => {
    assert.strictEqual(isRealTitle('Sign in with Google'), false, 'Sign in should be filtered');
    assert.strictEqual(isRealTitle('未命名对话(3)', 'c_123'), false, 'Numbered untitled should be filtered');
    assert.strictEqual(isRealTitle('搜索'), false, 'Search should be filtered');
    assert.strictEqual(isRealTitle('Valid Chat Title 2026', 'c_123'), true, 'Real title should be accepted');
});


test('regression: gemini_parser image naming must be globally unique across turns', () => {
    const seq = { value: 1 };
    const imgObj1 = ['https://lh3.googleusercontent.com/a1b2c3d4', 100, 200];
    const imgObj2 = ['https://lh3.googleusercontent.com/e5f6g7h8', 300, 400];
    const res1 = extractImages([imgObj1], seq);
    const res2 = extractImages([imgObj2], seq);
    assert.strictEqual(res1.length, 1);
    assert.strictEqual(res2.length, 1);
    assert.notStrictEqual(res1[0].fileName, res2[0].fileName, `fileName should be unique, got both ${res1[0].fileName}`);
    assert.ok(res2[0].fileName);
    assert.ok(res2[0].fileName.includes('image-2') || res2[0].fileName.includes('image-1') === false, 'second image should have incremented counter');
    const seq2 = { value: 1 };
    extractImages([imgObj1], seq2);
    const r2 = extractImages([imgObj1, imgObj2], seq2);
    assert.strictEqual(r2.length, 2);
});

// ============================================================================
// Section 4: Storage, Tabs & Slot Isolation
// ============================================================================


test('passive RPC lists bind captured UUID independently of the routing slot', async () => {
    const runtime = accountRuntime();
    try {
        const bridge = require('../src/l1/sniffer/gemini/messageBridge.js'); bridge.init();
        const text = geminiListGen('G_REGRESSION_SLOT_ISOLATION_LIST_01');
        for (const slot of ['u1','u0']) await bridge.handleWindowMessage({ origin: location.origin, source: window,
            data: { type: 'GEMINI_NETWORK_BATCHEXECUTE', payload: { text, slot, requestAccountObservation: ACCOUNT_OBSERVATION,
                requestedAt: Date.now(), truncated: false, url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute' } } });
        const rows = await listIndexes(ACCOUNT_UUID); assert.equal(rows.length, 1);
        assert.equal(rows[0].key.accountId, ACCOUNT_UUID);
    } finally { runtime.restore(); }
});

test('Takeout later meaningful title replaces a placeholder through current L1 import and L2 admission', async () => {
    const html = `<html><body>
      <div class="outer-cell">
        <a href="https://gemini.google.com/app/BUG_REPRO_001">Link1</a>
        <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Takeout conversation<br><p>model response 1</p></div>
      </div>
      <div class="outer-cell">
        <a href="https://gemini.google.com/app/BUG_REPRO_001">Link2</a>
        <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Corrected Title<br><p>model response 2</p></div>
      </div>
    </body></html>`;
    const result = await importTakeout(takeoutArchive(html), ACCOUNT_UUID);
    assert.equal(result.imported, 1);
    const indexes = await listIndexes(ACCOUNT_UUID);
    assert.equal(indexes.length, 1);
    assert.equal(indexes[0].title, 'Corrected Title');
    assert.equal(indexes[0].titleSource, 'derived');
    const detail = await getDetail({ accountId: ACCOUNT_UUID, conversationId: 'BUG_REPRO_001' });
    assert.ok(detail);
    const persisted = JSON.stringify(detail.messages);
    assert.ok(persisted.includes('model response 1'));
    assert.ok(persisted.includes('model response 2'));
});


test('hookCredentials - fetch and XHR canonicalize URLSearchParams before credential extraction', async () => {
    const { posted, win, Xhr } = createHookSandbox();
    const url = 'https://gemini.google.com/batchexecute?f.sid=form-sid';
    for (const body of ['at=form%20token', new URLSearchParams({ at: 'form token' })]) {
        posted.length = 0;
        await win.fetch(url, { method: 'POST', body });
        const fetchCredentials = posted.filter(p => p.msg.type === 'GEMINI_CREDENTIALS');
        assert.equal(fetchCredentials.length, 1);
        assert.equal(fetchCredentials[0].msg.payload.at, 'form token');
        assert.equal(fetchCredentials[0].msg.payload.sid, 'form-sid');
        posted.length = 0;
        const xhr = new Xhr();
        xhr.open('POST', url);
        xhr.send(body);
        const xhrCredentials = posted.filter(p => p.msg.type === 'GEMINI_CREDENTIALS');
        assert.equal(xhrCredentials.length, 1);
        assert.equal(xhrCredentials[0].msg.payload.at, 'form token');
        assert.equal(xhrCredentials[0].msg.payload.sid, 'form-sid');
    }
});


test('hookCredentials - credential-shaped text inside another form field is not an AT source', async () => {
    const { posted, win, Xhr } = createHookSandbox();
    const url = 'https://gemini.google.com/batchexecute';
    for (const body of ['f.req=at=not-a-token', 'format=not-a-token',
        new URLSearchParams({ 'f.req': 'at=not-a-token' })]) {
        posted.length = 0;
        await win.fetch(url, { method: 'POST', body });
        const xhr = new Xhr();
        xhr.open('POST', url);
        xhr.send(body);
        assert.equal(posted.some(p => p.msg.type === 'GEMINI_CREDENTIALS'), false);
    }
});
