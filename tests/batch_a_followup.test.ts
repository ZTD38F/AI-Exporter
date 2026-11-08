import { fixtureAccount } from './helpers/domainFixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiTakeoutConversation } from '../src/l1/parsers/gemini/takeout/parseConversation.js';
import { validateZipFile } from '../src/l1/parsers/shared/archive/zipBombGuard.js';

test('batch A acquisition rejects empty provider bytes instead of claiming success', async () => {
    const { acquireSourceResource } = require('../src/l1/resources/sourceResources.js');
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array());
    try {
        await assert.rejects(acquireSourceResource({ id: 'test-asset', kind: 'image', sourceUri: 'https://example.test/image.png' }), /Empty source resource/);
    } finally { globalThis.fetch = original; }
});

const takeoutHtml = `<div class="outer-cell"><a href="https://gemini.google.com/app/histimg01">Chat</a>
<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted Look <a href="cat.png">cat</a><br>
2026-09-02T12:00:00Z<br><p>A cat.</p></div></div>`;

test('batch A native Takeout keeps explicitly referenced user images as semantic assets', () => {
    const parsed = parseGeminiTakeoutConversation({
        htmlText: takeoutHtml, archiveFiles: { 'cat.png': { dir: false } }
    }, { account: fixtureAccount('gemini'), providerId: 'gemini' });
    const user = parsed.conversation.detail.messages[0];
    assert.equal(user.role, 'user');
    const asset = parsed.conversation.detail.assets[0];
    assert.deepEqual(user.attachmentIds, [asset!.id]);
    assert.equal(asset?.kind, 'image');
    assert.equal(asset?.name, 'cat.png');
    assert.equal(parsed.archiveResources[asset!.id].path, 'cat.png');
    assert.equal('localName' in asset!, false);
});

test('batch A native Takeout reports missing archive references without inventing a match', () => {
    const parsed = parseGeminiTakeoutConversation({ htmlText: takeoutHtml }, { account: fixtureAccount('gemini'), providerId: 'gemini' });
    assert.equal(parsed.conversation.detail.assets.length, 1);
    assert.ok(parsed.diagnostics.some(d => d.code === 'TAKEOUT_MISSING_RESOURCE'));
    assert.equal(Object.hasOwn(parsed.conversation.detail.assets[0], 'failureReason'), false);
    assert.deepEqual(parsed.archiveResources, {});
});

test('batch A ZipBombGuard preserves string length size semantics', () => {
    assert.doesNotThrow(() => validateZipFile('binary-string-input'));
});
