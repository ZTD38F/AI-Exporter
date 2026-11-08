import { fixtureAccount } from './helpers/domainFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { mergeConversationPages } from '../src/l1/parsers/gemini/rpc/mergePages.js';
import { getConversationDetail } from '../src/l1/client/gemini/api/pagination.js';
import { assertDomainClosure } from '../src/l2/closure.js';
import { textOfBlock } from './helpers/contentText.js';
import type { SourceConversationParseResult } from '../src/l1/parsers/parsingResult.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
function page(key: Parameters<typeof geminiDetailGen>[0]) {
    return parseGeminiRpcConversation(geminiDetailGen(key), {
        account: fixtureAccount('gemini'), providerId: 'gemini', targetConvId: 'native',
    });
}
const activity = (prompt: string) => `<div class="outer-cell"><a href="https://gemini.google.com/app/c_native">Chat</a><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted ${prompt}<br>2026-09-02T12:00:00Z<br><p>Answer</p></div></div>`;
const result = (uri?: string, messageId = 'm1', timestamp = 1): SourceConversationParseResult => ({
    conversationId: 'native', sourceVersion: timestamp,
    conversation: { index: { title: 'Title' }, detail: { quality: { status: 'unknown' },
        messages: [{ id: messageId, role: 'assistant', timestamp, content: [{ type: 'paragraph', children: [{ type: 'image', assetId: 'image' }] }], attachmentIds: ['image'] }],
        assets: [{ id: 'image', kind: 'image', name: 'photo.png', ...(uri ? { sourceUri: uri } : {}) }] } },
    diagnostics: [], acquisitionHints: {},
});

test('production pagination merges native pages chronologically and closes renamed resources', async () => {
    const pages = [page('G_NATIVE_ACQ_MIXED_01'), page('G_NATIVE_ACQ_MIXED_02')];
    let index = 0;
    const detail = await getConversationDetail({ async fetchConversationPage() { return pages[index++]; } }, 'native');
    const native = detail;
    assert.equal(index, 2);
    assert.deepEqual(native.conversation.detail.messages.filter(m => m.role === 'user').map(m => textOfBlock(m.content[0])), ['Question r_old', 'Question r_new']);
    assert.equal(native.conversation.index.createdAt, undefined);
    assert.equal(detail.conversation.index.createdAt, native.conversation.index.createdAt);
    assert.equal(detail.sourceVersion, 1700000010000);
    assertDomainClosure((native.conversation).detail);
    const merged = mergeConversationPages([result('https://example.test/new.png', 'new', 20), result('https://example.test/old.png', 'old', 10)]);
    assert.deepEqual(merged.conversation.detail.messages.map(m => m.attachmentIds), [['image_page1'], ['image']]);
    assert.equal(merged.conversation.detail.assets.length, 2);
    assertDomainClosure((merged.conversation).detail);
});


test('page merge dedupes stable messages and shared source images without collapsing anonymous assets', () => {
    const same = result('https://example.test/shared.png');
    const merged = mergeConversationPages([same, structuredClone(same)]);
    assert.equal(merged.conversation.detail.messages.length, 1);
    assert.equal(merged.conversation.detail.assets.length, 1);
    const anonymous = mergeConversationPages([result(undefined, 'new'), result(undefined, 'old')]);
    assert.equal(anonymous.conversation.detail.assets.length, 2);
    assert.throws(() => mergeConversationPages([same, { ...same, conversationId: 'other' }]), /different conversations/);
});


test('native token loops retain diagnostics and explicitly mark incomplete coverage', async () => {
    const view = page('G_NATIVE_ACQ_MIXED_03');
    const detail = await getConversationDetail({ async fetchConversationPage() { return view; } }, 'native');
    assert.equal(detail.evidence?.truncation, 'token_loop');
    assert.equal(detail.conversation.detail.messages.length, 2);
    assert.equal(detail.conversation.detail.quality.status, 'partial');
    assert.ok(detail.diagnostics.some(d => d.code === 'GEMINI_PAGINATION_TRUNCATED'));
});


test('production RPC client parses raw responses without invoking the legacy detail facade', async () => {
    const credentials = require('../src/l1/client/gemini/api/credentialManager.js') as typeof import('../src/l1/client/gemini/api/credentialManager.js');
    const transport = require('../src/l1/client/gemini/api/rpcClient.js') as typeof import('../src/l1/client/gemini/api/rpcClient.js');
    const originalCred = credentials.resolveCred, originalPost = transport.postBatchexecute;
    credentials.resolveCred = async () => ({ at: 'test', bl: 'test', accountSlot: 'u0', fSid: 'test' });
    transport.postBatchexecute = async () => new Response(geminiDetailGen('G_NATIVE_ACQ_01'));
    try {
        const { GeminiAPIClient } = require('../src/l1/client/gemini/geminiClient.js') as typeof import('../src/l1/client/gemini/geminiClient.js');
        const detail = await new GeminiAPIClient().fetchConversationPage('native', null, 'u0');
        assert.equal(detail.conversation.index.title, 'Native title');
        assert.equal(detail.conversation.detail.messages.length, 2);
        assert.equal(Reflect.get(detail.conversation.detail.messages[0], 'provenance'), undefined);
    } finally { credentials.resolveCred = originalCred; transport.postBatchexecute = originalPost; }
});


test('native pagination rejects mixed legacy message pages instead of dropping their bodies', async () => {
    const native = page('G_NATIVE_ACQ_MIXED_04');
    const legacy = { id: 'native', messages: [{ role: 'model', content: 'old' }] };
    let index = 0;
    await assert.rejects(getConversationDetail({ async fetchConversationPage() { return [native, legacy][index++] as never; } }, 'native'), TypeError);
});



test('metadata-only detail retry follows native pagination to its terminal page', async () => {
    const calls: Array<{ token?: string | null; detailOnly?: boolean }> = [];
    const empty = parseGeminiRpcConversation(geminiDetailGen('G_NATIVE_ACQ_02'), { account: fixtureAccount('gemini'), providerId: 'gemini', targetConvId: 'native' });
    const detail = await getConversationDetail({ async fetchConversationPage(_id, token, _sid, options) {
        calls.push({ token, detailOnly: options?.detailOnly });
        if (!options?.detailOnly) return empty;
        return token ? page('G_NATIVE_ACQ_MIXED_05') : page('G_NATIVE_ACQ_MIXED_06');
    } }, 'native');
    assert.equal(calls.length, 3);
    assert.equal(calls[2].token, 'tC_retry_older');
    assert.equal(calls[2].detailOnly, true);
    assert.equal(detail.conversation.detail.messages.length, 4);
    assert.equal(Boolean(detail.evidence?.truncation), false);
});


test('an explicit empty native Detail turn array remains a valid source result', async () => {
    const empty = parseGeminiRpcConversation(geminiDetailGen('G_NATIVE_ACQ_03'), {
        account: fixtureAccount('gemini'), providerId: 'gemini', targetConvId: 'native',
    });
    const result = await getConversationDetail({
        async fetchConversationPage() { return empty; },
    }, 'native');
    assert.equal(result.conversationId, 'native');
    assert.deepEqual(result.conversation.detail.messages, []);
    assert.equal(result.conversation.detail.quality.status, 'unknown');
});

test('metadata-only retry accepts a native explicit empty Detail without using stale metadata transport', async () => {
    const metadata = parseGeminiRpcConversation(geminiDetailGen('G_NATIVE_ACQ_04'), {
        account: fixtureAccount('gemini'), providerId: 'gemini', targetConvId: 'native',
    });
    const emptyBody = [[], null, 'Verified empty conversation'];
    const verified = parseGeminiRpcConversation(geminiDetailGen('G_NATIVE_ACQ_05'), {
        account: fixtureAccount('gemini'), providerId: 'gemini', targetConvId: 'native',
    });
    const calls: Array<{ detailOnly?: boolean; altParams?: boolean }> = [];
    const result = await getConversationDetail({
        async fetchConversationPage(_id, _token, _sid, options) {
            calls.push({ detailOnly: options?.detailOnly, altParams: options?.altParams });
            return options?.detailOnly ? verified : metadata;
        },
    }, 'native');
    assert.deepEqual(calls, [
        { detailOnly: undefined, altParams: undefined },
        { detailOnly: true, altParams: true },
    ]);
    assert.deepEqual(result.conversation.detail.messages, []);
    assert.equal(result.conversation.detail.quality.status, 'unknown');
    assert.deepEqual(result.transport.decodedPayload, emptyBody);
});

test('native metadata-only Detail cannot succeed when its alternate also has no turns', async () => {
    const metadata = parseGeminiRpcConversation(geminiDetailGen('G_NATIVE_ACQ_06'), {
        account: fixtureAccount('gemini'), providerId: 'gemini', targetConvId: 'native',
    });
    let calls = 0;
    await assert.rejects(getConversationDetail({
        async fetchConversationPage() { calls++; return metadata; },
    }, 'native'), /GEMINI_DETAIL_EMPTY_UNVERIFIED/);
    assert.equal(calls, 2);
});


test('cooperative ZIP decoding yields to the event loop and preserves synchronous HTML semantics', async () => {
    const { parseGeminiTakeoutArchive, parseGeminiTakeoutArchiveAsync } = require('../src/l1/parsers/gemini/takeout/parseConversation.js') as typeof import('../src/l1/parsers/gemini/takeout/parseConversation.js');
    const raw = { htmlText: Array.from({ length: 120 }, (_, index) => activity(`Question ${index}`)).join('') };
    let yielded = false;
    const timer = setTimeout(() => { yielded = true; }, 0);
    const progress: number[][] = [];
    try {
        const asyncResults = await parseGeminiTakeoutArchiveAsync(raw, { account: fixtureAccount('gemini'), providerId: 'gemini' }, (completed, total) => progress.push([completed, total]));
        assert.equal(yielded, true);
        assert.ok(progress.some(([completed, total]) => completed === 100 && total === 120));
        assert.deepEqual(asyncResults, parseGeminiTakeoutArchive(raw, { account: fixtureAccount('gemini'), providerId: 'gemini' }));
        assert.equal(asyncResults[0].conversation.detail.messages.length, 240);
    } finally { clearTimeout(timer); }
});



test('Takeout prompt-cell attachments and audio stay user-owned while response references remain assistant-owned', () => {
    const { parseGeminiTakeoutArchive } = require('../src/l1/parsers/gemini/takeout/parseConversation.js') as typeof import('../src/l1/parsers/gemini/takeout/parseConversation.js');
    const htmlText = `<div class="outer-cell"><a href="https://gemini.google.com/app/c_native">Chat</a><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted Read files<br>Attached 1 file.<br><a href="same.png">Image</a><br><a href="recording.wav">Audio</a><br>2026-09-02T12:00:00Z<br><p>Answer <img src="same.png"></p></div><div class="content-cell mdl-typography--text-right"><img src="same.png" class="image-preview"></div><img src="unowned.png"></div>`;
    const result = parseGeminiTakeoutArchive({ htmlText, archiveFiles: { 'same.png': {}, 'recording.wav': {}, 'unowned.png': {} } }, { account: fixtureAccount('gemini'), providerId: 'gemini' })[0];
    const assets = new Map(result.conversation.detail.assets.map(asset => [asset.id, asset]));
    assert.deepEqual(result.conversation.detail.messages[0].attachmentIds!.map(id => assets.get(id)!.kind), ['image', 'audio']);
    assert.deepEqual(result.conversation.detail.messages[1].attachmentIds!.map(id => assets.get(id)!.name), ['same.png']);
    assert.equal(result.conversation.detail.messages[0].attachmentIds![0], result.conversation.detail.messages[1].attachmentIds![0]);
    assert.equal(result.diagnostics.filter(d => d.code === 'TAKEOUT_UNBOUND_RESOURCE').length, 1);
    assertDomainClosure((result.conversation).detail);
});



test('metadata-only retry cannot hide a subsequent detail-page fetch failure', async () => {
    const empty = parseGeminiRpcConversation(geminiDetailGen('G_NATIVE_ACQ_07'), { account: fixtureAccount('gemini'), providerId: 'gemini', targetConvId: 'native' });
    await assert.rejects(getConversationDetail({ async fetchConversationPage(_id, token, _sid, options) {
        if (!options?.detailOnly) return empty;
        if (token) throw new Error('Interrupted detail chain');
        return page('G_NATIVE_ACQ_MIXED_07');
    } }, 'native'), /Interrupted detail chain/);
});
